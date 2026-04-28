# 托管任务输出规范 v1

这个文档定义 AIops 中“托管任务”脚本的最小输出规范，目标是让前端展示、对话查询、异常提示都能基于统一结构工作。

## 适用范围

- 适用于 `scripts/managed/` 目录下的持续运行脚本
- 适用于通过 `task_kind: managed` 暴露给系统的 Skill

即时任务可以输出普通文本，但托管任务建议统一按本规范输出。

## 输出原则

1. 每一行输出一条独立 JSON
2. 每条 JSON 表示一次状态事件或运行事件
3. 推荐持续输出，便于系统追踪状态变化
4. 建议使用 UTF-8 编码输出

## 最小字段

每条 JSON 至少应包含以下字段：

```json
{
  "time": "2026-04-25T00:11:28",
  "level": "recovered",
  "message": "service recovered"
}
```

字段说明：

- `time`
  事件发生时间，推荐 ISO 8601 格式
- `level`
  事件级别，用于系统判断状态
- `message`
  简洁的人类可读摘要

## 推荐字段

建议托管任务尽量补充以下字段：

```json
{
  "time": "2026-04-25T00:11:28",
  "level": "recovered",
  "message": "service recovered",
  "target": {
    "process": null,
    "host": "127.0.0.1",
    "port": 7001
  },
  "details": [
    "tcp connect ok: 127.0.0.1:7001"
  ],
  "consecutiveFailures": 0
}
```

推荐字段说明：

- `target`
  当前检测对象，比如主机、端口、进程名、服务名
- `details`
  补充说明，建议使用字符串数组
- `consecutiveFailures`
  连续失败次数，适合做告警升级

## level 约定

建议统一使用以下值：

- `info`
  普通系统信息，比如启动、停止
- `running`
  当前健康，运行正常
- `attention`
  检测失败，但还没升级成告警
- `warning`
  连续失败，进入告警态
- `recovered`
  从异常恢复到正常
- `error`
  脚本自身异常或任务异常退出

## 系统行为建议

系统会优先根据 `level` 来做统一处理：

- `running`
  前端显示为“运行中”
- `attention`
  前端显示为“需关注”
- `warning`
  前端显示为“告警中”
- `recovered`
  前端显示为“已恢复”
- `error`
  前端显示为“异常退出”

因此新托管脚本应尽量遵循这个级别体系，不要随意发明新的状态词。

## 日志建议

- `message` 尽量简短，适合列表和顶栏提示
- 详细说明放到 `details`
- 避免把大段非结构化文本塞进单条消息
- 如果输出频率较高，建议保持每条日志信息密度低一些

## 示例

### 启动

```json
{"time":"2026-04-25T00:10:49","level":"info","message":"service_watchdog started"}
```

### 正常运行

```json
{"time":"2026-04-25T00:10:52","level":"running","message":"service healthy","target":{"host":"127.0.0.1","port":7001},"details":["tcp connect ok: 127.0.0.1:7001"],"consecutiveFailures":0}
```

### 异常

```json
{"time":"2026-04-25T00:11:10","level":"attention","message":"service check failed","target":{"host":"127.0.0.1","port":7001},"details":["tcp connect failed: 127.0.0.1:7001"],"consecutiveFailures":1}
```

### 告警

```json
{"time":"2026-04-25T00:11:16","level":"warning","message":"service check failed","target":{"host":"127.0.0.1","port":7001},"details":["tcp connect failed: 127.0.0.1:7001"],"consecutiveFailures":3}
```

### 恢复

```json
{"time":"2026-04-25T00:11:28","level":"recovered","message":"service recovered","target":{"host":"127.0.0.1","port":7001},"details":["tcp connect ok: 127.0.0.1:7001"],"consecutiveFailures":0}
```
