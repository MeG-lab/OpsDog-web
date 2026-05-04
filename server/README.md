# OpsDog Backend

当前后端是前后端分离工程的进行中骨架。

已接入：

- `/api/health`
- `/api/chat`
- `/api/chat/stream`
- `/api/models`
- `/api/mcp/connect`
- `/api/mcp/disconnect`
- `/api/mcp/status`
- `/api/mcp/tools`
- `/api/mcp/call`
- `/api/tasks`
- `/api/tasks/start`
- `/api/tasks/restart`
- `/api/tasks/stop`
- `/api/tasks/restore`
- `/api/skills/execute`

已预留但尚未落地：

- 更完整的任务治理与日志能力

说明：

- MCP 当前已支持：
  - `streamable-http`
  - `stdio`（最小可用子进程托管）
- `stdio` 后续仍需继续补：
  - 更细的日志采集
  - 重连 / 重启策略
  - 更强的进程治理
  - 更完整的超时和错误分类
- 托管任务和即时 Skill 执行当前通过 `python3` 拉起本地脚本

本地启动：

```bash
npm run dev:server
```
