"""模拟「某一条连接被限速」的测试服务：第 1 个分片请求极慢，其余正常。

用来验证客户端能否发现拖后腿的分片并主动换连接。

用法: python slowsrv.py <文件> <端口> [正常速率B/s] [慢速率B/s]
"""
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PATH = os.path.abspath(sys.argv[1])
PORT = int(sys.argv[2])
RATE = int(sys.argv[3]) if len(sys.argv) > 3 else 1_600_000
SLOW = int(sys.argv[4]) if len(sys.argv) > 4 else 15_000
SIZE = os.path.getsize(PATH)

lock = threading.Lock()
count = 0
T0 = time.time()


class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def do_GET(self):
        global count
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

        with lock:
            count += 1
            idx = count
        # 只有第 1 个分段请求被「限速」，模拟运营商对单连接的限速
        rate = SLOW if idx == 1 else RATE
        print(
            f"[{time.time()-T0:6.2f}s] req#{idx} bytes={start}-{end} "
            f"len={length} rate={rate}",
            flush=True,
        )

        self.send_response(206 if partial else 200)
        self.send_header("Content-Length", str(length))
        if partial:
            self.send_header("Content-Range", f"bytes {start}-{end}/{SIZE}")
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Type", "application/octet-stream")
        self.end_headers()

        chunk = 32 * 1024
        sent = 0
        t0 = time.time()
        try:
            with open(PATH, "rb") as f:
                f.seek(start)
                while sent < length:
                    n = min(chunk, length - sent)
                    data = f.read(n)
                    if not data:
                        break
                    self.wfile.write(data)
                    sent += len(data)
                    # 按速率睡眠
                    due = sent / rate
                    slack = due - (time.time() - t0)
                    if slack > 0:
                        time.sleep(slack)
        except (BrokenPipeError, ConnectionResetError):
            print(f"[{time.time()-T0:6.2f}s] req#{idx} 客户端断开（已发 {sent}）", flush=True)
        else:
            print(f"[{time.time()-T0:6.2f}s] req#{idx} 完成 {sent}", flush=True)


ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
