#!/usr/bin/env python3
"""
Managed task demo: watch a process name or TCP port on a fixed interval.

Examples:
  python scripts/managed/service_watchdog.py --process python --interval 5
  python scripts/managed/service_watchdog.py --host 127.0.0.1 --port 3000 --interval 3
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import socket
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
    parser = argparse.ArgumentParser(description="Managed service watchdog for AIops")
    parser.add_argument("--process", help="process name to watch, for example nginx or python")
    parser.add_argument("--host", default="127.0.0.1", help="target host for TCP check, default: 127.0.0.1")
    parser.add_argument("--port", type=int, help="target TCP port to watch")
    parser.add_argument("--interval", type=float, default=5.0, help="seconds between checks, default: 5")
    parser.add_argument("--timeout", type=float, default=2.0, help="socket timeout in seconds, default: 2")
    parser.add_argument("--log-file", help="optional log file path")
    parser.add_argument("--max-failures", type=int, default=3, help="consecutive failures before warning, default: 3")
    parser.add_argument("--once", action="store_true", help="run one check and exit")
    args = parser.parse_args()

    if not args.process and not args.port:
        parser.error("at least one of --process or --port is required")

    if args.interval <= 0:
        parser.error("--interval must be greater than 0")

    if args.timeout <= 0:
        parser.error("--timeout must be greater than 0")

    if args.max_failures <= 0:
        parser.error("--max-failures must be greater than 0")

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


def check_process(process_name: str) -> tuple[bool, str]:
    try:
        result = subprocess.run(
            ["pgrep", "-f", process_name],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            check=False,
        )
    except FileNotFoundError:
        return False, "pgrep not available on this system"

    if result.returncode == 0 and result.stdout.strip():
        pids = [line.strip() for line in result.stdout.splitlines() if line.strip()]
        return True, f"process matched, pid count={len(pids)}"

    return False, "process not found"


def check_port(host: str, port: int, timeout: float) -> tuple[bool, str]:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True, f"tcp connect ok: {host}:{port}"
    except OSError as error:
        return False, f"tcp connect failed: {host}:{port}, error={error}"


def evaluate_target(args: argparse.Namespace) -> tuple[bool, list[str]]:
    messages: list[str] = []
    ok = True

    if args.process:
        process_ok, process_message = check_process(args.process)
        ok = ok and process_ok
        messages.append(process_message)

    if args.port:
        port_ok, port_message = check_port(args.host, args.port, args.timeout)
        ok = ok and port_ok
        messages.append(port_message)

    return ok, messages


def main() -> int:
    args = parse_args()

    signal.signal(signal.SIGINT, handle_stop_signal)
    signal.signal(signal.SIGTERM, handle_stop_signal)

    print_event(
        "info",
        "service_watchdog started",
        process=args.process,
        host=args.host,
        port=args.port,
        interval=args.interval,
        maxFailures=args.max_failures,
        once=args.once,
    )

    consecutive_failures = 0
    last_status: Optional[bool] = None

    while RUNNING:
        ok, messages = evaluate_target(args)
        consecutive_failures = 0 if ok else consecutive_failures + 1

        if ok:
            if last_status is False:
                level = "recovered"
                message = "service recovered"
            else:
                level = "running"
                message = "service healthy"
        else:
            level = "warning" if consecutive_failures >= args.max_failures else "attention"
            message = "service check failed"

        record = {
            "time": datetime.now().isoformat(timespec="seconds"),
            "level": level,
            "message": message,
            "target": {
                "process": args.process,
                "host": args.host,
                "port": args.port,
            },
            "details": messages,
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

    print_event("info", "service_watchdog stopped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
