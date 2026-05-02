# 项目结构说明书

本文档面向当前 `OpsDog-Web` 仓库，目标是帮助后续开发者快速理解：

1. 当前代码目录与文件职责
2. 当前代码存在的问题
3. 后续优化应修改哪些内容
4. 新功能进入代码库时，建议以什么方式组织

---

## 板块一：当前代码目录和文件功能

### 1. 项目根目录

#### `package.json`
- 前端项目依赖与脚本入口。
- 当前主命令已经是纯 Web：
  - `npm run dev`
  - `npm run build`

#### `package-lock.json`
- 依赖锁文件。
- 用于固定安装版本，避免环境漂移。

#### `vite.config.ts`
- Vite 构建配置。
- 当前是 Web-first 配置，负责本地开发服务器和打包行为。

#### `tsconfig.json` / `tsconfig.node.json`
- TypeScript 编译配置。
- 前者服务浏览器端代码，后者服务 Vite/Node 侧配置文件。

#### `README.md`
- 项目启动说明和 Web-first 运行方式说明。

#### `docs/`
- 文档目录。
- 建议后续所有架构说明、迁移计划、接口设计、模块说明都放在这里。

#### `design/`
- 设计资产和图标概念稿。
- 不参与运行时逻辑。

#### `public/`
- Vite 原样拷贝到构建产物的静态资源。

#### `dist/`
- 打包产物目录。
- 不是源码，不建议手工修改。

#### `node_modules/`
- 依赖安装目录。
- 不是源码，不建议纳入结构分析或业务改动。

---

### 2. 业务源码目录 `src/`

#### `src/main.tsx`
- React 应用入口。
- 负责挂载根组件。

#### `src/App.tsx`
- 应用主壳。
- 负责组织：
  - 侧边栏
  - 顶栏
  - 聊天工作区
  - 脚本工作区
- 也承担一部分全局副作用：
  - 初始化 store
  - 托管任务恢复
  - 托管任务状态轮询和系统通告写入

#### `src/index.css`
- 全局样式文件。
- 包含页面布局、通用组件样式、工具面板样式、聊天样式等。

#### `src/vite-env.d.ts`
- Vite 环境类型声明。

---

### 3. 组件目录 `src/components/`

#### 顶层组件

##### `src/components/Sidebar.tsx`
- 左侧导航区。
- 负责：
  - 工作区切换（对话 / 脚本）
  - 对话历史列表
  - 系统通告入口

##### `src/components/TopBar.tsx`
- 顶栏。
- 负责：
  - 页面标题
  - 主题切换
  - 设置弹层
  - 工具集成弹层
  - 托管任务运行摘要

---

### 4. 聊天相关组件 `src/components/Chat/`

这部分是当前项目最稳定的一条主流程。

#### `ChatArea.tsx`
- 聊天区域总容器。
- 组织消息列表和输入区。

#### `InputArea.tsx`
- 聊天输入核心逻辑文件。
- 当前承担职责较多，包括：
  - 发送消息
  - 流式消息接收
  - 本地输入路由判断
  - Skill 说明注入
  - MCP 工具调用规划
  - 托管任务问答分流

这是当前项目中最值得持续拆分的文件之一。

#### `MessageList.tsx`
- 消息列表渲染。

---

### 5. 脚本工作区 `src/components/Scripts/`

#### `ScriptsWorkspace.tsx`
- 当前脚本能力主界面。
- 负责：
  - 展示 Skills
  - 区分即时任务 / 托管任务
  - 编辑托管任务配置
  - 触发即时任务执行
  - 触发托管任务启动/停止/重启
- 它是保留的主骨架，不再建议另起第二套脚本面板。

---

### 6. 工具与设置面板 `src/components/panels/`

#### `SettingsPanel.tsx`
- 当前唯一有效的设置面板。
- 负责：
  - 模型配置管理
  - 模型列表获取
  - 背景设置

#### `ToolsPanel.tsx`
- 当前唯一有效的工具集成面板。
- 负责两块能力：
  - Skills：读取、启用、说明/标签编辑
  - MCP：Server 配置、状态、工具调用入口

---

### 7. 服务层 `src/services/`

#### `contracts.ts`
- 前后端共享的数据契约类型。
- 当前主要用于聊天请求、聊天响应、模型列表请求。
- 后续如果接入 Web backend，建议继续在这里扩展接口输入输出类型。

#### `persistence.ts`
- 配置和会话持久化服务。
- 当前以浏览器本地存储为主，并提供统一持久化入口。

#### `skillsMatcher.ts`
- Skill 匹配相关逻辑。
- 当前仍有一部分逻辑散落在 `InputArea.tsx`，后续应进一步收口。

---

### 8. 运行时目录 `src/services/runtime/`

这是当前 Web 版的能力抽象层，也是纯 Web 架构里最关键的目录之一。

#### `index.ts`
- runtime 对外统一出口。
- 页面和业务逻辑只应通过这里调用能力。

#### `types.ts`
- runtime 能力接口定义。
- 用来描述“前端认为系统能做什么”。

