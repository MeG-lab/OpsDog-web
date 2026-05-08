import json
import sys


def main():
    payload = json.loads(sys.stdin.read() or "{}")
    message = str(payload.get("message") or "")
    print(json.dumps({
        "ok": True,
        "message": message,
        "length": len(message),
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
