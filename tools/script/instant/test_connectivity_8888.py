#!/usr/bin/env python3
import json
import socket
import sys

def test_connectivity():
    """测试 8.8.8.8 连通性"""
    host = "8.8.8.8"
    ports = [53]  # DNS 端口
    timeout = 3
    
    results = {
        "ok": False,
        "status": "error",
        "summary": "",
        "data": {},
        "highlights": [],
        "errors": []
    }
    
    for port in ports:
        try:
            socket.create_connection((host, port), timeout=timeout)
            results["data"][f"port_{port}"] = "reachable"
            results["highlights"].append(f"端口 {port} 连通正常")
        except Exception as e:
            results["data"][f"port_{port}"] = "unreachable"
            results["errors"].append(f"端口 {port} 连通失败: {str(e)}")
    
    if results["data"] and all("reachable" in str(v) for v in results["data"].values()):
        results["ok"] = True
        results["status"] = "success"
        results["summary"] = "8.8.8.8 网络连通正常"
    else:
        results["status"] = "error"
        results["summary"] = "8.8.8.8 网络连通异常"
    
    return results

if __name__ == "__main__":
    raw = sys.stdin.read()
    payload = json.loads(raw) if raw.strip() else {}
    result = test_connectivity()
    print(json.dumps(result, ensure_ascii=False))
