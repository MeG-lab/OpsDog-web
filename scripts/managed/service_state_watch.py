import json
import sys
import time
from datetime import datetime, timezone


def emit(payload):
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def main():
    payload = json.loads(sys.stdin.read() or "{}")
    interval = int(payload.get("interval") or 3)
    states = ["running", "running", "warning", "recovered", "running"]
    index = 0
    try:
        while True:
            state = states[index % len(states)]
            emit({
                "status": state,
                "service": "demo-service",
                "time": datetime.now(timezone.utc).isoformat(),
                "message": f"service status={state}",
            })
            index += 1
            time.sleep(interval)
    except KeyboardInterrupt:
        emit({
            "status": "stopped",
            "service": "demo-service",
            "time": datetime.now(timezone.utc).isoformat(),
            "message": "service watcher stopped",
        })


if __name__ == "__main__":
    main()
