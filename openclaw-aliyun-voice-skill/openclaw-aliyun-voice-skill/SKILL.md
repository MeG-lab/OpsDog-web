---
name: aliyun-voice-notify
summary: 使用阿里云 SingleCallByTts 拨打语音通知并查询通话结果。
---

# 阿里云语音通知技能

此技能提供两个动作：
- `make_call`：发起语音通知，返回 `CallId`
- `query_call`：根据 `CallId` 查询通话结果

## 固定业务参数

- 模板 ID：`TTS_328555406`
- 模板变量：`${equipment}`（由调用方传入）
- 真实号码（被叫显号）：`02131444167`

## 使用前准备

1. 安装依赖：

```bash
pip install -r openclaw-aliyun-voice-skill/requirements.txt
```

2. 配置环境变量（不要写入代码）：

```bash
export ALIBABA_CLOUD_ACCESS_KEY_ID="<你的AK>"
export ALIBABA_CLOUD_ACCESS_KEY_SECRET="<你的SK>"
```

可选：
- `ALIBABA_CLOUD_SECURITY_TOKEN`
- `ALIYUN_VOICE_MAX_RETRIES`
- `ALIYUN_VOICE_BASE_BACKOFF_SECONDS`
- `ALIYUN_VOICE_REQUEST_INTERVAL_SECONDS`
- `EQUIPMENT_MAX_LENGTH`

## 调用方式

### 1) 拨打电话

```bash
python openclaw-aliyun-voice-skill/aliyun_voice_skill.py \
  make_call \
  --called-number "13800138000" \
  --equipment "3号空压机"
```

### 2) 查询拨打结果

```bash
python openclaw-aliyun-voice-skill/aliyun_voice_skill.py \
  query_call \
  --call-id "116012354148^10281378****"
```

## 流控与重试说明

- 技能内置请求最小间隔限制（默认 `0.01s`）。
- 识别到限流相关错误（如 `BUSINESS_LIMIT_CONTROL` / `throttling`）时，会指数退避重试。
- 默认重试 `5` 次，可通过 `ALIYUN_VOICE_MAX_RETRIES` 调整。

## 安全说明

- AK/SK 仅从环境变量读取，适合分发给不同使用者。
- 不会在源码中硬编码任何使用者凭据。
