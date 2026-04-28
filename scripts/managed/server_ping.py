#!/usr/bin/env python3
"""
Managed task: continuously ping one or more target hosts.

Examples:
  python scripts/managed/server_ping.py --targets 192.168.11.1 192.168.11.2 --interval 5
  python scripts/managed/server_ping.py --targets 192.168.11.1 --once
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Optional


RUNNING = True


def handle_stop_signal(signum: int, _frame) -> None:
    global RUNNING
    RUNNING = False
    print_event("info", f"received stop signal: {signum}, shutting down gracefully")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Managed multi-host ping monitor for AIops")
    parser.add_argument(
        "--targets",
        nargs="+",
        required=True,
        help="one or more host/IP targets to ping",
    )
    parser.add_argument("--interval", type=float, default=5.0, help="seconds between checks, default: 5")
    parser.add_argument("--timeout", type=float, default=1.5, help="ping timeout in seconds, default: 1.5")
    parser.add_argument("--log-file", help="optional log file path")
    parser.add_argument("--max-failures", type=int, default=3, help="consecutive failures before warning, default: 3")
    parser.add_argument("--once", action="store_true", help="run one check and exit")
    args = parser.parse_args()

    if args.interval <= 0:
        parser.error("--interval must be greater than 0")

    if args.timeout <= 0:
        parser.error("--timeout must be greater than 0")

    if args.max_failures <= 0:
        parser.error("--max-failures must be greater than 0")

    cleaned_targets = [target.strip() for target in args.targets if target.strip()]
    if not cleaned_targets:
        parser.error("at least one valid target is required")
    args.targets = cleaned_targets

    return args


def print_event(level: str, message: str, **extra) -> None:
    payload = {
        "time": datetime.now().isoformat(timespec="seconds"),
        "level": level,
        "message": message,
    }
    if extra:
        payload["data"] = extra
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def append_log(log_file: Optional[str], record: dict) -> None:
    if not log_file:
        return

    path = Path(log_file).expanduser()
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as fp:
        fp.write(json.dumps(record, ensure_ascii=False) + os.linesep)


def ping_target(target: str, timeout: float) -> tuple[bool, str]:
    if sys.platform == "darwin":
        timeout_ms = str(max(int(timeout * 1000), 500))
        command = ["ping", "-c", "1", "-W", timeout_ms, target]
    else:
        timeout_seconds = str(max(int(round(timeout)), 1))
        command = ["ping", "-c", "1", "-W", timeout_seconds, target]

    try:
        result = subprocess.run(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            check=False,
        )
    except FileNotFoundError:
        return False, f"ping command not available: {target}"
    except Exception as error:
        return False, f"ping execution failed: {target}, error={error}"

    if result.returncode == 0:
        return True, f"ping ok: {target}"

    error_text = (result.stderr or result.stdout or "").strip().replace("\n", " ")
    if not error_text:
        error_text = f"exit={result.returncode}"
    return False, f"ping failed: {target}, {error_text}"


def evaluate_targets(targets: list[str], timeout: float) -> tuple[bool, list[str], list[str], list[str]]:
    details: list[str] = []
    ok_targets: list[str] = []
    failed_targets: list[str] = []

    for target in targets:
        ok, message = ping_target(target, timeout)
        details.append(message)
        if ok:
            ok_targets.append(target)
        else:
            failed_targets.append(target)

    return len(failed_targets) == 0, details, ok_targets, failed_targets


def main() -> int:
    args = parse_args()

    signal.signal(signal.SIGINT, handle_stop_signal)
    signal.signal(signal.SIGTERM, handle_stop_signal)

    print_event(
        "info",
        "server_ping started",
        targets=args.targets,
        interval=args.interval,
        timeout=args.timeout,
        maxFailures=args.max_failures,
        once=args.once,
    )

    consecutive_failures = 0
    last_status: Optional[bool] = None

    while RUNNING:
        ok, details, ok_targets, failed_targets = evaluate_targets(args.targets, args.timeout)
        consecutive_failures = 0 if ok else consecutive_failures + 1

        if ok:
            if last_status is False:
                level = "recovered"
                message = "targets recovered"
            else:
                level = "running"
                message = "all targets reachable"
        else:
            level = "warning" if consecutive_failures >= args.max_failures else "attention"
            message = "target ping failed"

        record = {
            "time": datetime.now().isoformat(timespec="seconds"),
            "level": level,
            "message": message,
            "target": {
                "targets": args.targets,
                "okTargets": ok_targets,
                "failedTargets": failed_targets,
            },
            "details": details,
            "consecutiveFailures": consecutive_failures,
        }

        print(json.dumps(record, ensure_ascii=False), flush=True)
        append_log(args.log_file, record)
        last_status = ok

        if args.once:
            return 0 if ok else 1

        sleep_seconds = max(args.interval, 0.5)
        end_time = time.time() + sleep_seconds
        while RUNNING and time.time() < end_time:
            time.sleep(0.2)

    print_event("info", "server_ping stopped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
