#!/usr/bin/env python3
"""Bounded HTTP range diagnostic, not an Infuse/Apple TV speed test.

python3 tools/probe_media.py --demo
python3 tools/probe_media.py [--offset 205444144] < /private/current-link.txt
Read ONE authorized fresh URL from stdin. Never put it in arguments or git.
--offset is ONLY for the same resource as the error; default uses its midpoint.
POSIX required for the hard wall-clock deadline. No credentials/cookies added.
"""
import argparse
import datetime
import json
import re
import signal
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

LIMIT = 1024
BUDGET_SECONDS = 20
MAX_REDIRECTS = 3
MAX_SIZE = 9007199254740991


class BudgetExceeded(Exception):
    pass


def origin(url):
    parsed = urllib.parse.urlsplit(url)
    return {"scheme": parsed.scheme, "host": parsed.hostname}


def permitted(url):
    parsed = urllib.parse.urlsplit(url)
    return parsed.scheme in ("http", "https") and bool(parsed.hostname) and not parsed.username and not parsed.password


def number(value):
    return int(value) if value is not None and re.fullmatch(r"\d{1,16}", str(value)) and int(value) <= MAX_SIZE else None


def parse_range(value):
    match = re.fullmatch(r"bytes (?:(\d+)-(\d+)|\*)/(\d+|\*)", value or "", re.I)
    if not match:
        return None
    start, end, total = match.groups()
    size = number(total)
    if total != "*" and size is None:
        return None
    if start is None:
        return {"total": size, "unsatisfied": True} if size is not None else None
    start, end = number(start), number(end)
    if start is None or end is None or start > end or (size is not None and end >= size):
        return None
    return {"start": start, "end": end, "total": size}


def verdict(status, headers, request, size):
    if status in (401, 403):
        return "authorization"
    if status == 200:
        return "range-ignored"
    content_range = headers.get("Content-Range")
    part = parse_range(content_range)
    if status == 416:
        if not part or not part.get("unsatisfied"):
            return "unknown-range"
        if size is not None and size != part["total"]:
            return "size-changed"
        return "unsatisfiable" if part["total"] == 0 or request.get("start", -1) >= part["total"] else "rejected-range"
    if status != 206:
        return "http-error"
    if not content_range:
        return "unknown-range"
    if not part or part.get("unsatisfied"):
        return "invalid-range"
    if size is not None and part["total"] is not None and size != part["total"]:
        return "size-changed"
    total = size if part["total"] is None else part["total"]
    if request.get("suffix") and total is None:
        return "unknown-range"
    start = max(0, total - request["suffix"]) if request.get("suffix") else request["start"]
    end = request.get("end")
    if end is None:
        end = None if total is None else total - 1
    elif total is not None:
        end = min(end, total - 1)
    if part["start"] != start or (end is not None and part["end"] > end):
        return "invalid-range"
    length = headers.get("Content-Length")
    if length is not None and number(length) != part["end"] - part["start"] + 1:
        return "invalid-range"
    return "headers-partial" if end is None or part["end"] < end else "headers-match"


def range_header(request):
    if "suffix" in request:
        return "bytes=-" + str(request["suffix"])
    return "bytes=" + str(request["start"]) + "-" + str(request.get("end", ""))


def safe_headers(headers):
    patterns = {"Content-Type": r"[\w.+-]+/[\w.+-]+", "Content-Length": r"\d{1,16}",
                "Content-Range": r"bytes (?:\d{1,16}-\d{1,16}|\*)/(?:\d{1,16}|\*)",
                "Accept-Ranges": r"bytes|none", "Content-Encoding": r"[a-z0-9-]{1,32}"}
    result = {}
    for key, pattern in patterns.items():
        value = headers.get(key)
        if key == "Content-Type" and value:
            value = value.split(";")[0].strip()
        result[key] = None if not value else value if re.fullmatch(pattern, value, re.I) else "invalid"
    return result


class Redirects(urllib.request.HTTPRedirectHandler):
    def __init__(self, deadline):
        self.chain, self.deadline = [], deadline

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if len(self.chain) >= MAX_REDIRECTS or not permitted(newurl):
            raise ValueError("redirect rejected")
        if time.monotonic() >= self.deadline:
            raise BudgetExceeded()
        # Only diagnostic Range/Accept-Encoding/User-Agent, never user auth.
        redirected = super().redirect_request(req, fp, code, msg, headers, newurl)
        self.chain.append({"status": code, "from": origin(req.full_url), "to": origin(newurl),
                           "range_forwarded": redirected.get_header("Range") == req.get_header("Range")})
        return redirected


