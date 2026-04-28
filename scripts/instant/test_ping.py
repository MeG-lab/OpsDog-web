import datetime
import os
import subprocess
import sys


SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PING_FILE = os.path.join(SCRIPT_DIR, "ping.txt")


def ping_host(ip: str) -> bool:
    """测试指定 IP 的连通性。"""
    param = "-n" if sys.platform.lower().startswith("win") else "-c"
    command = ["ping", param, "1", ip]

    try:
        response = subprocess.run(
            command,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=2,
            check=False,
        )
        return response.returncode == 0
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return False


def read_hosts_file(filename: str):
    """读取主机名称和 IP 列表。"""
    hosts = []
    try:
        with open(filename, "r", encoding="utf-8") as file:
            for line in file:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue

                parts = line.split()
                if len(parts) >= 2:
                    hosts.append((parts[0], parts[1]))

        return hosts
    except FileNotFoundError:
        print(f"错误：找不到文件 {filename}")
        return None


def main():
    hosts = read_hosts_file(PING_FILE)
    if hosts is None:
        return 1

    if not hosts:
        print("错误：ping.txt 中没有可测试的目标")
        return 1

    success_count = 0
    failure_count = 0
    time_str = datetime.datetime.now().strftime("%Y年%m月%d日")

    for hostname, ip in hosts:
        success = ping_host(ip)
        status = "测试成功" if success else "测试失败"
        print(f"{status} 时间：{time_str} {hostname} {ip}")

        if success:
            success_count += 1
        else:
            failure_count += 1

    print("")
    print(f"统计：成功 {success_count}，失败 {failure_count}，总数 {len(hosts)}")
    return 0 if failure_count == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
