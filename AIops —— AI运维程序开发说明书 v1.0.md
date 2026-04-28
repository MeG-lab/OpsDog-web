# AIops —— AI运维程序开发说明书 v1.0

## 一、项目概述

### 1.1 项目定位
AIops 是一款跨平台的智能运维助手程序，核心理念是 **“对话即需求，脚本即功能”** 。用户通过标准对话框以自然语言描述运维任务需求，系统调用大模型理解意图，结合内置的 Skills 和 MCP 扩展能力，通过自定义 Python 脚本执行运维操作，完成从需求理解到任务执行的闭环。

### 1.2 核心宗旨
- **对话即需求**：用户的所有运维任务都通过统一的对话框完成，无需复杂的菜单操作或命令行记忆，自然语言即是任务指令。
- **脚本即功能**：程序的核心能力由自定义 Python 脚本承载，每个脚本封装一类运维功能（如服务器巡检、日志分析、服务重启等），通过 Skills 机制进行语义化描述和注册，使大模型能准确理解并调用对应脚本。

### 1.3 项目阶段
- **当前阶段（Phase 1）** ：搭建基础框架，实现核心能力闭环——标准对话框、大模型接入与切换、Skills/MCP扩展、Python脚本执行引擎。
- **后续阶段**：工作流接入（Dify、Coze 等）、主动报警监控、运维任务调度与自动化编排。

### 1.4 跨平台目标
- 首期主攻 **macOS 端**开发。
- 框架需具备**平滑移植到 Windows** 的能力，代码复用率目标 ≥ 95%。


## 二、技术架构总览

### 2.1 整体架构图