def probe(url, method, request, size, deadline, if_range=None):
    started = time.monotonic()
    redirects = Redirects(deadline)
    result = {"method": method, "requested": range_header(request) if request else None,
              "redirects": redirects.chain, "bytes_read": 0, "body_checked": False}
    response = None
    try:
        if not permitted(url):
            raise ValueError("invalid resource")
        remaining = deadline - started
        if remaining <= 0:
            raise BudgetExceeded()
        headers = {"User-Agent": "Lampa-KP-bounded-diagnostic/2", "Accept-Encoding": "identity"}
        if request:
            headers["Range"] = range_header(request)
        if if_range:
            if len(if_range) > 128 or "\r" in if_range or "\n" in if_range:
                raise ValueError("invalid validator")
            headers["If-Range"] = if_range
            result["conditional_if_range"] = True  # Never log the validator itself.
        req = urllib.request.Request(url, method=method, headers=headers)
        opener = urllib.request.build_opener(redirects)
        try:
            response = opener.open(req, timeout=min(4, remaining))
        except urllib.error.HTTPError as err:
            response = err
        result.update(status=response.status, final=origin(response.geturl()), headers=safe_headers(response.headers),
                      headers_ms=round((time.monotonic() - started) * 1000))
        if request:
            result["verdict"] = verdict(response.status, result["headers"], request, size)
            encoding = (result["headers"]["Content-Encoding"] or "identity").lower()
            if result["verdict"] in ("headers-match", "headers-partial") and encoding == "identity":
                part = parse_range(result["headers"]["Content-Range"])
                wanted = min(LIMIT, part["end"] - part["start"] + 1)
                first = b""
                while result["bytes_read"] < wanted:
                    if time.monotonic() >= deadline:
                        raise BudgetExceeded()
                    chunk = response.read1(wanted - result["bytes_read"])
                    if not chunk:
                        break
                    first += chunk
                    result["bytes_read"] += len(chunk)
                result["body_checked"] = True
                result["body_scope"] = "sample-only"
                result["sample_complete"] = result["bytes_read"] == wanted
                if request.get("start") == 0:
                    stripped = first.lstrip()
                    result["body_kind"] = "mp4-ftyp" if first[4:8] == b"ftyp" else (
                        "hls" if stripped.startswith(b"#EXTM3U") else (
                            "html-or-json" if stripped.lower().startswith((b"<!doctype", b"<html", b"{", b"[")) else "unknown"))
            # A 200, bad 206, 416 or auth error is closed with ZERO body reads.
    except BudgetExceeded:
        result["error"] = "budget-exhausted"
    except (OSError, ValueError):
        result["error"] = "network-or-invalid-response"
    finally:
        if response:
            response.close()
        result["elapsed_ms"] = round((time.monotonic() - started) * 1000)
    return result


def inspect_resource(url, offset=None, if_range=None):
    deadline = time.monotonic() + BUDGET_SECONDS
    results, size = [], None
    queue = [("HEAD", None), ("GET", {"start": 0, "end": 1023})]
    offset_note = None
    for method, request in queue:
        conditional = request and request.get("conditional")
        result = probe(url, method, request, size, deadline, if_range if conditional else None)
        results.append(result)
        h = result.get("headers", {})
        part = parse_range(h.get("Content-Range"))
        identity = (h.get("Content-Encoding") or "identity").lower() == "identity"
        error_type = h.get("Content-Type") in ("text/html", "application/json", "application/vnd.apple.mpegurl", "application/x-mpegurl")
        if method == "HEAD" and result.get("status") == 200 and identity and not error_type:
            size = number(h.get("Content-Length"))
        if request and request.get("start") == 0 and not conditional:
            if identity and result.get("verdict") in ("headers-match", "headers-partial") and part["total"] is not None:
                size = part["total"]
            if size and size > 1 and identity:
                middle = size // 2 if offset is None else offset
                if 0 < middle < size:
                    bounded = {"start": middle, "end": min(size - 1, middle + 1023)}
                    queue.extend([("GET", bounded), ("GET", {"start": middle})])
                    if if_range:
                        queue.append(("GET", {**bounded, "conditional": True}))
                else:
                    offset_note = "requested offset is outside this resource; not probed"
            else:
                offset_note = "size unavailable; no guessed nonzero offset"
            queue.append(("GET", {"suffix": 1024}))
        if (result.get("error") == "budget-exhausted" or (method == "GET" and
            (result.get("status") in (401, 403, 404, 410) or result.get("verdict") == "size-changed" or
             error_type or result.get("body_kind") in ("hls", "html-or-json")))):
            break
    return {"origin": origin(url), "checks": results, "offset_note": offset_note,
            "bytes_read_total": sum(r["bytes_read"] for r in results)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--demo", action="store_true", help="Firecore public short MP4, not KinoPub")
    parser.add_argument("--offset", type=int, help="Offset from THIS file's error; omit for its midpoint")
    parser.add_argument("--if-range", help="Optional observed validator; one additional bounded comparison, value not logged")
    args = parser.parse_args()
    if not hasattr(signal, "setitimer"):
        parser.error("POSIX required to enforce the hard 20 second limit")
    if args.offset is not None and not 0 < args.offset <= MAX_SIZE - LIMIT:
        parser.error("Offset must be a positive safe byte count")
    url = "https://files.firecore.com/infuse/sample-5s-360p.mp4" if args.demo else sys.stdin.read(65537).strip()
    if len(url) > 65536 or any(c.isspace() for c in url) or not permitted(url):
        parser.error("Provide exactly one HTTP/HTTPS link on stdin")
    def expired(_signal, _frame):
        raise BudgetExceeded()
    signal.signal(signal.SIGALRM, expired)
    signal.setitimer(signal.ITIMER_REAL, BUDGET_SECONDS)
    try:
        result = inspect_resource(url, args.offset, args.if_range)
    except BudgetExceeded:
        result = {"error": "budget-exhausted"}
    except KeyboardInterrupt:
        result = {"error": "cancelled"}
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
    json.dump({"checked_at_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
               "per_get_read_limit": LIMIT, "wall_clock_limit_seconds": BUDGET_SECONDS,
               "device_route_tested": False, "infuse_tested": False, "demo": args.demo,
               "result": result}, sys.stdout, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
