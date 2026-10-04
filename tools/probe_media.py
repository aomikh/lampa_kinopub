#!/usr/bin/env python3
"""Bounded HEAD + 1 KiB Range probe. URLs are read from stdin, never logged.

Usage: python3 tools/probe_media.py --demo
       python3 tools/probe_media.py < /private/current-link.txt
No tokens/cookies are added. This does not test Infuse or an Apple TV route.
"""
import argparse
import datetime
import json
import sys
import urllib.error
import urllib.parse
import urllib.request

LIMIT = 1024
HEADERS = ("Content-Type", "Content-Length", "Content-Range", "Accept-Ranges",
           "Transfer-Encoding", "Content-Encoding", "X-Cache")


def origin(url):
    parsed = urllib.parse.urlsplit(url)
    return {"scheme": parsed.scheme, "host": parsed.hostname}


class Redirects(urllib.request.HTTPRedirectHandler):
    def __init__(self):
        self.chain = []

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        self.chain.append({"status": code, "from": origin(req.full_url), "to": origin(newurl)})
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def probe(url, method):
    redirects = Redirects()
    opener = urllib.request.build_opener(redirects)
    headers = {"User-Agent": "Lampa-KP-bounded-diagnostic/1", "Accept-Encoding": "identity"}
    if method == "GET":
        headers["Range"] = "bytes=0-1023"
    req = urllib.request.Request(url, method=method, headers=headers)
    try:
        try:
            response = opener.open(req, timeout=8)
        except urllib.error.HTTPError as err:
            response = err
        with response:
            result = {"method": method, "redirects": redirects.chain, "final": origin(response.geturl()),
                      "status": response.status, "headers": {key: response.headers.get(key) for key in HEADERS}}
            if method == "GET":
                body = response.read(LIMIT)
                stripped = body.lstrip()
                result["bytes_read"] = len(body)
                result["range_honored"] = response.status == 206 and bool(response.headers.get("Content-Range"))
                result["body_kind"] = "hls-manifest" if stripped.startswith(b"#EXTM3U") else (
                    "html" if stripped.lower().startswith((b"<!doctype", b"<html")) else (
                        "json" if stripped.startswith((b"{", b"[")) else (
                            "mp4" if body[4:8] == b"ftyp" else "other")))
            return result
    except (OSError, ValueError):
        # urllib exception text can contain the complete sensitive URL.
        return {"method": method, "redirects": redirects.chain, "error": "network-or-invalid-response"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--demo", action="store_true")
    args = parser.parse_args()
    if args.demo:
        manifest = "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8"
        targets = [
            ("Firecore documented short MP4", "https://files.firecore.com/infuse/sample-5s-360p.mp4"),
            ("Public Mux test manifest", manifest),
            ("Deployed reducer with public Mux test manifest", "https://kinopub.fastcdn.pics/manifest-proxy?master=" + urllib.parse.quote(manifest, safe="") + "&voice=1"),
        ]
    else:
        # Never put signed links in command arguments, git files or reports.
        targets = [("Provided current resource " + str(i + 1), url.strip())
                   for i, url in enumerate(sys.stdin) if url.strip()]
    if not targets:
        parser.error("Provide a link on stdin or select --demo")
    results = []
    for label, url in targets:
        if urllib.parse.urlsplit(url).scheme not in ("http", "https"):
            parser.error("Only HTTP/HTTPS resources are supported")
        results.append({"label": label, "origin": origin(url), "checks": [probe(url, "HEAD"), probe(url, "GET")]})
    json.dump({"checked_at_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
               "per_get_read_limit": LIMIT, "device_route_tested": False, "results": results}, sys.stdout, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
