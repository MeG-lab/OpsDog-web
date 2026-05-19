# OpsDog Web

OpsDog Web 是面向运维场景的本地智能工作台，当前包含对话协助、MCP 工具接入、Skill 管理、即时/托管任务、设备资产、运行总览、报告和工单能力。

## 快速启动

```bash
npm install

# macOS / Linux
cp .env.example .env

# Windows PowerShell
Copy-Item .env.example .env

npm run dev:all
```

默认地址：

- Web：`http://127.0.0.1:4175/`
- API：`http://127.0.0.1:8788/`

常用命令：

```bash
npm run dev:server
npm run dev
npm run build
npm run package:test
```

## 文档入口

| 文档 | 用途 |
| --- | --- |
| [项目结构与架构](docs/PROJECT_STRUCTURE.md) | 面向开发者，说明目录、模块边界、架构图和核心数据流 |
| [当前问题与改进建议](docs/IMPROVEMENT_PLAN.md) | 说明现有问题、风险、优先级和改进路线 |
| [文档地图与维护规范](docs/DOCUMENTATION_GUIDE.md) | 说明项目还需要哪些文档，以及什么时候维护 |
| [部署指南](DEPLOY.md) | 面向测试和交付，说明环境、启动和排障 |
| [使用说明](使用说明.md) | 面向使用者，说明工作区和操作流程 |
