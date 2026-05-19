#!/usr/bin/env python3
import json
import socket
import time
from datetime import datetime, timezone

def check_connectivity(host, port, timeout=3):
    """检测主机连通性"""
    try:
        socket.create_connection((host, port), timeout=timeout)
        return True, None
    except socket.timeout:
        return False, "连接超时"
    except socket.gaierror as e:
        return False, f"DNS解析失败: {e}"
    except ConnectionRefusedError:
        return False, "连接被拒绝"
    except OSError as e:
        return False, f"网络错误: {e}"
    
def emit_event(level, status, message, ok, target, summary=None, data=None, errors=None):
    """输出JSON事件"""
    event = {
        "time": datetime.now(timezone.utc).isoformat(),
        "level": level,
        "status": status,
        "message": message,
        "ok": ok,
        "target": target,
        "summary": summary or message,
        "data": data or {},
        "errors": errors or []
    }
    print(json.dumps(event, ensure_ascii=False), flush=True)

def main():
    raw = sys.stdin.read()
    config = json.loads(raw) if raw.strip() else {}
    
    host = config.get("host", "8.8.8.8")
    port = config.get("port", 53)
    interval = config.get("interval", 5)
    timeout = config.get("timeout", 3)
    
    emit_event(
        level="info",
        status="running",
        message=f"开始监控 {host}:{port}，检测间隔 {interval}秒",
        ok=True,
        target=f"{host}:{port}",
        summary="监控任务启动",
        data={"interval": interval, "timeout": timeout}
    )
    
    last_status = None
    
    try:
        while True:
            ok, error = check_connectivity(host, port, timeout)
            current_time = datetime.now(timezone.utc).isoformat()
            
            if ok:
                if last_status == False:
                    # 从失败恢复
                    emit_event(
                        level="info",
                        status="recovered",
                        message=f"{host}:{port} 已恢复连接",
                        ok=True,
                        target=f"{host}:{port}",
                        summary="连通性恢复",
                        data={"timestamp": current_time}
                    )
                else:
                    emit_event(
                        level="info",
                        status="running",
                        message=f"{host}:{port} 连接正常",
                        ok=True,
                        target=f"{host}:{port}",
                        summary="连通性正常",
                        data={"timestamp": current_time}
                    )
                last_status = True
            else:
                if last_status != False:
                    # 首次失败
                    emit_event(
                        level="error",
                        status="error",
                        message=f"{host}:{port} 连接失败: {error}",
                        ok=False,
                        target=f"{host}:{port}",
                        summary="连通性中断",
                        errors=[error],
                        data={"timestamp": current_time}
                    )
                else:
                    # 持续失败
                    emit_event(
                        level="warning",
                        status="warning",
                        message=f"{host}:{port} 持续连接失败: {error}",
                        ok=False,
                        target=f"{host}:{port}",
                        summary="连通性问题持续",
                        errors=[error],
                        data={"timestamp": current_time}
                    )
                last_status = False
            
            time.sleep(interval)
            
    except KeyboardInterrupt:
        emit_event(
            level="info",
            status="running",
            message=f"监控任务已停止",
            ok=True,
            target=f"{host}:{port}",
            summary="任务正常退出"
        )

if __name__ == "__main__":
    main()
