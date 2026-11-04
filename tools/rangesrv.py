"""断点续传自测用的本地 HTTP 服务：支持 Range，按 32KB/20ms 限速。

用法: python rangesrv.py <文件> <端口> [每秒字节上限]
"""
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PATH = os.path.abspath(sys.argv[1])
PORT = int(sys.argv[2])
RATE = int(sys.argv[3]) if len(sys.argv) > 3 else 1_600_000
SIZE = os.path.getsize(PATH)


class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def do_GET(self):
        start, end = 0, SIZE - 1
        rng = self.headers.get("Range")
        partial = False
        if rng and rng.startswith("bytes="):
            spec = rng[6:].split(",")[0]
            a, _, b = spec.partition("-")
            start = int(a) if a else 0
            end = int(b) if b else SIZE - 1
            end = min(end, SIZE - 1)
            if start >= SIZE:
                self.send_response(416)
                self.send_header("Content-Range", "bytes */%d" % SIZE)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            partial = True
        length = end - start + 1
        self.send_response(206 if partial else 200)
        self.send_header("Content-Length", str(length))
        self.send_header("Content-Type", "application/octet-stream")
        if partial:
            self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, SIZE))
        self.end_headers()

        chunk = 32768
        wait = chunk / float(RATE)
        with open(PATH, "rb") as f:
            f.seek(start)
            left = length
            while left > 0:
                data = f.read(min(chunk, left))
                if not data:
                    break
                try:
                    self.wfile.write(data)
                    self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError):
                    return
                left -= len(data)
                time.sleep(wait)


ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
