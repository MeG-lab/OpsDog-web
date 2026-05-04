# OpsDog Web

OpsDog Web 是一个面向运维场景的智能工作台。

它把几类常用能力放在同一个界面里：

- 对话式任务协助
- 任务执行与托管
- MCP 工具接入
- Skill 能力管理
- 运行总览与状态查看

## 当前状态

项目已经完成 Web-first 重构，当前形态是：

- `src/`：前端界面
- `server/`：本地后端桥接
- `skills/`：Skill 定义
- `scripts/`：脚本与执行模板

目前聊天、模型列表、MCP、托管任务、即时执行都已经接入后端第一版能力。

## 本地启动

先安装依赖：

```bash
npm install
```

分别启动前后端：

```bash
npm run dev:server
npm run dev
```

也可以直接一起启动：

```bash
npm run dev:all
```

默认本地地址：

- 前端：`http://127.0.0.1:4173/`
- 后端：`http://127.0.0.1:8787/`

## 本地配置

复制一份环境文件：

```bash
cp .env.example .env
```

常用配置项：

```bash
OPSDOG_WEB_ORIGIN=http://127.0.0.1:4173
OPSDOG_SERVER_ORIGIN=http://127.0.0.1:8787
VITE_API_BASE_URL=/api
```

## 构建

```bash
npm run build
```

## 适合用来做什么

如果你想验证下面这些能力，这个项目现在已经具备基础链路：

- 对话调用后端模型
- 接入 MCP 工具
- 上传和管理任务脚本
- 托管任务运行与状态查看
- 在总览页查看当前运行态
