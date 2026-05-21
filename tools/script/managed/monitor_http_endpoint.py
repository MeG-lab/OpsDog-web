import sys, json, time, subprocess

payload = {}
raw = sys.stdin.read()
if raw.strip():
    payload = json.loads(raw)

target = payload.get("target", "http://127.0.0.1:8787/api/health")
interval = int(payload.get("interval", 10))
timeout = int(payload.get("timeout", 5))
max_failures = int(payload.get("max_failures", 3))
fail_count = 0

try:
    while True:
        start_time = time.time()
        try:
            result = subprocess.run(
                ["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", 
                 "--max-time", str(timeout), target],
                capture_output=True, text=True, timeout=timeout + 2
            )
            http_code = result.stdout.strip()
            elapsed = time.time() - start_time
            
            if http_code == "200":
                ok = True
                status_code = int(http_code)
            else:
                ok = False
                status_code = int(http_code) if http_code.isdigit() else 0
        
        except subprocess.TimeoutExpired:
            ok = False
            status_code = 0
            elapsed = time.time() - start_time
        except Exception as e:
            ok = False
            status_code = 0
            elapsed = time.time() - start_time
        
        event = {
            "time": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "target": target,
            "elapsed": round(elapsed, 3)
        }
        
        if ok:
            if fail_count > 0:
                event["status"] = "recovered"
                event["level"] = "info"
                event["message"] = f"{target} 已恢复，响应时间 {elapsed:.3f}s"
                fail_count = 0
            else:
                event["status"] = "running"
                event["level"] = "info"
                event["message"] = f"{target} 正常，HTTP {status_code}，响应时间 {elapsed:.3f}s"
        else:
            fail_count += 1
            if fail_count >= max_failures:
                event["status"] = "error"
                event["level"] = "error"
                event["message"] = f"{target} 连续失败 {fail_count} 次，HTTP {status_code}"
            else:
                event["status"] = "warning"
                event["level"] = "warning"
                event["message"] = f"{target} 失败 ({fail_count}/{max_failures})，HTTP {status_code}"
        
        print(json.dumps(event, ensure_ascii=False), flush=True)
        time.sleep(interval)

except KeyboardInterrupt:
    pass
