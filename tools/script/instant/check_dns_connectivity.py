#!/usr/bin/env python3
import json
import socket
import struct
import time

def ping_host(ip, timeout=2):
    """使用 ICMP socket 实现 ping 功能"""
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_RAW, socket.IPPROTO_ICMP)
        sock.settimeout(timeout)
        
        type_code = 8
        code = 0
        checksum = 0
        identifier = 12345
        sequence_number = 1
        
        data = b'test payload for connectivity check'
        header = struct.pack('!BBHHH', type_code, code, checksum, identifier, sequence_number)
        
        def calc_checksum(source):
            count = len(source)
            sum_val = 0
            countto = (count + 1) // 2
            format_str = '{}H'.format(countto)
            if count % 2:
                source += b'\x00'
            sum_val = struct.unpack(format_str, source)[0]
            while sum_val >> 16:
                sum_val = (sum_val & 0xFFFF) + (sum_val >> 16)
            return ~sum_val & 0xFFFF
        
        checksum = calc_checksum(header + data)
        header = struct.pack('!BBHHH', type_code, code, checksum, identifier, sequence_number)
        
        sock.sendto(header + data, (ip, 0))
        start_time = time.time()
        packet, addr = sock.recvfrom(1024)
        end_time = time.time()
        
        sock.close()
        return True, round((end_time - start_time) * 1000, 2)
        
    except socket.timeout:
        return False, None
    except OSError:
        return False, None
    except Exception:
        return False, None

def main():
    try:
        input_data = input().strip()
        data = json.loads(input_data) if input_data else {}
    except json.JSONDecodeError:
        data = {}
    
    target_ip = data.get('target_ip', '8.8.8.8')
    timeout = data.get('timeout', 2)
    
    success, latency = ping_host(target_ip, timeout)
    
    result = {
        'target': target_ip,
        'reachable': success,
        'latency_ms': latency,
        'status': 'success' if success else 'failed',
        'message': f'{target_ip} 可达，延迟 {latency}ms' if success else f'{target_ip} 不可达'
    }
    
    print(json.dumps(result))

if __name__ == '__main__':
    main()