```
┌─────────────────────────────────────────────────────────────┐
│                      前端层（渲染进程）                        │
│   ┌─────────────────────────────────────────────────────┐   │
│   │  标准对话框 UI（React + TypeScript + Tailwind CSS）   │   │
│   │  - 消息输入/输出   - 模型切换控件   - Skills 管理面板  │   │
│   └─────────────────────────────────────────────────────┘   │
├─────────────────────────────────────────────────────────────┤
│                      IPC 通信层（Tauri）                      │
│   ┌─────────────────────────────────────────────────────┐   │
│   │  invoke() / emit() — 类型安全的双向通信桥接           │   │
│   └─────────────────────────────────────────────────────┘   │
├─────────────────────────────────────────────────────────────┤
│                      后端层（主进程 / Rust）                   │
│   ┌──────────────┬──────────────┬──────────────────────┐   │
│   │  LLM 服务层  │  Skills 引擎 │  Python 脚本执行器    │   │
│   │  - 多模型切换 │  - 渐进式加载 │  - 子进程调用         │   │
│   │  - API Key管理│  - 触发匹配  │  - 输出捕获           │   │
│   └──────────────┴──────────────┴──────────────────────┘   │
│   ┌──────────────────────────────────────────────────────┐   │
│   │              MCP Client（客户端集成）                  │   │
│   │  - 连接本地/远程 MCP Server  - Tools 发现与调用       │   │
│   └──────────────────────────────────────────────────────┘   │
├─────────────────────────────────────────────────────────────┤
│                      数据持久层                              │
│   ┌─────────────────────────────────────────────────────┐   │
│   │  SQLite / JSON — 配置存储、对话历史、Skills 索引      │   │
│   └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 分层说明

| 层级           | 职责                                                    | 关键技术                                    |
| -------------- | ------------------------------------------------------- | ------------------------------------------- |
| **前端层**     | UI 渲染与用户交互                                       | React 18 + TypeScript + Tailwind CSS + Vite |
| **IPC 通信层** | 前后端安全、类型安全的数据交换                          | Tauri Commands（invoke / emit）             |
| **后端层**     | 核心业务逻辑：LLM 调度、Skills 管理、脚本执行、MCP 集成 | Rust + 子进程调用 Python                    |
| **数据持久层** | 配置、历史、元数据的本地存储                            | SQLite（结构化）+ JSON（轻量配置）          |


## 三、技术选型详解

### 3.1 跨平台桌面框架：Tauri 2.0

**选型理由：**

Tauri 2.0 是一个基于 Rust 后端和系统 WebView 的跨平台桌面应用框架，相较于 Electron 具有显著优势：

- **体积极小**：打包产物约 3–8 MB，而 Electron 通常 100 MB+。
- **内存占用低**：Tauri 使用系统 WebView（macOS 用 WebKit，Windows 用 WebView2），无需捆绑完整的 Chromium 浏览器。
- **Rust 后端原生性能**：系统级调用（文件读写、进程管理等）性能优异。
- **安全性**：Tauri 提供内置的安全模型，IPC 通信可精细控制权限。
- **前端框架无关**：支持 React、Vue、Svelte 等任意前端技术栈。
- **跨平台一致性**：一套代码可构建 macOS、Windows、Linux 应用，移植成本极低。

**移植便利性说明：**
Tauri 2.0 使用 WebView2 作为 Windows 上的渲染引擎，该组件在 Windows 10/11 上已预装或可自动下载，无需额外处理。开发者只需在 Windows 环境下运行 `tauri build` 即可生成 `.exe` 或 `.msi` 安装包。

### 3.2 前端技术栈：React 18 + TypeScript + Tailwind CSS + Vite

| 组件             | 选型理由                                                   |
| ---------------- | ---------------------------------------------------------- |
| **React 18**     | 成熟的组件化 UI 框架，生态丰富，适合构建复杂交互的聊天界面 |
| **TypeScript**   | 类型安全，减少运行时错误，提升代码可维护性                 |
| **Tailwind CSS** | 原子化 CSS，快速构建现代化 UI，适合对话框应用              |
| **Vite**         | 极速开发构建工具，与 Tauri 集成良好                        |

### 3.3 后端核心技术

#### 3.3.1 后端语言：Rust（Tauri 原生）

- 通过 Tauri Commands 将 Rust 函数暴露给前端调用。
- 所有核心逻辑均在 `src-tauri/` 目录下用 Rust 实现。
- Rust 的强类型系统和内存安全特性保障后端的稳定性。

#### 3.3.2 Python 脚本执行器

**设计方案：**

由于运维脚本以 Python 编写（`script` 目录下的 `.py` 文件），后端需要通过**子进程方式**调用 Python 解释器执行脚本。

```rust
// 示例：Python 脚本执行 Command
#[tauri::command]
async fn execute_python_script(
    script_path: String,
    args: Vec<String>,
    timeout_ms: u64,
) -> Result<ScriptOutput, String> {
    // 使用 tokio::process::Command 调用 Python 解释器
    // 捕获 stdout/stderr，处理超时
}
```

**Python 环境要求：**
- 程序需检测系统中的 Python 环境（≥3.8），若无则提示用户安装。
- 支持配置自定义 Python 解释器路径（如虚拟环境中的 Python）。
- 推荐引导用户使用 Python 3.9–3.12 版本。

**脚本规范：**
- 所有运维脚本统一放置在 `~/.aiops/scripts/` 或应用安装目录下的 `scripts/` 中。
- 每个脚本需提供标准化的输入输出接口（JSON 格式）。
- 脚本应包含 `--help` 输出和结构化的元数据描述。

#### 3.3.3 Skills 引擎

**设计原理：**

Skills（技能）是大模型能力扩展的核心机制。每个 Skill 包含三部分：

1. **结构化指令**（Markdown）：定义触发条件、执行流程、输入输出约束
2. **资源文件**：参考文档、配置模板、示例等
3. **可执行脚本**：指向具体 Python 脚本的入口

**Skills 管理策略——渐进式披露：**

为避免上下文膨胀，采用“渐进式披露”机制：
- **启动时**：仅加载 Skills 的元数据（名称、描述、触发关键词）
- **触发时**：按需加载完整 SOP 指令到模型上下文
- **执行时**：调用对应的 Python 脚本

**Skills 目录结构：**
```
~/.aiops/skills/
├── server_monitor/
│   ├── skill.yaml          # 元数据：名称、描述、触发条件、入口脚本
│   ├── instructions.md     # 完整 SOP 指令
│   ├── resources/          # 参考文档和配置模板
│   └── scripts/
│       └── monitor.py
├── log_analyzer/
│   ├── skill.yaml
│   ├── instructions.md
│   └── scripts/
│       └── analyze.py
└── ...
```

**skill.yaml 示例：**
```yaml
name: server_monitor
version: 1.0.0
description: 服务器性能监控与健康检查
triggers:
  - "查看服务器状态"
  - "系统监控"
  - "检查CPU和内存"
entry_script: scripts/monitor.py
timeout_seconds: 60
dependencies:
  - psutil>=5.9.0
