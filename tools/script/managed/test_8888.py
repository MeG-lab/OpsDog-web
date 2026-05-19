#!/usr/bin/env python3
import json
import socket
import time
import sys
from datetime import datetime, timezone

def check_connectivity(host, port, timeout=3):
    """测试主机连通性"""
    try:
        socket.create_connection((host, port), timeout=timeout)
        return True, None
    except socket.timeout:
        return False, "连接超时"
    except socket.gaierror:
        return False, "DNS解析失败"
    except ConnectionRefusedError:
        return False, "连接被拒绝"
    except OSError as e:
        return False, f"网络错误: {str(e)}"
    except Exception as e:
        return False, f"未知错误: {str(e)}"

def main():
    raw = sys.stdin.read()
    payload = json.loads(raw) if raw.strip() else {}
    
    host = payload.get('host', '8.8.8.8')
    port = payload.get('port', 53)
    interval = payload.get('interval', 5)
    timeout = payload.get('timeout', 3)
    
    while True:
        success, error_msg = check_connectivity(host, port, timeout)
        
        event = {
            'time': datetime.now(timezone.utc).isoformat(),
            'level': 'info' if success else 'error',
            'status': 'running',
            'ok': success,
            'target': f'{host}:{port}',
            'summary': '连接成功' if success else f'连接失败: {error_msg}',
            'data': {
                'host': host,
                'port': port,
                'timeout': timeout
            },
            'errors': [] if success else [error_msg]
        }
        
        print(json.dumps(event, ensure_ascii=False), flush=True)
        
        time.sleep(interval)

if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)
