import json
import sys
import time
from datetime import datetime, timezone


def emit(payload):
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def main():
    payload = json.loads(sys.stdin.read() or "{}")
    interval = int(payload.get("interval") or 2)
    name = str(payload.get("name") or "heartbeat")
    count = 0
    try:
        while True:
            count += 1
            emit({
                "status": "running",
                "name": name,
                "count": count,
                "time": datetime.now(timezone.utc).isoformat(),
                "message": f"{name} tick {count}",
            })
            time.sleep(interval)
    except KeyboardInterrupt:
        emit({
            "status": "stopped",
            "name": name,
            "time": datetime.now(timezone.utc).isoformat(),
            "message": f"{name} stopped",
        })


if __name__ == "__main__":
    main()
