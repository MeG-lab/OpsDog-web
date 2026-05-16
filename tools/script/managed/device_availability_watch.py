import concurrent.futures
import json
import os
import platform
import re
import signal
import socket
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path


APP_ROOT = Path(__file__).resolve().parents[3]
ASSETS_DIR = APP_ROOT / "server" / "data" / "assets"
MERGED_PATH = ASSETS_DIR / "device.merged.json"
STATUS_PATH = ASSETS_DIR / "device.status.json"

PING_LATENCY_PATTERNS = [
    re.compile(r"time[=<]([\d.]+)\s*ms", re.IGNORECASE),
    re.compile(r"avg[=/]([\d.]+)", re.IGNORECASE),
]

RUNNING = True


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def emit(payload):
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def load_json(path: Path, fallback):
    if not path.exists():
        return fallback
    with path.open("r", encoding="utf-8") as fh:
        return json.load(fh)


def atomic_write_json(path: Path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=str(path.parent), delete=False) as tmp:
        json.dump(payload, tmp, ensure_ascii=False, indent=2)
        tmp.write("\n")
        temp_name = tmp.name
    os.replace(temp_name, path)


def parse_ping_latency(output: str):
    for pattern in PING_LATENCY_PATTERNS:
        match = pattern.search(output or "")
        if match:
            try:
                return round(float(match.group(1)), 2)
            except ValueError:
                return None
    return None


def run_ping(target: str, timeout_ms: int):
    command = ["ping", "-c", "1", target]
    if platform.system().lower() == "linux":
        command = ["ping", "-c", "1", "-W", str(max(1, int(timeout_ms / 1000))), target]
    started = time.perf_counter()
    try:
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=max(1, timeout_ms / 1000) + 1,
            check=False,
        )
        elapsed_ms = round((time.perf_counter() - started) * 1000, 2)
        if result.returncode == 0:
            return {
                "ok": True,
                "latencyMs": parse_ping_latency(result.stdout) or elapsed_ms,
                "message": "ping ok",
                "error": "",
            }
        message = (result.stderr or result.stdout or "ping failed").strip()
        return {
            "ok": False,
            "latencyMs": None,
            "message": "ping failed",
            "error": message,
        }
    except subprocess.TimeoutExpired:
        return {
            "ok": False,
            "latencyMs": None,
            "message": "ping timeout",
            "error": f"ping timeout after {timeout_ms}ms",
        }
    except Exception as error:
        return {
            "ok": False,
            "latencyMs": None,
            "message": "ping error",
            "error": str(error),
        }


def run_tcp(target: str, port: int, timeout_ms: int):
    started = time.perf_counter()
    try:
        with socket.create_connection((target, int(port)), timeout=max(0.2, timeout_ms / 1000)):
            elapsed_ms = round((time.perf_counter() - started) * 1000, 2)
            return {
                "ok": True,
                "latencyMs": elapsed_ms,
                "message": f"tcp {port} ok",
                "error": "",
            }
    except Exception as error:
        return {
            "ok": False,
            "latencyMs": None,
            "message": f"tcp {port} failed",
            "error": str(error),
        }


def compute_combined_result(device):
    check_type = str(device.get("checkType") or "").strip().lower()
    target = str(device.get("checkTarget") or device.get("ipAddress") or "").strip()
    timeout_ms = int(device.get("timeoutMs") or 3000)
    port = device.get("checkPort")

    if not target:
        return {
            "ok": False,
            "latencyMs": None,
            "message": "missing check target",
            "error": "未配置检测目标",
            "parts": [],
        }

    parts = []
    if check_type in {"ping", "ping+tcp"}:
        parts.append(("ping", run_ping(target, timeout_ms)))
    if check_type in {"tcp", "ping+tcp"} and port:
        parts.append((f"tcp:{port}", run_tcp(target, int(port), timeout_ms)))

    if not parts:
        return {
            "ok": False,
            "latencyMs": None,
            "message": "unsupported check type",
            "error": f"未配置有效检测方式: {check_type or '<empty>'}",
            "parts": [],
        }

    any_success = any(result["ok"] for _, result in parts)
    latency = next((result["latencyMs"] for _, result in parts if result["ok"] and result["latencyMs"] is not None), None)
    messages = [result["message"] for _, result in parts]
    errors = [result["error"] for _, result in parts if result["error"]]

    return {
        "ok": any_success,
        "latencyMs": latency,
        "message": " / ".join(messages),
        "error": " ; ".join(errors),
        "parts": parts,
    }


def make_status_key(item):
    return f"{item.get('source', 'local')}::{item.get('deviceId', '')}"


def update_status_entry(previous, device, result, checked_at):
    previous = previous or {}
    fail_threshold = int(device.get("failThreshold") or 3)
    previous_fail_count = int(previous.get("failCount") or 0)
    fail_count = 0 if result["ok"] else previous_fail_count + 1

    if result["ok"]:
        status = "healthy"
    elif fail_count >= fail_threshold:
        status = "critical"
    else:
        status = "attention"

    return {
        "source": device.get("source", "local"),
        "deviceId": device.get("deviceId"),
        "status": status,
        "online": bool(result["ok"]),
        "checkType": device.get("checkType", ""),
        "lastCheckAt": checked_at,
        "lastSuccessAt": checked_at if result["ok"] else previous.get("lastSuccessAt"),
        "lastFailureAt": checked_at if not result["ok"] else previous.get("lastFailureAt"),
        "latencyMs": result["latencyMs"],
        "failCount": fail_count,
        "lastError": "" if result["ok"] else result["error"],
        "message": result["message"],
    }


