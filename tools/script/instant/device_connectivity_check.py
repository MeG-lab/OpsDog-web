import sys, json, subprocess, platform

raw = sys.stdin.read()
payload = json.loads(raw) if raw.strip() else {}

devices = payload.get("devices", [
    {"name": "核心交换机", "ip": "172.17.255.6"},
    {"name": "华为无线AC", "ip": "172.19.255.142"},
    {"name": "锐捷无线AC", "ip": "1.1.1.1"},
    {"name": "用户自主服务系统", "ip": "172.16.250.38"},
    {"name": "一卡通门禁管理", "ip": "192.168.220.121"},
    {"name": "城市热点后台管理系统", "ip": "172.16.250.39"},
    {"name": "华为esight管理平台", "ip": "172.16.15.98"},
    {"name": "出口防火墙", "ip": "172.17.255.2"},
    {"name": "数据中心山石防火墙", "ip": "172.16.250.250"},
    {"name": "IPS", "ip": "172.16.250.241"},
    {"name": "爱数备份系统", "ip": "172.16.250.127"},
    {"name": "public1.alidns.com", "ip": "223.5.5.5"},
    {"name": "网站群苏迪(IP1)", "ip": "192.168.41.30"},
    {"name": "图书馆应用服务器", "ip": "192.168.127.114"},
    {"name": "图书馆数据库服务器", "ip": "192.168.127.111"},
    {"name": "DNS服务器1", "ip": "211.70.24.8"},
    {"name": "DNS服务器2", "ip": "211.70.24.9"},
    {"name": "财务经费管理(远程桌面)", "ip": "172.16.250.129"},
    {"name": "琴房管理系统", "ip": "172.16.250.238"},
    {"name": "高职状态数据平台校内端", "ip": "192.168.127.58"}
])

timeout = int(payload.get("timeout", 2))
count = int(payload.get("count", 1))

results = []
reachable_count = 0
unreachable_count = 0

for device in devices:
    name = device.get("name", "Unknown")
    ip = device.get("ip", "")
    
    if not ip:
        results.append({
            "name": name,
            "ip": ip,
            "ok": False,
            "reachable": False,
            "error": "IP地址为空"
        })
        unreachable_count += 1
        continue
    
    try:
        if platform.system() == 'Windows':
            ping_args = ["ping", "-n", str(count), "-w", str(timeout * 1000), ip]
        else:
            ping_args = ["ping", "-c", str(count), "-W", str(timeout), ip]
        result = subprocess.run(ping_args, capture_output=True, timeout=timeout + 2)
        
        reachable = result.returncode == 0
        
        if reachable:
            reachable_count += 1
        else:
            unreachable_count += 1
        
        results.append({
            "name": name,
            "ip": ip,
            "ok": reachable,
            "reachable": reachable
        })
        
    except subprocess.TimeoutExpired:
        results.append({
            "name": name,
            "ip": ip,
            "ok": False,
            "reachable": False,
            "error": "检测超时"
        })
        unreachable_count += 1
    except Exception as e:
        results.append({
            "name": name,
            "ip": ip,
            "ok": False,
            "reachable": False,
            "error": str(e)
        })
        unreachable_count += 1

total = len(results)
all_ok = unreachable_count == 0

if all_ok:
    status = "success"
elif reachable_count > 0:
    status = "warning"
else:
    status = "error"

output = {
    "ok": all_ok,
    "status": status,
    "summary": f"检测完成: 共{total}台设备, 可达{reachable_count}台, 不可达{unreachable_count}台",
    "data": {
        "total": total,
        "reachable": reachable_count,
        "unreachable": unreachable_count,
        "results": results
    }
}

print(json.dumps(output, ensure_ascii=False), flush=True)