```

#### 3.3.4 MCP 集成

MCP（Model Context Protocol）是 Anthropic 于 2024 年 11 月开源的标准协议，截至 2026 年 3 月，月均 SDK 下载量已超 9700 万次，成为 AI Agent 集成的事实标准。

**集成方式：**

AIops 作为 MCP Host，内置 MCP Client，可连接用户配置的 MCP Servers：

- 支持 **stdio 传输**（本地 MCP Server，通过子进程通信）
- 支持 **Streamable HTTP 传输**（远程 MCP Server）
- 自动发现 MCP Server 提供的 Tools，并将其注册到大模型的工具调用列表

**配置示例：**
```json
{
  "mcp_servers": [
    {
      "name": "filesystem",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/allowed/dir"]
    },
    {
      "name": "github",
      "transport": "streamable-http",
      "url": "https://mcp-github.example.com",
      "headers": {
        "Authorization": "Bearer ${GITHUB_TOKEN}"
      }
    }
  ]
}
```

### 3.4 大模型接入层

#### 3.4.1 多模型支持策略

程序需支持通过 API Key 接入主流大模型厂商，同时允许用户自定义 API URL 和 Key：

| 支持类型             | 说明                                                         |
| -------------------- | ------------------------------------------------------------ |
| **OpenAI 兼容格式**  | 标准 `/v1/chat/completions` 接口（支持 OpenAI、Azure OpenAI、本地 Ollama 等） |
| **Anthropic Claude** | Claude API 格式（可选）                                      |
| **Google Gemini**    | Gemini API 格式（可选）                                      |
| **自定义**           | 用户提供完整 URL 和认证方式（Bearer Token / API Key Header） |

#### 3.4.2 模型配置结构

```rust
struct LLMConfig {
    provider: String,           // "openai" | "anthropic" | "google" | "custom"
    api_key: String,            // 加密存储
    base_url: Option<String>,   // 自定义 API 端点
    model_name: String,         // 如 "gpt-5"、"claude-3.5-sonnet"
    max_tokens: u32,
    temperature: f32,
}
```

#### 3.4.3 模型切换

- 前端提供下拉菜单切换已配置的模型
- 切换后立即生效，后续对话使用新模型
- 支持在对话中途切换（清空上下文或保留上下文由用户决定）

### 3.5 数据持久化

| 数据类型     | 存储方案                        | 位置                                         |
| ------------ | ------------------------------- | -------------------------------------------- |
| 应用配置     | JSON 文件                       | `~/.aiops/config.json`                       |
| 模型 API Key | 加密存储（Keychain/凭据管理器） | macOS: Keychain; Windows: Credential Manager |
| 对话历史     | SQLite                          | `~/.aiops/data/history.db`                   |
| Skills 索引  | JSON（由扫描生成）              | `~/.aiops/skills_index.json`                 |

### 3.6 打包与分发

#### 3.6.1 桌面应用打包：Tauri Bundler

Tauri 内置打包工具，支持生成：
- macOS：`.dmg`、`.app`
- Windows：`.msi`、`.exe` 安装程序
- Linux：`.deb`、`.AppImage`

#### 3.6.2 Python 脚本的跨平台分发

Python 脚本作为资源文件随应用打包，用户在目标平台上需要安装 Python 环境。如需独立分发单个 Python 工具，可使用 PyInstaller：

```bash
pyinstaller --onefile --name aiops-script-runner main.py
```

注意：PyInstaller 不是跨编译器，在 macOS 上打包的产物只能在 macOS 运行，Windows 包需在 Windows 环境下生成。


## 四、核心模块设计

### 4.1 标准对话框模块（前端）

**功能要点：**

- 消息输入框（支持多行、快捷键发送）
- 消息展示区（支持 Markdown 渲染、代码高亮、文件拖拽上传）
- 模型切换下拉菜单（显示当前使用的模型）
- Skills 快捷调用按钮（常用运维任务一键触发）
- 对话历史侧边栏（会话列表、新建/删除/搜索会话）
- 设置入口（API Key 配置、MCP Server 配置、Skills 管理）

### 4.2 对话处理流水线（后端）

```
用户输入 → 预处理 → LLM 推理（含 Skills/MCP Tools 上下文）→ 意图识别与工具调用 
→ Python 脚本执行 → 结果回传 → LLM 生成最终回复 → 前端展示
```

**关键流程说明：**

1. **上下文构建**：将当前对话历史、已加载的 Skills 元数据、MCP Tools 列表注入 Prompt
2. **工具调用**：LLM 返回 function call，后端解析后匹配对应的 Python 脚本或 MCP Tool
3. **脚本执行**：通过子进程调用 Python 脚本，捕获输出（支持流式输出）
4. **结果处理**：将脚本输出格式化后回传 LLM 进行自然语言润色，最终呈现给用户

### 4.3 Python 脚本执行器设计

```rust
// 脚本执行请求结构
struct ScriptExecutionRequest {
    script_path: String,      // Python 脚本绝对路径
    args: Vec<String>,        // 命令行参数
    env_vars: HashMap<String, String>, // 环境变量
    working_dir: Option<String>,
    timeout_ms: u64,          // 超时时间
}

