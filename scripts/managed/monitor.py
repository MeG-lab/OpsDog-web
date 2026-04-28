#!/usr/bin/env python3
"""
System Monitor Script - AIops
Collects system performance metrics: CPU, memory, disk, and network.
"""

import json
import sys
import platform
import os
from datetime import datetime

def get_system_info():
    """Get basic system information."""
    return {
        "hostname": platform.node(),
        "os": platform.system(),
        "os_version": platform.version(),
        "architecture": platform.machine(),
        "python_version": platform.python_version(),
        "timestamp": datetime.now().isoformat(),
    }

def get_cpu_info():
    """Get CPU information."""
    try:
        import psutil
        cpu_percent = psutil.cpu_percent(interval=1, percpu=True)
        cpu_freq = psutil.cpu_freq()
        return {
            "usage_per_core": cpu_percent,
            "average_usage": sum(cpu_percent) / len(cpu_percent) if cpu_percent else 0,
            "core_count": psutil.cpu_count(logical=False),
            "thread_count": psutil.cpu_count(logical=True),
            "frequency_mhz": cpu_freq.current if cpu_freq else None,
        }
    except ImportError:
        return {
            "error": "psutil not installed. Run: pip install psutil",
            "core_count": os.cpu_count(),
        }

def get_memory_info():
    """Get memory usage information."""
    try:
        import psutil
        mem = psutil.virtual_memory()
        swap = psutil.swap_memory()
        return {
            "total_gb": round(mem.total / (1024 ** 3), 2),
            "used_gb": round(mem.used / (1024 ** 3), 2),
            "available_gb": round(mem.available / (1024 ** 3), 2),
            "usage_percent": mem.percent,
            "swap_total_gb": round(swap.total / (1024 ** 3), 2),
            "swap_used_gb": round(swap.used / (1024 ** 3), 2),
            "swap_percent": swap.percent,
        }
    except ImportError:
        return {"error": "psutil not installed. Run: pip install psutil"}

def get_disk_info():
    """Get disk usage information."""
    try:
        import psutil
        disks = []
        for partition in psutil.disk_partitions(all=False):
            try:
                usage = psutil.disk_usage(partition.mountpoint)
                disks.append({
                    "device": partition.device,
                    "mountpoint": partition.mountpoint,
                    "fs_type": partition.fstype,
                    "total_gb": round(usage.total / (1024 ** 3), 2),
                    "used_gb": round(usage.used / (1024 ** 3), 2),
                    "free_gb": round(usage.free / (1024 ** 3), 2),
                    "usage_percent": round(usage.percent, 1),
                })
            except (PermissionError, OSError):
                continue
        return disks
    except ImportError:
        return [{"error": "psutil not installed. Run: pip install psutil"}]

def main():
    """Main entry point."""
    result = {
        "status": "ok",
        "system": get_system_info(),
        "cpu": get_cpu_info(),
        "memory": get_memory_info(),
        "disks": get_disk_info(),
    }

    # Output as JSON
    print(json.dumps(result, indent=2, ensure_ascii=False))

if __name__ == "__main__":
    main()