def status_changed(previous, current):
    if not previous:
        return True
    keys = [
        "status",
        "online",
        "checkType",
        "lastSuccessAt",
        "lastFailureAt",
        "latencyMs",
        "failCount",
        "lastError",
        "message",
    ]
    return any(previous.get(key) != current.get(key) for key in keys)


def rebuild_merged():
    rebuild_script = "import('./server/src/deviceMergedStore.js').then(async (m)=>{await m.rebuildMergedDevices();}).catch((err)=>{console.error(err); process.exit(1);})"
    subprocess.run(
        ["node", "-e", rebuild_script],
        cwd=str(APP_ROOT),
        capture_output=True,
        text=True,
        timeout=20,
        check=False,
    )


def is_due_for_check(device, previous, cycle_interval_sec: int):
    interval_sec = max(cycle_interval_sec, int(device.get("intervalSec") or cycle_interval_sec))
    last_check_at = previous.get("lastCheckAt") if previous else None
    if not last_check_at:
        return True
    try:
        last_dt = datetime.fromisoformat(str(last_check_at).replace("Z", "+00:00"))
    except ValueError:
        return True
    return (datetime.now(timezone.utc) - last_dt).total_seconds() >= interval_sec


def perform_cycle(max_workers: int, cycle_interval_sec: int):
    merged_payload = load_json(MERGED_PATH, {"items": []})
    status_payload = load_json(STATUS_PATH, {"items": []})
    merged_items = merged_payload.get("items") if isinstance(merged_payload, dict) else []
    status_items = status_payload.get("items") if isinstance(status_payload, dict) else []

    status_map = {make_status_key(item): item for item in status_items}
    monitored = []
    for item in (merged_items or []):
        if not item.get("monitorEnabled"):
            continue
        if not str(item.get("checkTarget") or item.get("ipAddress") or "").strip():
            continue
        previous = status_map.get(make_status_key(item))
        if is_due_for_check(item, previous, cycle_interval_sec):
            monitored.append(item)

    checked_at = now_iso()
    changed = False
    checked = 0
    failures = 0

    def task(device):
        return device, compute_combined_result(device)

    with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = [executor.submit(task, device) for device in monitored]
        for future in concurrent.futures.as_completed(futures):
            device, result = future.result()
            key = f"{device.get('source', 'local')}::{device.get('deviceId', '')}"
            previous = status_map.get(key)
            current = update_status_entry(previous, device, result, checked_at)
            status_map[key] = current
            checked += 1
            if not result["ok"]:
                failures += 1
            if status_changed(previous, current):
                changed = True

    next_status_items = sorted(status_map.values(), key=lambda item: (item.get("source", ""), item.get("deviceId", "")))
    atomic_write_json(STATUS_PATH, {"items": next_status_items})
    if changed:
        rebuild_merged()

    if checked == 0:
        runtime_status = "running"
        message = "暂无启用的检测设备"
    elif failures == 0:
        runtime_status = "running"
        message = f"本轮检测完成，{checked} 台设备全部正常"
    else:
        runtime_status = "warning"
        message = f"本轮检测完成，{checked} 台设备中 {failures} 台检测失败"

    emit({
        "status": runtime_status,
        "time": checked_at,
        "checked": checked,
        "failures": failures,
        "message": message,
    })


def handle_signal(_signum, _frame):
    global RUNNING
    RUNNING = False


def main():
    signal.signal(signal.SIGTERM, handle_signal)
    signal.signal(signal.SIGINT, handle_signal)

    payload = json.loads(sys.stdin.read() or "{}")
    input_payload = payload.get("input") if isinstance(payload, dict) and isinstance(payload.get("input"), dict) else payload
    interval_sec = max(5, int(input_payload.get("intervalSec") or 60))
    max_workers = max(1, int(input_payload.get("maxWorkers") or 10))

    emit({
        "status": "running",
        "time": now_iso(),
        "checked": 0,
        "failures": 0,
        "message": f"device availability watch started, interval={interval_sec}s, maxWorkers={max_workers}",
    })

    while RUNNING:
        try:
            perform_cycle(max_workers=max_workers, cycle_interval_sec=interval_sec)
        except Exception as error:
            emit({
                "status": "warning",
                "time": now_iso(),
                "checked": 0,
                "failures": 0,
                "message": f"检测循环异常: {error}",
            })

        for _ in range(interval_sec):
            if not RUNNING:
                break
            time.sleep(1)

    emit({
        "status": "stopped",
        "time": now_iso(),
        "checked": 0,
        "failures": 0,
        "message": "device availability watch stopped",
    })


if __name__ == "__main__":
    main()
