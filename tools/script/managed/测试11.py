import sys
import json
import time
import socket

payload = {}
raw = sys.stdin.read()
if raw.strip():
    payload = json.loads(raw)

target = payload.get("target", "172.81.91.11")
port = int(payload.get("port", 80))
interval = int(payload.get("interval", 5))
max_failures = int(payload.get("max_failures", 3))
timeout = int(payload.get("timeout", 3))
fail_count = 0

try:
    while True:
        event = {"time": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}

        ok = False
        latency_ms = 0
        err_msg = ""
        try:
            start = time.time()
            sock = socket.create_connection((target, port), timeout=timeout)
            latency_ms = round((time.time() - start) * 1000)
            sock.close()
            ok = True
        except socket.timeout:
            err_msg = f"连接 {target}:{port} 超时 ({timeout}s)"
        except socket.gaierror:
            err_msg = f"无法解析主机名 {target}"
        except ConnectionRefusedError:
            err_msg = f"{target}:{port} 连接被拒绝"
        except OSError as e:
            err_msg = f"{target}:{port} 连接失败: {str(e)}"

        if ok:
            fail_count = 0
            event["status"] = "running"
            event["level"] = "info"
            event["message"] = f"{target}:{port} 检测正常，延迟 {latency_ms}ms"
        else:
            fail_count += 1
            if fail_count >= max_failures:
                event["status"] = "error"
                event["level"] = "error"
                event["message"] = f"{target}:{port} 连续失败 {fail_count}/{max_failures} 次: {err_msg}"
            else:
                event["status"] = "warning"
                event["level"] = "warning"
                event["message"] = f"{target}:{port} 检测失败 ({fail_count}/{max_failures}): {err_msg}"

        event["target"] = f"{target}:{port}"
        event["data"] = {
            "target": target,
            "port": port,
            "latency_ms": latency_ms if ok else None,
            "fail_count": fail_count,
        }

        print(json.dumps(event, ensure_ascii=False), flush=True)
        time.sleep(interval)

except KeyboardInterrupt:
    pass
