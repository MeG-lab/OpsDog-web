import json
import sys


def main():
    payload = json.loads(sys.stdin.read() or "{}")
    numbers = payload.get("numbers") or []
    values = [float(item) for item in numbers]
    print(json.dumps({
        "ok": True,
        "count": len(values),
        "sum": sum(values),
        "average": sum(values) / len(values) if values else 0,
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
