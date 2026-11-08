"""模拟线路故障的测试服务，用来验证 504 的处理是否合理。

模式：
  all       所有请求都返回 504
  flaky:N   前 N 个请求返回 504，之后正常（模拟一次抖动）
  down404   所有请求返回 404

用法: python err_srv.py <文件> <端口> <模式>
"""
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PATH = os.path.abspath(sys.argv[1])
PORT = int(sys.argv[2])
MODE = sys.argv[3] if len(sys.argv) > 3 else "all"
SIZE = os.path.getsize(PATH)

lock = threading.Lock()
count = 0
T0 = time.time()


class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def _err(self, code):
        body = b"upstream timeout"
        self.send_response(code)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Content-Type", "text/plain")
        self.end_headers()
        try:
            self.wfile.write(body)
        except Exception:
            pass

    def do_GET(self):
        global count
        with lock:
            count += 1
            idx = count
        print(f"[{time.time()-T0:6.2f}s] req#{idx} mode={MODE}", flush=True)

        if MODE == "all":
            self._err(504)
            return
        if MODE == "down404":
            self._err(404)
            return
        if MODE.startswith("flaky:"):
            n = int(MODE.split(":")[1])
            if idx <= n:
                self._err(504)
                return

        start, end = 0, SIZE - 1
        rng = self.headers.get("Range")
        partial = False
        if rng and rng.startswith("bytes="):
            spec = rng[6:].split(",")[0]
            a, _, b = spec.partition("-")
            start = int(a) if a else 0
            end = int(b) if b else SIZE - 1
            partial = True
            end = min(end, SIZE - 1)
        length = end - start + 1
        self.send_response(206 if partial else 200)
        self.send_header("Content-Length", str(length))
        if partial:
            self.send_header("Content-Range", f"bytes {start}-{end}/{SIZE}")
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Type", "application/octet-stream")
        self.end_headers()
        try:
            with open(PATH, "rb") as f:
                f.seek(start)
                left = length
                while left > 0:
                    data = f.read(min(64 * 1024, left))
                    if not data:
                        break
                    self.wfile.write(data)
                    left -= len(data)
        except (BrokenPipeError, ConnectionResetError):
            pass


ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
