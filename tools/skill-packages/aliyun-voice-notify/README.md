# OpenClaw 阿里云语音通知技能

## 目标

- 调用 `SingleCallByTts` 拨打语音通知
- 调用 `QueryCallDetailByCallId` 查询通话结果

## 约束已内置

- 模板 ID 固定为：`TTS_328555406`
- 模板变量：`equipment`
- 被叫显号固定为：`02131444167`
- `equipment` 默认长度上限：15（可通过环境变量调大/调小）

## 快速开始

```bash
pip install -r openclaw-aliyun-voice-skill/requirements.txt
cp openclaw-aliyun-voice-skill/.env.example .env
```

然后按 `.env.example` 配置环境变量后调用：

```bash
python openclaw-aliyun-voice-skill/aliyun_voice_skill.py make_call --called-number "13800138000" --equipment "3号空压机"
```

返回里会包含 `call_id`，再调用：

```bash
python openclaw-aliyun-voice-skill/aliyun_voice_skill.py query_call --call-id "<上一步返回的call_id>"
```

## 重要提示

`equipment` 的准确长度限制受你的阿里云模板审核规则影响。如果实际限制不是 15，请设置：

```bash
export EQUIPMENT_MAX_LENGTH="<实际长度上限>"
```