#### `webRuntime.ts`
- Web 运行时具体实现。
- 当前已经实现：
  - 聊天请求
  - 模型列表获取
  - 本地配置持久化
  - 本地会话持久化
  - Skills 元数据读取
- 当前仍未完全实现：
  - MCP 真连接
  - MCP 工具真实执行
  - 托管任务执行链
  - 即时 Skill 服务端执行链

#### `webRouting.ts`
- 聊天输入的本地路由判断逻辑。
- 负责风险拦截、Skill 目录意图、托管任务查询等前置分流。

#### `webSkills.ts`
- 项目内置 Skills 的读取与覆盖层管理。
- 当前通过打包时的静态文件收集来读取：
  - `skills/*/skill.yaml`
  - `skills/*/instructions.md`

---

### 9. 状态管理 `src/stores/`

#### `src/stores/index.ts`
- 当前唯一 store 文件。
- 负责两类状态：
  - `useAppStore`：全局 UI、模型、MCP、Skills、托管配置
  - `useChatStore`：会话、消息、流式状态、系统通告

它已经是当前应用的状态中枢。

问题也很明显：文件偏大，职责聚合较重。

---

### 10. 类型目录 `src/types/`

#### `src/types/index.ts`
- 项目公共类型定义中心。
- 包含：
  - 会话与消息
  - 模型配置
  - Skills
  - MCP
  - 托管任务
  - 审计相关类型（目前前端 UI 已下线，但类型仍可能为未来保留）

---

### 11. 资源与样例目录

#### `skills/`
- 项目内置 Skill 定义目录。
- 每个 Skill 通常包含：
  - `skill.yaml`
  - `instructions.md`

当前示例：
- `ping_checker`
- `server_ping`
- `service_watchdog`

#### `scripts/`
- 历史脚本样例目录。
- 当前更多是示例资源，不再代表浏览器端直接执行路径。
- 后续如果保留，应把它明确视为“服务端任务模板来源”或“开发样例”。

---

## 板块二：当前代码存在的问题、后续优化方向、以及新功能如何进入代码

### 一、当前代码存在的问题

#### 1. 纯 Web 化已经完成，但能力层还没补实

当前项目已经完成：
- 去 Tauri 化
- 去桌面端壳
- 去本地解释器心智
- 去重复面板和半成品入口

但以下能力仍然是“前端保留了骨架，后端尚未真正实现”：
- MCP Server 连接
- MCP 工具真实执行
- 托管任务启动/停止/重启/状态持久化
- 即时 Skill 执行

这意味着：
- UI 已经纯 Web
- 产品能力还没有完全纯 Web

#### 2. `InputArea.tsx` 职责过重

当前 [src/components/Chat/InputArea.tsx](/Users/meteor/Code/OpsDog-Web/src/components/Chat/InputArea.tsx:1) 同时承担：
- 输入控制
- 模型请求
- 路由分流
- MCP 规划
- 托管任务问答
- Skill 说明拼接

问题：
- 改一个点容易牵动聊天主链路
- 测试难度高
- 后续接 Web backend 时会越来越重

#### 3. `stores/index.ts` 体量偏大

当前 store 文件同时管理：
- UI 状态
- 模型配置
- MCP 配置
- Skills
- 会话
- 消息
- 初始化逻辑

问题：
- 状态关注点不够清晰
- 后续多人开发时容易冲突

#### 4. Runtime 接口已成型，但边界还可以更清楚

当前 runtime 已经很好地承担了“能力抽象层”的角色。  
但仍需进一步明确：

- 哪些能力是前端本地实现
- 哪些能力必须走 Web backend
- 哪些能力只是保留接口，暂未开放给 UI

#### 5. `ToolsPanel.tsx` 仍然偏厚

它现在同时负责：
- Skills 面板
- MCP 面板

虽然比之前干净很多，但后续只要 MCP 接入真实后端，它还会继续膨胀。

#### 6. `scripts/` 与 `skills/` 的职责还不够统一

当前仓库里：
- `skills/` 是前端读取的正式定义源
- `scripts/` 更像旧时代脚本样例目录

如果后续不定义清楚，会让人疑惑：
- 真正的能力来源到底是 `skills/` 还是 `scripts/`
- 新任务模板应放哪

---

### 二、之后优化要修改哪些内容

下面按优先级列。

#### 优先级 A：补齐 Web backend 能力层

这是“完全移植完成”的真正关键。

##### 需要改动的前端位置

- [src/services/runtime/types.ts](/Users/meteor/Code/OpsDog-Web/src/services/runtime/types.ts:1)  
  明确哪些接口由 Web backend 承接

- [src/services/runtime/index.ts](/Users/meteor/Code/OpsDog-Web/src/services/runtime/index.ts:1)  
  保持统一出口不变

- [src/services/runtime/webRuntime.ts](/Users/meteor/Code/OpsDog-Web/src/services/runtime/webRuntime.ts:1)  
  把当前 stub 换成真实 HTTP / SSE / WebSocket 调用

##### 需要优先补的能力

