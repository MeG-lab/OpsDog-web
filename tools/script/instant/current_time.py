import json
import sys
from datetime import datetime, timezone


def main():
    payload = json.loads(sys.stdin.read() or "{}")
    label = str(payload.get("label") or "now")
    print(json.dumps({
        "ok": True,
        "label": label,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
