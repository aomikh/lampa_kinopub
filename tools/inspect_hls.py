#!/usr/bin/env python3
"""Inspect audio groups in one master, without fetching video or audio segments.

python3 tools/inspect_hls.py --file tests/fixtures/kinopub-hls4-master.redacted.m3u8
python3 tools/inspect_hls.py < /private/current-master-url.txt
The fresh authorized URL is read from stdin, never from command arguments.
No URLs, request credentials, keys or source lines appear in the output.
This does not test the native shell or inspect tracks inside a media file.
"""
import argparse
import json
from pathlib import Path
import re
import signal
import sys
import urllib.error
import urllib.parse
import urllib.request

LIMIT = 128 * 1024
SECONDS = 15
ATTR = re.compile(r'([A-Z0-9-]+)=("[^"\r\n]*"|[^,"\r\n]*)(?:,|$)')


def attributes(text):
    result, offset = {}, 0
    for match in ATTR.finditer(text):
        if match.start() != offset or match.group(1) in result:
            raise ValueError('invalid-attributes')
        result[match.group(1)] = match.group(2).strip('"')
        offset = match.end()
    if offset != len(text) or not result:
        raise ValueError('invalid-attributes')
    return result


def inspect(data):
    if len(data) > LIMIT:
        raise ValueError('manifest-too-large')
    lines = data.decode('utf-8-sig').strip().splitlines()
    if not lines or lines[0].strip() != '#EXTM3U':
        raise ValueError('not-hls')
    audio, variants, pending = [], [], None
    media = False
    for raw in lines[1:]:
        line = raw.strip()
        if line.startswith('#EXT-X-MEDIA:'):
            attrs = attributes(line.split(':', 1)[1])
            if attrs.get('TYPE') == 'AUDIO':
                audio.append({'group': attrs.get('GROUP-ID'), 'name': attrs.get('NAME'),
                              'language': attrs.get('LANGUAGE'), 'channels': attrs.get('CHANNELS'),
                              'default': attrs.get('DEFAULT') == 'YES',
                              'autoselect': attrs.get('AUTOSELECT') == 'YES',
                              'uri_present': bool(attrs.get('URI'))})
        elif line.startswith('#EXT-X-STREAM-INF:'):
            if pending is not None:
                raise ValueError('missing-variant-uri')
            pending = attributes(line.split(':', 1)[1])
        elif line.startswith('#EXTINF:') or line.startswith('#EXT-X-TARGETDURATION:'):
            media = True
        elif line and not line.startswith('#') and pending is not None:
            group = pending.get('AUDIO')
            count = sum(a['group'] == group for a in audio) if group else None
            variants.append({'resolution': pending.get('RESOLUTION'),
                             'bandwidth': pending.get('BANDWIDTH'), 'codecs': pending.get('CODECS'),
                             'video_range': pending.get('VIDEO-RANGE'),
                             'audio_group': group, 'subtitles_group': pending.get('SUBTITLES'),
                             'audio_count': count, 'audio_group_exists': bool(count) if group else None})
            pending = None
    if pending is not None:
        raise ValueError('missing-variant-uri')
    # MEDIA tags may legally occur after STREAM-INF. Resolve groups after
    # parsing the complete manifest rather than guessing track order.
    for variant in variants:
        group = variant['audio_group']
        if group:
            variant['audio_count'] = sum(a['group'] == group for a in audio)
            variant['audio_group_exists'] = variant['audio_count'] > 0
    return {'kind': 'master' if variants else 'media' if media else 'unknown',
            'audio': audio, 'variants': variants, 'embedded_tracks': 'not-inspected',
            'native_playback_tested': False}


def permitted(url):
    parsed = urllib.parse.urlsplit(url)
    return (parsed.scheme in ('http', 'https') and bool(parsed.hostname)
            and not parsed.username and not parsed.password)


class Redirects(urllib.request.HTTPRedirectHandler):
    def __init__(self):
        self.count = 0

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        self.count += 1
        if self.count > 3 or not permitted(newurl):
            raise ValueError('redirect-rejected')
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def fetch(url):
    response = None
    result = {'bytes_read': 0, 'segments_requested': 0, 'native_playback_tested': False}
    try:
        if not permitted(url):
            raise ValueError('invalid-resource')
        opener = urllib.request.build_opener(Redirects())
        request = urllib.request.Request(url, headers={
            'User-Agent': 'Lampa-KP-master-diagnostic/1', 'Accept-Encoding': 'identity'})
        try:
            response = opener.open(request, timeout=4)
        except urllib.error.HTTPError as err:
            response = err
        result['status'] = response.status
        if response.status != 200:
            return result
        if response.headers.get('Content-Encoding', 'identity').lower() != 'identity':
            result['error'] = 'encoded-response'
            return result
        length = response.headers.get('Content-Length')
        if length and length.isdigit() and int(length) > LIMIT:
            result['error'] = 'manifest-too-large'
            return result
        data = response.read(LIMIT + 1)
        result['bytes_read'] = len(data)
        result['manifest'] = inspect(data)
    except ValueError as err:
        result['error'] = str(err) if str(err) in (
            'manifest-too-large', 'not-hls', 'invalid-attributes', 'missing-variant-uri',
            'invalid-resource', 'redirect-rejected') else 'invalid-manifest'
    except (OSError, TimeoutError):
        result['error'] = 'network-or-timeout'
    finally:
        if response is not None:
            response.close()
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--file', type=Path, help='Inspect a local manifest instead of a URL from stdin')
    args = parser.parse_args()
    def timeout(*_):
        raise TimeoutError()
    signal.signal(signal.SIGALRM, timeout)
    signal.setitimer(signal.ITIMER_REAL, SECONDS)
    try:
        if args.file:
            with args.file.open('rb') as stream:
                result = {'source': 'local-file', 'manifest': inspect(stream.read(LIMIT + 1))}
        else:
            result = fetch(sys.stdin.readline(16384).strip())
    except (OSError, ValueError):
        result = {'error': 'invalid-file-or-timeout'}
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
    print(json.dumps({'read_limit_bytes': LIMIT + 1, 'wall_clock_limit_seconds': SECONDS,
                      'result': result}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
