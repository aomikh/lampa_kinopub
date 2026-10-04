"""Local HTTP fixture only: no KinoPub credentials or remote film downloads."""
import importlib.util
import json
import pathlib
import signal
import subprocess
import sys
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("probe_media", ROOT / "tools/probe_media.py")
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)
SIZE = 300000000


class Handler(BaseHTTPRequestHandler):
    seen = []

    def log_message(self, *_):
        pass

    def do_HEAD(self):
        self.handle_request(True)

    def do_GET(self):
        self.handle_request(False)

    def handle_request(self, head):
        path = self.path.split("?")[0]
        self.seen.append((path, self.command, dict(self.headers)))
        if path in ("/redirect", "/redirect-other", "/loop"):
            self.send_response(302)
            target = "/loop" if path == "/loop" else "/ok/private-secret?sig=a%2Bb+%3D"
            if path == "/redirect-other":
                target = "http://localhost:" + str(self.server.server_port) + target
            self.send_header("Location", target)
            self.end_headers()
            return
        if path in ("/expired", "/auth"):
            self.send_response(410 if path == "/expired" else 403)
            self.end_headers()
            return
        request = self.headers.get("Range")
        start, end = 0, SIZE - 1
        if request:
            a, b = request[6:].split("-")
            if not a:
                start = max(0, SIZE - int(b))
            else:
                start, end = int(a), min(int(b), SIZE - 1) if b else SIZE - 1
        status = 200 if head or path == "/ignore" or (path == "/nonzero-fail" and start > 0) else 206
        if self.headers.get("If-Range") == '"old-fixture"':
            status = 200
        if not head and (path == "/rejected" or start >= SIZE):
            self.send_response(416)
            self.send_header("Content-Range", "bytes */" + str(SIZE))
            self.end_headers()
            return
        self.send_response(status)
        self.send_header("Content-Type", "video/mp4")
        self.send_header("Content-Length", str(SIZE if status == 200 else end - start + 1))
        if status == 206:
            self.send_header("Content-Range", f"bytes {0 if path == '/wrong' else start}-{end}/{SIZE}")
        if path == "/encoded":
            self.send_header("Content-Encoding", "gzip")
        self.end_headers()
        if not head:
            if path == "/stall":
                time.sleep(0.2)
            try:
                # Even the fake 300 MB open-ended representation sends <=1 KiB.
                self.wfile.write(b"x" * (12 if path == "/truncated" else 1024))
            except (BrokenPipeError, ConnectionResetError):
                pass


class ProbeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = "http://127.0.0.1:" + str(cls.server.server_port)

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def one(self, path, request, **kwargs):
        return probe.probe(self.base + path, "GET", request, SIZE, time.monotonic() + 2, **kwargs)

    def test_all_ranges_and_error_offset_have_strict_read_caps(self):
        report = probe.inspect_resource(self.base + "/ok", offset=205444144)
        checks = report["checks"]
        self.assertEqual([r["requested"] for r in checks[1:]],
                         ["bytes=0-1023", "bytes=205444144-205445167", "bytes=205444144-", "bytes=-1024"])
        self.assertEqual(report["bytes_read_total"], 4096)
        for r in checks[1:]:
            self.assertEqual(r["verdict"], "headers-match")
            self.assertTrue(r["sample_complete"])
            self.assertLessEqual(r["bytes_read"], 1024)

    def test_another_file_uses_midpoint_and_invalid_offset_is_not_queried(self):
        self.assertEqual(probe.inspect_resource(self.base + "/ok")["checks"][2]["requested"], "bytes=150000000-150001023")
        report = probe.inspect_resource(self.base + "/ok", offset=SIZE)
        self.assertEqual(len(report["checks"]), 3)
        self.assertIn("outside", report["offset_note"])

    def test_start_passes_while_nonzero_200_is_aborted_without_reading(self):
        checks = probe.inspect_resource(self.base + "/nonzero-fail")["checks"]
        self.assertEqual(checks[1]["bytes_read"], 1024)
        for r in checks[2:]:
            self.assertEqual(r["verdict"], "range-ignored")
            self.assertEqual(r["bytes_read"], 0)

    def test_invalid_206_is_not_read(self):
        r = self.one("/wrong", {"start": 2000, "end": 3023})
        self.assertEqual(r["verdict"], "invalid-range")
        self.assertEqual(r["bytes_read"], 0)

    def test_valid_and_invalid_416(self):
        self.assertEqual(self.one("/rejected", {"start": 2000, "end": 3023})["verdict"], "rejected-range")
        self.assertEqual(self.one("/ok", {"start": SIZE, "end": SIZE + 1023})["verdict"], "unsatisfiable")

    def test_redirect_forwards_range_not_auth_and_redacts_paths(self):
        Handler.seen.clear()
        r = self.one("/redirect", {"start": 205444144, "end": 205445167})
        self.assertEqual(r["verdict"], "headers-match")
        self.assertTrue(r["redirects"][0]["range_forwarded"])
        self.assertEqual(Handler.seen[-1][2]["Range"], "bytes=205444144-205445167")
        self.assertNotIn("Authorization", Handler.seen[-1][2])
        self.assertNotIn("Cookie", Handler.seen[-1][2])
        self.assertNotRegex(json.dumps(r), "private-secret|sig=|a%2B")

    def test_redirect_loop_is_bounded(self):
        r = self.one("/loop", {"start": 2000, "end": 3023})
        self.assertEqual(len(r["redirects"]), 3)
        self.assertEqual(r["bytes_read"], 0)
        self.assertEqual(r["error"], "network-or-invalid-response")

    def test_cross_origin_redirect_keeps_range_without_adding_credentials(self):
        r = self.one("/redirect-other", {"start": 205444144, "end": 205445167})
        self.assertEqual(r["verdict"], "headers-match")
        self.assertEqual(r["final"]["host"], "localhost")
        self.assertNotIn("Authorization", Handler.seen[-1][2])
        self.assertNotIn("Cookie", Handler.seen[-1][2])
        self.assertEqual(Handler.seen[-1][2]["Range"], "bytes=205444144-205445167")

    def test_auth_and_expiry_stop_without_retry(self):
        for path in ("/auth", "/expired"):
            self.assertEqual(len(probe.inspect_resource(self.base + path)["checks"]), 1)

    def test_if_range_can_legitimately_produce_200_and_is_a_separate_comparison(self):
        request = {"start": 2000, "end": 3023}
        self.assertEqual(self.one("/ok", request)["verdict"], "headers-match")
        r = self.one("/ok", request, if_range='"old-fixture"')
        self.assertEqual(r["verdict"], "range-ignored")
        self.assertEqual(r["bytes_read"], 0)
        self.assertNotIn("old-fixture", json.dumps(r))

    def test_truncated_sample_and_encoding_are_not_full_success(self):
        r = self.one("/truncated", {"start": 2000, "end": 3023})
        self.assertFalse(r["sample_complete"])
        self.assertEqual(r["bytes_read"], 12)
        r = self.one("/encoded", {"start": 2000, "end": 3023})
        self.assertEqual(r["bytes_read"], 0)
        self.assertFalse(r["body_checked"])

    def test_deadline_expires_without_request(self):
        r = probe.probe(self.base + "/ok", "GET", {"start": 0, "end": 1023}, SIZE, time.monotonic() - 1)
        self.assertEqual(r["error"], "budget-exhausted")
        self.assertEqual(r["bytes_read"], 0)

    def test_wall_clock_interrupt_cancels_a_stalled_body_read(self):
        old = signal.getsignal(signal.SIGALRM)
        def expired(*_):
            raise probe.BudgetExceeded()
        signal.signal(signal.SIGALRM, expired)
        signal.setitimer(signal.ITIMER_REAL, 0.05)
        try:
            r = self.one("/stall", {"start": 2000, "end": 3023})
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)
            signal.signal(signal.SIGALRM, old)
        self.assertEqual(r["error"], "budget-exhausted")
        self.assertEqual(r["bytes_read"], 0)

    def test_cli_uses_stdin_and_emits_only_sanitized_evidence(self):
        run = subprocess.run([sys.executable, str(ROOT / "tools/probe_media.py")],
                             input=self.base + "/ok/private-secret?sig=private-query", text=True, capture_output=True, timeout=5)
        self.assertEqual(run.returncode, 0)
        result = json.loads(run.stdout)
        self.assertEqual(result["result"]["bytes_read_total"], 4096)
        self.assertNotRegex(run.stdout + run.stderr, "private-secret|private-query")


if __name__ == "__main__":
    unittest.main()
