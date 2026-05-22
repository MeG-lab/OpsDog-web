import sys
import json
from datetime import datetime, timezone

raw = sys.stdin.read()
payload = json.loads(raw) if raw.strip() else {}

message = payload.get("message", "Hello, OpsDog!")

output = {
    "ok": True,
    "status": "success",
    "summary": f"收到消息: {message}",
    "data": {
        "message": message,
        "time": datetime.now(timezone.utc).isoformat()
    }
}

print(json.dumps(output, ensure_ascii=False), flush=True)
