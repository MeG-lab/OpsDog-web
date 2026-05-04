# service_watchdog

- 脚本：`scripts/managed/service_watchdog.py`
- 用途：持续检测端口或进程状态
- 默认参数来源：`skill.yaml` 的 `default_args`

命中端口值守或进程值守需求时，优先启动托管任务，并基于最近日志回答状态。
