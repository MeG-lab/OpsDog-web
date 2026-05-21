#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""OpenClaw skill: 阿里云语音通知拨打与结果查询。

能力：
1) 发起文本转语音通知（SingleCallByTts）
2) 按 CallId 查询通话详情（QueryCallDetailByCallId）

注意：
- 不在代码中硬编码 AK/SK，统一从环境变量读取。
- 内置最小间隔 + 限流错误重试，降低触发流控后的失败概率。
"""

import argparse
import json
import os
import threading
import time
import uuid
from dataclasses import dataclass
from typing import Any, Dict, Optional

from alibabacloud_dyvmsapi20170525.client import Client as DyvmsClient
from alibabacloud_dyvmsapi20170525 import models as dyvms_models
from alibabacloud_tea_openapi import models as open_api_models
from Tea.exceptions import TeaException


TTS_TEMPLATE_ID = "TTS_328555406"
REAL_CALLED_SHOW_NUMBER = "02131444167"
DEFAULT_EQUIPMENT_MAX_LENGTH = 15


class RateLimiter:
    """简单请求间隔限制器，避免短时间突发请求。"""

    def __init__(self, min_interval_seconds: float) -> None:
        self.min_interval_seconds = max(0.0, min_interval_seconds)
        self._lock = threading.Lock()
        self._last_call_time = 0.0

    def wait(self) -> None:
        with self._lock:
            now = time.monotonic()
            elapsed = now - self._last_call_time
            remain = self.min_interval_seconds - elapsed
            if remain > 0:
                time.sleep(remain)
            self._last_call_time = time.monotonic()


@dataclass
class RetryConfig:
    max_retries: int = 5
    base_backoff_seconds: float = 0.2


class AliyunVoiceSkill:
    def __init__(self) -> None:
        access_key_id = os.getenv("ALIBABA_CLOUD_ACCESS_KEY_ID")
        access_key_secret = os.getenv("ALIBABA_CLOUD_ACCESS_KEY_SECRET")
        security_token = os.getenv("ALIBABA_CLOUD_SECURITY_TOKEN")

        if not access_key_id or not access_key_secret:
            raise ValueError(
                "缺少环境变量 ALIBABA_CLOUD_ACCESS_KEY_ID / "
                "ALIBABA_CLOUD_ACCESS_KEY_SECRET"
            )

        config = open_api_models.Config(
            access_key_id=access_key_id,
            access_key_secret=access_key_secret,
            security_token=security_token,
        )
        config.endpoint = "dyvmsapi.aliyuncs.com"
        self.client = DyvmsClient(config)

        retry_times = int(os.getenv("ALIYUN_VOICE_MAX_RETRIES", "5"))
        base_backoff = float(os.getenv("ALIYUN_VOICE_BASE_BACKOFF_SECONDS", "0.2"))
        min_interval = float(os.getenv("ALIYUN_VOICE_REQUEST_INTERVAL_SECONDS", "0.01"))

        self.retry_config = RetryConfig(
            max_retries=max(0, retry_times),
            base_backoff_seconds=max(0.0, base_backoff),
        )
        self.rate_limiter = RateLimiter(min_interval_seconds=min_interval)

        env_max_len = os.getenv("EQUIPMENT_MAX_LENGTH")
        if env_max_len and env_max_len.isdigit():
            self.equipment_max_length = int(env_max_len)
        else:
            self.equipment_max_length = DEFAULT_EQUIPMENT_MAX_LENGTH

    def _is_throttle_error(self, err: TeaException) -> bool:
        code = str(getattr(err, "code", "") or "")
        message = str(getattr(err, "message", "") or "")
        text = f"{code} {message}".lower()
        keys = [
            "thrott",
            "frequency",
            "isv.business_limit_control",
            "quota",
            "ratelimit",
            "flow",
        ]
        return any(k in text for k in keys)

    def _with_retry(self, fn_name: str, fn) -> Any:
        for attempt in range(self.retry_config.max_retries + 1):
            self.rate_limiter.wait()
            try:
                return fn()
            except TeaException as err:
                if attempt >= self.retry_config.max_retries or not self._is_throttle_error(err):
                    raise
                sleep_seconds = self.retry_config.base_backoff_seconds * (2 ** attempt)
                time.sleep(sleep_seconds)
            except Exception:
                raise
        raise RuntimeError(f"{fn_name} 调用失败且超过重试次数")

    def _validate_equipment(self, equipment: str) -> str:
        if equipment is None:
            raise ValueError("equipment 不能为空")
        equipment = str(equipment).strip()
        if not equipment:
            raise ValueError("equipment 不能为空字符串")
        if len(equipment) > self.equipment_max_length:
            raise ValueError(
                f"equipment 长度不能超过 {self.equipment_max_length} 个字符，"
                f"当前长度为 {len(equipment)}"
            )
        return equipment

    def make_call(self, called_number: str, equipment: str, out_id: Optional[str] = None) -> Dict[str, Any]:
        if not called_number:
            raise ValueError("called_number 不能为空")

        equipment_value = self._validate_equipment(equipment)
        if not out_id:
            out_id = f"oc-{uuid.uuid4().hex[:24]}"

        tts_param = json.dumps({"equipment": equipment_value}, ensure_ascii=False)
        req = dyvms_models.SingleCallByTtsRequest(
            called_number=called_number,
            called_show_number=REAL_CALLED_SHOW_NUMBER,
            tts_code=TTS_TEMPLATE_ID,
            tts_param=tts_param,
            out_id=out_id,
        )

        resp = self._with_retry(
            "SingleCallByTts",
            lambda: self.client.single_call_by_tts(req),
        )

        body = getattr(resp, "body", None)
        return {
            "action": "make_call",
            "success": bool(body and body.code == "OK"),
            "code": getattr(body, "code", None),
            "message": getattr(body, "message", None),
            "request_id": getattr(body, "request_id", None),
            "call_id": getattr(body, "call_id", None),
            "out_id": out_id,
            "called_number": called_number,
            "called_show_number": REAL_CALLED_SHOW_NUMBER,
            "tts_code": TTS_TEMPLATE_ID,
            "tts_param": {"equipment": equipment_value},
        }

    def query_call(self, call_id: str) -> Dict[str, Any]:
        if not call_id:
            raise ValueError("call_id 不能为空")

        req = dyvms_models.QueryCallDetailByCallIdRequest(call_id=call_id)
        resp = self._with_retry(
            "QueryCallDetailByCallId",
            lambda: self.client.query_call_detail_by_call_id(req),
        )

        body = getattr(resp, "body", None)
        data_raw = getattr(body, "data", None)
        data_json = None
        if isinstance(data_raw, str) and data_raw:
            try:
                data_json = json.loads(data_raw)
            except Exception:
                data_json = None

        return {
            "action": "query_call",
            "success": bool(body and body.code == "OK"),
            "code": getattr(body, "code", None),
            "message": getattr(body, "message", None),
            "request_id": getattr(body, "request_id", None),
            "call_id": call_id,
            "data_raw": data_raw,
            "data": data_json,
        }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="OpenClaw 阿里云语音通知技能")
    sub = parser.add_subparsers(dest="command", required=True)

    p_call = sub.add_parser("make_call", help="发起语音通知")
    p_call.add_argument("--called-number", required=True, help="被叫号码")
    p_call.add_argument("--equipment", required=True, help="模板变量 equipment")
    p_call.add_argument("--out-id", required=False, help="可选业务流水号")

    p_query = sub.add_parser("query_call", help="查询通话详情")
    p_query.add_argument("--call-id", required=True, help="通话 CallId")

    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    skill = AliyunVoiceSkill()

    if args.command == "make_call":
        result = skill.make_call(
            called_number=args.called_number,
            equipment=args.equipment,
            out_id=args.out_id,
        )
    elif args.command == "query_call":
        result = skill.query_call(call_id=args.call_id)
    else:
        raise ValueError(f"未知命令: {args.command}")

    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
