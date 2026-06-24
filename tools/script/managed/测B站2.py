import sys
import json
import time
import urllib.request
import urllib.error

payload = {}
raw = sys.stdin.read()
if raw.strip():
    payload = json.loads(raw)

target = payload.get("target", "www.bilibili.com")
interval = int(payload.get("interval", 5))
timeout = int(payload.get("timeout", 5))
max_failures = int(payload.get("max_failures", 3))

url = f"https://{target}"
fail_count = 0
was_failed = False

try:
    while True:
        ok = False
        err_msg = ""
        try:
            req = urllib.request.Request(
                url,
                method="GET",
                headers={"User-Agent": "OpsDog-HealthCheck/1.0"},
            )
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                if 200 <= resp.status < 400:
                    ok = True
                else:
                    ok = False
                    err_msg = f"HTTP {resp.status}"
        except urllib.error.HTTPError as e:
            err_msg = f"HTTP {e.code}"
        except urllib.error.URLError as e:
            err_msg = f"URL Error: {e.reason}"
        except Exception as e:
            err_msg = f"Exception: {e}"

        event = {"time": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}

        if ok:
            if was_failed:
                event["status"] = "recovered"
                event["level"] = "info"
                event["message"] = f"{target} 服务已恢复"
            else:
                event["status"] = "running"
                event["level"] = "info"
                event["message"] = f"{target} 检测正常"
            fail_count = 0
            was_failed = False
        else:
            fail_count += 1
            was_failed = True
            if fail_count >= max_failures:
                event["status"] = "error"
                event["level"] = "error"
                event["message"] = f"{target} 连续失败 {fail_count} 次: {err_msg}"
            else:
                event["status"] = "warning"
                event["level"] = "warning"
                event["message"] = f"{target} 检测失败 ({fail_count}/{max_failures}): {err_msg}"

        event["target"] = target
        print(json.dumps(event, ensure_ascii=False), flush=True)
        time.sleep(interval)
except KeyboardInterrupt:
    pass