1. MCP
- `connectMCPServer`
- `disconnectMCPServer`
- `listMCPTools`
- `getMCPStatus`
- `callMCPTool`

2. 托管任务
- `startManagedTask`
- `restartManagedTask`
- `stopManagedTask`
- `listManagedTasks`
- `getManagedTask`
- `restoreManagedTasks`

3. 即时 Skill 执行
- `executeInstantSkill`

---

#### 优先级 B：拆分过重组件

##### 需要改动的文件

- [src/components/Chat/InputArea.tsx](/Users/meteor/Code/OpsDog-Web/src/components/Chat/InputArea.tsx:1)
- [src/components/panels/ToolsPanel.tsx](/Users/meteor/Code/OpsDog-Web/src/components/panels/ToolsPanel.tsx:1)
- [src/stores/index.ts](/Users/meteor/Code/OpsDog-Web/src/stores/index.ts:1)

##### 建议拆分方向

1. `InputArea.tsx`
- `chat/sendMessage.ts`
- `chat/toolPlanning.ts`
- `chat/managedTaskRouting.ts`
- `chat/skillCatalogReply.ts`

2. `ToolsPanel.tsx`
- `panels/tools/SkillsTab.tsx`
- `panels/tools/McpTab.tsx`

3. `stores/index.ts`
- `stores/appStore.ts`
- `stores/chatStore.ts`
- `stores/bootstrap.ts`

---

#### 优先级 C：统一 Skill 与脚本模板语义

##### 建议改动

- 保留 `skills/` 作为正式能力定义目录
- 明确 `scripts/` 是：
  - 服务端执行模板来源，或
  - 开发样例目录

##### 涉及文件

- [src/services/runtime/webSkills.ts](/Users/meteor/Code/OpsDog-Web/src/services/runtime/webSkills.ts:1)
- [src/components/Scripts/ScriptsWorkspace.tsx](/Users/meteor/Code/OpsDog-Web/src/components/Scripts/ScriptsWorkspace.tsx:1)
- `skills/*`
- `scripts/*`

---

### 三、如果有新功能，文件和代码应该怎样出现在当前代码中

这里给一套建议约定，后续尽量统一。

#### 1. 新功能如果是“纯页面/交互功能”

例如：
- 新聊天辅助面板
- 新配置项
- 新工作区入口

建议落点：

- UI 组件放在 `src/components/`
- 如果是面板型功能，放在 `src/components/panels/`
- 如果是脚本工作区子模块，放在 `src/components/Scripts/`
- 如果是聊天相关子模块，放在 `src/components/Chat/`

示例：

```text
src/components/panels/ModelHealthPanel.tsx
src/components/Chat/PromptPresets.tsx
src/components/Scripts/TaskLogsPanel.tsx
```

#### 2. 新功能如果需要“系统能力”

例如：
- 新 MCP 能力
- 新任务执行能力
- 新后端接口

建议先加到 runtime 层：

```text
src/services/runtime/types.ts
src/services/runtime/index.ts
src/services/runtime/webRuntime.ts
src/services/contracts.ts
```

也就是说顺序是：

1. 先定义 contracts
2. 再定义 runtime 接口
3. 再写 webRuntime 实现
4. 最后让页面调用

这样不会让组件直接长出一堆 `fetch(...)`

#### 3. 新功能如果需要“全局状态”

例如：
- 新的面板开关
- 新的任务筛选条件
- 新的模型偏好设置

建议：
- 与 UI 强相关的状态放 `useAppStore`
- 与会话/消息强相关的状态放 `useChatStore`
- 如果新状态很多，优先拆新 store 文件，不要继续把 `stores/index.ts` 做胖

#### 4. 新功能如果需要“新的能力定义”

例如：
- 新 Skill
- 新任务模板

建议：
- 正式能力定义进 `skills/<skill-name>/`
- 至少包含：

```text
skills/<skill-name>/skill.yaml
skills/<skill-name>/instructions.md
```

如果未来需要更多元数据，可继续加：

```text
skills/<skill-name>/examples.md
skills/<skill-name>/schema.json
```

#### 5. 新功能如果需要“后端承接”

建议在文档先补：

```text
docs/backend-api-<feature>.md
```

例如：

```text
docs/backend-api-mcp.md
docs/backend-api-managed-tasks.md
docs/backend-api-skills.md
```

先写接口契约，再动前端接线，会比直接写组件稳很多。

---

### 四、当前阶段的结论

当前项目已经不是桌面迁移中的“过渡壳”了，而是一个已经成型的纯 Web 前端。

现在的真实状态是：

- **界面结构**：已基本稳定
- **前端组织**：已可维护，但还需要继续拆厚文件
- **产品能力**：MCP / 托管任务 / 即时 Skill 执行 仍待 Web backend 接入

因此，后续工作的正确顺序应是：

1. 继续保持前端结构清爽
2. 优先补 MCP 的 Web backend 方案
3. 再补托管任务执行器
4. 再补即时 Skill 执行链

完成这几步后，项目才算真正进入“可以稳定开发新功能”的阶段。