// 脚本执行响应结构
struct ScriptExecutionResult {
    exit_code: i32,
    stdout: String,
    stderr: String,
    execution_time_ms: u64,
    truncated: bool,          // 输出是否被截断
}
```

**安全设计：**
- 限制脚本可访问的目录范围（沙箱机制）
- 禁止执行危险命令（通过命令白名单）
- 超时强制终止（防止脚本卡死）

### 4.4 配置管理模块

**配置层级：**
```
全局配置（应用级）
├── LLM 配置（可配置多个模型）
├── MCP Servers 配置
├── Python 解释器路径
└── 应用外观设置

用户配置（每个用户独立）
├── 对话历史
├── Skills 启用/禁用
└── 自定义快捷命令
```

### 4.5 Skills 管理器

**功能：**
- 扫描 `~/.aiops/skills/` 目录，解析 `skill.yaml`
- 生成 Skills 索引供 LLM 上下文使用
- 支持热加载（添加新 Skill 无需重启应用）
- 提供 Skills 市场接口预留（后续接入在线 Skills 仓库）


## 五、目录结构设计

```
aiops/
├── src-tauri/                    # Rust 后端（Tauri 主进程）
│   ├── src/
│   │   ├── main.rs               # 应用入口
│   │   ├── lib.rs                # 库入口，Commands 定义
│   │   ├── commands/
│   │   │   ├── chat.rs           # 对话处理 Commands
│   │   │   ├── llm.rs            # LLM 调用 Commands
│   │   │   ├── skills.rs         # Skills 管理 Commands
│   │   │   ├── mcp.rs            # MCP 集成 Commands
│   │   │   ├── python.rs         # Python 脚本执行 Commands
│   │   │   └── config.rs         # 配置读写 Commands
│   │   ├── services/
│   │   │   ├── llm_service.rs    # LLM 服务封装
│   │   │   ├── skills_service.rs # Skills 引擎
│   │   │   ├── mcp_client.rs     # MCP 客户端实现
│   │   │   └── script_runner.rs  # Python 脚本执行器
│   │   ├── models/               # 数据结构定义
│   │   └── utils/                # 工具函数
│   ├── Cargo.toml
│   └── tauri.conf.json           # Tauri 配置文件
│
├── src/                          # React 前端（渲染进程）
│   ├── components/
│   │   ├── Chat/
│   │   │   ├── ChatWindow.tsx    # 主对话框
│   │   │   ├── MessageList.tsx   # 消息列表
│   │   │   ├── InputArea.tsx     # 输入区域
│   │   │   └── ModelSelector.tsx # 模型切换
│   │   ├── Skills/
│   │   │   ├── SkillsPanel.tsx   # Skills 管理面板
│   │   │   └── SkillCard.tsx     # 单个 Skill 卡片
│   │   ├── Settings/
│   │   │   ├── LLMSettings.tsx   # LLM 配置
│   │   │   ├── MCPSettings.tsx   # MCP 配置
│   │   │   └── GeneralSettings.tsx
│   │   └── Layout/
│   │       ├── Sidebar.tsx       # 侧边栏
│   │       └── Header.tsx
│   ├── hooks/                    # 自定义 React Hooks
│   ├── stores/                   # 状态管理（Zustand）
│   ├── services/                 # 前端服务层
│   │   └── tauri.ts              # Tauri invoke 封装
│   ├── types/                    # TypeScript 类型定义
│   ├── App.tsx
│   ├── main.tsx
│   └── index.css
│
├── scripts/                      # 示例运维 Python 脚本
│   ├── monitor.py                # 系统监控脚本
│   ├── log_analyzer.py           # 日志分析脚本
│   └── ...
│
├── skills/                       # 内置 Skills 示例
│   ├── server_monitor/
│   │   ├── skill.yaml
│   │   └── instructions.md
│   └── log_analyzer/
│       ├── skill.yaml
│       └── instructions.md
│
├── resources/                    # 应用资源（图标等）
├── package.json
├── vite.config.ts
├── tailwind.config.js
├── tsconfig.json
└── README.md
```


## 六、冗余设计与扩展性预留

### 6.1 后续功能扩展预留

| 扩展方向                    | 预留设计                                                     |
| --------------------------- | ------------------------------------------------------------ |
| **工作流接入（Dify/Coze）** | 在 LLM Service 中预留 `workflow_provider` 字段，支持将对话请求路由至工作流引擎 |
| **主动报警**                | 预留定时任务调度模块接口（Cron 表达式），可周期性执行 Python 脚本并推送通知 |
| **任务编排**                | 预留 Workflow 数据结构，支持定义多个脚本的执行顺序和依赖关系 |
| **远程 MCP Server**         | MCP Client 已预留 Streamable HTTP 传输支持                   |
| **Skills 在线市场**         | Skills 管理器预留 `remote_registry_url` 配置项，支持从远程仓库拉取 Skills |
| **多用户支持**              | 数据目录已按用户隔离（`~/.aiops/`），便于后续扩展多用户配置切换 |
| **插件系统**                | 预留 Plugin 接口，支持第三方通过标准接口扩展功能             |

### 6.2 冗余与容错

- **LLM 服务降级**：当主模型不可用时，自动切换到备用模型
- **Python 环境检测**：启动时检测 Python 可用性，若无则引导用户安装
- **脚本执行隔离**：每个脚本在独立子进程中执行，单脚本失败不影响主程序
- **配置容错**：配置文件损坏时自动回退到默认配置
- **会话持久化**：对话历史自动保存，应用崩溃后可恢复


## 七、开发计划（Phase 1）

| 阶段         | 任务                                                      | 预计工时 |
| ------------ | --------------------------------------------------------- | -------- |
| **Sprint 1** | 项目初始化：Tauri 2.0 + React + TypeScript 脚手架搭建     | 2 天     |
| **Sprint 2** | 标准对话框 UI 实现（消息输入输出、Markdown 渲染、侧边栏） | 5 天     |
| **Sprint 3** | LLM 接入层：多模型配置、API 调用、模型切换                | 4 天     |
| **Sprint 4** | Python 脚本执行器：子进程调用、输出捕获、超时控制         | 3 天     |
| **Sprint 5** | Skills 引擎：YAML 解析、渐进式加载、触发匹配              | 5 天     |
| **Sprint 6** | MCP 集成：MCP Client 实现、Tools 发现与调用               | 4 天     |
| **Sprint 7** | 配置管理与数据持久化（SQLite + JSON）                     | 3 天     |
| **Sprint 8** | 集成测试、macOS 打包发布                                  | 3 天     |
| **Sprint 9** | Windows 移植与测试                                        | 2 天     |

**总计：约 31 个工作日**


## 八、关键技术决策总结

| 决策项      | 选择                      | 核心理由                                  |
| ----------- | ------------------------- | ----------------------------------------- |
| 跨平台框架  | **Tauri 2.0**             | 轻量（3–8 MB）、高性能、Rust 后端、易移植 |
| 前端框架    | **React 18 + TypeScript** | 生态成熟、类型安全、适合聊天 UI           |
| 后端语言    | **Rust**（Tauri 原生）    | 性能优异、内存安全、与 Tauri 深度集成     |
| Python 集成 | **子进程调用**            | 隔离性好、灵活、兼容任意 Python 脚本      |
| Skills 管理 | **YAML + Markdown**       | 易于编写、版本可控、支持渐进式加载        |
| MCP 集成    | **MCP SDK + FastMCP**     | 行业标准、生态支持广泛                    |
| 数据存储    | **SQLite + JSON**         | 轻量、零配置、跨平台                      |
| 打包分发    | **Tauri Bundler**         | 内置、与框架深度集成                      |

---

**UI 风格要求（不用严格遵守）：轻拟态（Soft Neumorphism / Warm Minimalism）**

- **基调**：浅色为主，背景采用柔和米白 `#F9F8F6` 或浅灰 `#F5F5F7`，文字使用深灰 `#2C2C2E`，避免纯黑纯白强对比。
- **卡片与容器**：圆角半径统一 `16px`，背景色比底色略亮 `#FFFFFF`，带极浅边框 `#E5E5E5` 与轻微外阴影 `0 2px 8px rgba(0,0,0,0.02), 0 4px 12px rgba(0,0,0,0.03)`，营造浮起感。
- **输入框**：无边框或仅底部极细分割线，聚焦时带淡雅主色描边（如 `#D4A373` 或 `#A0C4FF`），背景色与容器一致。
- **按钮**：圆角 `12px`，默认态浅灰底 `#EFEFEF`，悬停/按下时微变深并带柔和内阴影，避免高饱和渐变。
- **字体**：系统默认无衬线字体（macOS 使用 SF Pro，Windows 使用 Segoe UI），字号层级清晰，主消息 `15px`，辅助说明 `13px`，等宽字体用于脚本输出。
- **点缀色**：低饱和度强调色，如暖杏 `#E3B778`、雾蓝 `#8DA9C4`，仅用于选中态、图标和链接，占比不超过界面 10%。
- **整体气质**：干净、温润、专注，弱化操作痕迹，适合长时间对话与运维工作。

