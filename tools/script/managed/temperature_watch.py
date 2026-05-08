import json
import sys
import time
from datetime import datetime, timezone


def emit(payload):
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def main():
    payload = json.loads(sys.stdin.read() or "{}")
    interval = int(payload.get("interval") or 2)
    values = [26, 29, 32, 35, 28]
    index = 0
    try:
        while True:
            value = values[index % len(values)]
            status = "warning" if value >= 32 else "running"
            emit({
                "status": status,
                "temperature": value,
                "time": datetime.now(timezone.utc).isoformat(),
                "message": f"temperature={value}",
            })
            index += 1
            time.sleep(interval)
    except KeyboardInterrupt:
        emit({
            "status": "stopped",
            "time": datetime.now(timezone.utc).isoformat(),
            "message": "temperature watcher stopped",
        })


if __name__ == "__main__":
    main()
