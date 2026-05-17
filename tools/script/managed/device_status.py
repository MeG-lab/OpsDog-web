#!/usr/bin/env python3
import urllib.request
import json
import sys
import time
import os
from datetime import datetime, timezone

_opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def emit(payload):
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def build_api_url(payload):
    origin = str(
        payload.get("apiOrigin")
        or os.environ.get("OPSDOG_SERVER_ORIGIN")
        or "http://127.0.0.1:8787"
    ).rstrip("/")
    return f"{origin}/api/monitor/status"


def fetch_devices(api_url):
    try:
        with _opener.open(api_url, timeout=5) as resp:
            data = json.loads(resp.read().decode())
            return data.get("items", [])
    except Exception:
        return None


_last_status = "running"


def summarize(devices):
    global _last_status

    healthy = 0
    abnormal = 0
    unknown = 0
    offline = []

    for d in devices:
        s = d.get("status", "unknown")
        if s == "healthy":
            healthy += 1
        elif s in ("attention", "critical"):
            abnormal += 1
            offline.append({
                "deviceId": d.get("deviceId"),
                "status": s,
                "failCount": d.get("failCount"),
                "message": d.get("message"),
            })
        else:
            unknown += 1

    if abnormal > 0:
        status = "warning"
    elif _last_status == "warning":
        status = "recovered"
    else:
        status = "running"

    _last_status = status

    return {
        "status": status,
        "total": len(devices),
        "healthy": healthy,
        "abnormal": abnormal,
        "unknown": unknown,
        "offline": offline,
    }


def main():
    if sys.stdin.isatty():
        payload = {}
    else:
        payload = json.loads(sys.stdin.read() or "{}")
    interval = int(payload.get("interval") or 10)
    api_url = build_api_url(payload)

    emit({
        "status": "running",
        "time": datetime.now(timezone.utc).isoformat(),
        "message": "设备存活检测已启动",
        "apiUrl": api_url,
    })

    try:
        while True:
            devices = fetch_devices(api_url)

            if devices is None:
                emit({
                    "status": "warning",
                    "time": datetime.now(timezone.utc).isoformat(),
                    "message": "无法获取设备状态，API 不可达",
                })
                time.sleep(interval)
                continue

            summary = summarize(devices)
            summary["time"] = datetime.now(timezone.utc).isoformat()
            summary["message"] = f"健康 {summary['healthy']}/{summary['total']}" + (
                f"，异常 {summary['abnormal']}" if summary['abnormal'] > 0 else ""
            )
            emit(summary)
            time.sleep(interval)

    except KeyboardInterrupt:
        emit({
            "status": "stopped",
            "time": datetime.now(timezone.utc).isoformat(),
            "message": "设备存活检测已停止",
        })


if __name__ == "__main__":
    main()
