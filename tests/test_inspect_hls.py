import importlib.util
import json
from pathlib import Path
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('inspect_hls', ROOT / 'tools/inspect_hls.py')
hls = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hls)
FIXTURE = (ROOT / 'tests/fixtures/kinopub-hls4-master.redacted.m3u8').read_bytes()


class ManifestTests(unittest.TestCase):
    def test_real_redacted_master_has_groups_not_eighteen_tracks_per_quality(self):
        result = hls.inspect(FIXTURE)
        self.assertEqual(result['kind'], 'master')
        self.assertEqual(len(result['audio']), 18)
        self.assertEqual(len(result['variants']), 3)
        self.assertTrue(all(v['audio_count'] == 6 for v in result['variants']))
        self.assertTrue(all(v['audio_group_exists'] for v in result['variants']))
        self.assertEqual({a['language'] for a in result['audio']}, {'rus', 'eng'})
        self.assertTrue(all(a['uri_present'] for a in result['audio']))
        self.assertNotIn('https://', json.dumps(result))

    def test_names_with_commas_and_in_band_audio_are_not_split_or_hidden(self):
        result = hls.inspect(b'#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Studio A, stereo",LANGUAGE="rus"\n#EXT-X-STREAM-INF:BANDWIDTH=1000,AUDIO="a"\nvideo.m3u8\n')
        self.assertEqual(result['audio'][0]['name'], 'Studio A, stereo')
        self.assertFalse(result['audio'][0]['uri_present'])
        self.assertEqual(result['variants'][0]['audio_count'], 1)

    def test_media_playlist_does_not_claim_to_prove_one_audio_track(self):
        result = hls.inspect(b'#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nsegment.ts\n')
        self.assertEqual(result['kind'], 'media')
        self.assertEqual(result['embedded_tracks'], 'not-inspected')

    def test_unknown_group_and_missing_variant_uri_are_reported(self):
        result = hls.inspect(b'#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000,AUDIO="absent"\nvideo.m3u8\n')
        self.assertFalse(result['variants'][0]['audio_group_exists'])
        with self.assertRaises(ValueError):
            hls.inspect(b'#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\n')

    def test_malformed_and_oversized_input_never_become_a_confirmed_master(self):
        for data in (b'<html>secret</html>', b'#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,NAME="unterminated\n', b'#EXTM3U\n' + b'x' * hls.LIMIT):
            with self.assertRaises(ValueError):
                hls.inspect(data)

    def test_bounded_get_reads_only_the_master_and_redacts_its_address(self):
        requested = []
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                requested.append(self.path.split('?')[0])
                if self.path.startswith('/denied'):
                    self.send_response(403)
                    self.end_headers()
                    return
                body = FIXTURE if self.path.startswith('/master') else b'x' * (hls.LIMIT + 100)
                self.send_response(200)
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            def log_message(self, *_):
                pass
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            base = 'http://127.0.0.1:' + str(server.server_port)
            result = hls.fetch(base + '/master?secret=never-log')
            self.assertEqual(result['status'], 200)
            self.assertEqual(result['manifest']['kind'], 'master')
            self.assertNotIn('never-log', json.dumps(result))
            self.assertEqual(requested, ['/master'])
            self.assertEqual(hls.fetch(base + '/denied')['status'], 403)
            self.assertEqual(hls.fetch(base + '/large')['error'], 'manifest-too-large')
        finally:
            server.shutdown()
            server.server_close()


if __name__ == '__main__':
    unittest.main()
