import sys
import json
import time
from datetime import datetime, timezone

raw = sys.stdin.read()
payload = json.loads(raw) if raw.strip() else {}

interval = payload.get("interval", 10)

try:
    tick = 0
    while True
        tick += 1
        event = {
            "time": datetime.now(timezone.utc).isoformat(),
            "level": "info",
            "status": "running",
            "ok": True,
            "message": f"心跳 #{tick}",
            "data": {"tick": tick, "interval": interval}
        }
        print(json.dumps(event, ensure_ascii=False), flush=True)
        time.sleep(interval)
except KeyboardInterrupt:
    sys.exit(0)
