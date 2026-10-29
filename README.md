# Feishu Agent for Cursor (飞书 Cursor 多 Agent 总控机器人)

**用飞书随时随地掌控你电脑上的所有 Cursor Agent。**

不需要额外部署手机端网页、不需要配置公网服务器或内网穿透隧道、也没有任何第三方 npm 依赖。本项目通过 **Chrome DevTools Protocol (CDP)** 连接本机桌面端 Cursor，并结合飞书官方 CLI（`lark-cli`）的长连接能力，将你的飞书变成 **Cursor「总控 Agent + 多子进程」全自动指挥中心**。

---

## 核心特性

### 1. 「总控 Agent + 子进程」协同架构
- 支持跨窗口发现并控制所有 Cursor 会话：包括 **本地编辑器窗口**、**SSH 远程窗口 (`[SSH: ...]`)**，以及 **`Cursor Agents` 多窗格窗口中的所有后台侧边栏会话**。
- 指定一个常驻会话作为 **总控 Agent (`#1`)**，它不仅能直接与你对话，还可以随时调用内置的 `cursor-ctl.mjs` CLI 工具去查看、指挥、批准或停止任何其他子进程。

### 2. 三路无冲突智能路由
在飞书里和机器人对话时，支持三种零冲突的路由方式：

1. **直接打字发送（默认） 👉 100% 发给总控 Agent (`#1`)**
   你可以直接用自然语言向总控下达跨进程指令（例如：*“帮我看看 #3 跑完的结果，没问题的话让它继续跑评测”*），总控会自动调用 `node cursor-ctl.mjs` 替你操作对应子进程。
2. **飞书左滑「引用回复」 👉 100% 直达对应子进程**
   当某个子进程发来状态通知或汇报卡片时，直接在飞书里**左滑引用该条消息**并回复，你的指令会直接注入那个子进程的输入框（例如左滑引用后回复 `允许` 即可直接点击该进程的确认按钮）。
3. **编号前缀（`@2 内容` 或 `#2 内容`） 👉 直达指定编号子进程**
   在消息开头加上 `@编号` 或 `#编号`，即可跳过总控直接发给对应的子进程。

### 3. 全会话主动监控与自动汇报
- 后台守护进程每 3 秒自动巡检全部 Cursor 窗口及 `Cursor Agents` 侧边栏中的每一个会话状态。
- 当任何子进程或总控 Agent **完成当前轮次回复**、**向你提问**、或 **停在确认按钮（`Run` / `Allow` / `Accept` / `运行` / `允许`）等待审批** 时，飞书机器人会自动将最新回复与待确认按钮推送到你的飞书。

### 4. 飞书快捷指令
| 指令 | 说明 |
| --- | --- |
| `状态` / `进程` / `/ps` | 列出当前所有 Cursor 窗口与会话编号、运行状态（`🔄 [运行中]` / `✅ [空闲]`） |
| `读 2` / `/read 2` | 读取 `#2` 进程最近的对话记录与待点击按钮 |
| `允许` / `运行` / `/ok` / `/btn 1` | 点击目标进程（引用消息对应的进程或最近触发通知的进程）的确认按钮 |
| `停止 2` / `/stop 2` | 停止正在运行的 `#2` 进程 |
| `帮助` / `/help` | 查看飞书端智能路由与快捷指令说明 |

---

## 工作原理

```text
飞书客户端 ──WebSocket长连接(lark-cli)──> feishu.mjs ──> cursor-ctl.mjs ──CDP(127.0.0.1:9222)──> Cursor IDE
                                            │                                                     ├─ 总控 Agent (#1)
                                            └── 后台 3s 主动轮询所有窗口与侧边栏会话状态 <───────────┴─ 子进程 (#2, #3, SSH窗口...)
```

---

## 环境要求

- **操作系统**：macOS（推荐，自带 `LaunchAgent` 后台开机自启脚本 `service.sh`）、Windows 或 Linux
- **Node.js**：`>= 22`（直接使用 Node 原生内置 `WebSocket` 与 `fetch`，零第三方 npm 依赖）
- **Cursor IDE**：桌面端 Cursor
- **飞书 CLI (`lark-cli`)**：已安装并完成机器人登录配置（参考 [larksuite/cli](https://github.com/larksuite/cli)）

---

## 快速上手

### 第 1 步：克隆仓库

```bash
git clone https://github.com/Keffee/Feishu_Agent_for_Cursor.git
cd Feishu_Agent_for_Cursor
```

### 第 2 步：配置环境变量 (`.env`)

复制环境变量模板并填入你的配置：

```bash
cp .env.example .env
```

编辑 `.env` 文件：

```ini
# 必填：允许控制机器人的飞书用户 open_id（也是主动推送的目标用户）
FEISHU_OPEN_ID=ou_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# 可选：指定总控 Agent 的会话 UUID（不填则默认将列表中的 #1 会话作为总控 Agent）
MASTER_CHAT_ID=

# 可选：lark-cli 可执行文件路径（默认自动查找 ~/.local/bin/lark-cli 或 PATH 中的 lark-cli）
LARK_CLI=lark-cli

# 可选：Cursor 调试端口地址（默认 http://127.0.0.1:9222）
CDP_URL=http://127.0.0.1:9222
```

> **如何获取 `FEISHU_OPEN_ID`？**
> 如果一开始不知道自己的 `open_id`，可以先留空并运行 `npm start`，然后用你的飞书给机器人发任意一条消息，终端日志会直接打印出你的 `open_id`。

### 第 3 步：带调试端口启动 Cursor

每次启动 Cursor 时需开启 `--remote-debugging-port=9222`：

- **macOS**：
  ```bash
  ./start-cursor.sh
  ```
- **Windows (PowerShell)**：
  ```powershell
  powershell -ExecutionPolicy Bypass -File .\start-cursor.ps1
  ```

### 第 4 步：启动飞书总控服务

- **前台运行（调试用）**：
  ```bash
  npm start
  ```
- **macOS 后台常驻服务（开机自启 & 崩溃自动重启）**：
  ```bash
  ./service.sh install     # 安装并启动后台服务
  ./service.sh status      # 查看运行状态
  ./service.sh logs        # 实时查看日志 (~/.cursor-remote-lite/server.log)
  ./service.sh uninstall   # 停止并卸载后台服务
  ```

---

## 总控命令行工具 (`cursor-ctl.mjs`)

`cursor-ctl.mjs` 既被 `feishu.mjs` 调用，也可以由你的 **总控 Agent** 在 Cursor 终端中直接执行，从而实现「用一个 Agent 统管所有其他 Agent」：

```bash
# 1. 列出所有窗口和会话（含运行状态、会话 ID、是否为 MASTER）
node cursor-ctl.mjs list

# 2. 读取指定编号或会话 ID 的最近对话内容与待确认按钮
node cursor-ctl.mjs read 2

# 3. 向指定会话发送消息（支持多行文本，自动挂载后台会话并按下回车）
node cursor-ctl.mjs send 2 "请继续执行下一步测试并汇报结果"

# 4. 点击指定会话中的第 N 个确认按钮（默认第 1 个，如 Run / Allow）
node cursor-ctl.mjs click 2 1

# 5. 停止指定会话正在进行的生成
node cursor-ctl.mjs stop 2
```

你可以在总控 Agent (`#1`) 的会话里告诉它：
> *“你可以通过运行 `node /path/to/cursor-ctl.mjs <list|read|send|click|stop>` 来检查和操控电脑上的其他 Cursor 会话。”*

之后你在飞书上直接发自然语言给总控，总控就能替你巡检、汇总并操作所有子任务。

---

## 项目文件结构

```text
.
├── feishu.mjs         # 飞书事件监听、三路智能消息路由、全会话主动状态监控与推送守护进程
├── cursor-ctl.mjs     # 基于 CDP 的多窗口/多会话发现、读取、发消息、点击按钮与停止 CLI 工具
├── start-cursor.sh    # macOS 下带 --remote-debugging-port=9222 重启 Cursor 的脚本
├── start-cursor.ps1   # Windows 下带 --remote-debugging-port=9222 重启 Cursor 的 PowerShell 脚本
├── service.sh         # macOS LaunchAgent 后台常驻服务管理脚本 (install/uninstall/status/logs)
├── .env.example       # 环境变量配置模板（真实配置保存在被 git 忽略的 .env 中）
├── package.json       # 项目配置与快捷脚本
└── LICENSE            # MIT 开源许可证
```

---

## 开源致谢与来源说明 (Acknowledgements & Attribution)

本项目基于以下优秀开源项目进行构建与改造，特此说明各部分的来源与致谢：

1. **[Suchenl/cursor-remote-lite](https://github.com/Suchenl/cursor-remote-lite)**（MIT License）
   本项目移除了原项目中面向手机浏览器/PWA 的 Web 前端（`app/`）、原生 Android 客户端（`android/`）、Cloudflare 隧道与 GitHub Pages 发布、设备配对及 Web Push 等模块，并沿用和改造了其中的以下核心机制与脚本：
   - **CDP 底层通信与 Cursor DOM 解析机制（演进整合至 `cursor-ctl.mjs`）**：通过 `http://127.0.0.1:9222/json/list` 发现 Cursor 工作区窗口、`Cdp` WebSocket RPC 封装、针对 Cursor 聊天面板（输入框 `.aislash-editor-input` / `.ui-prompt-input-editor__input`、虚拟列表消息行 `[data-flat-index]`、运行状态 `.codicon-debug-stop`、确认按钮识别）的 DOM 选择器思路，以及通过 `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent` / `Input.insertText` 模拟输入与点击的方法。
   - **Cursor 调试端口启动脚本（`start-cursor.sh` 与 `start-cursor.ps1`）**：直接沿自 `Suchenl/cursor-remote-lite`，用于在 macOS 和 Windows 上安全退出当前 Cursor 实例并附带 `--remote-debugging-port=9222` 重新拉起。
   - **macOS 后台守护进程管理脚本（`service.sh`）**：改编自 `Suchenl/cursor-remote-lite`，将原中继服务入口替换为 `feishu.mjs`，用于通过 macOS `launchctl` (`LaunchAgents`) 实现开机自启与崩溃自动重启。

2. **[larksuite/cli (`lark-cli`)](https://github.com/larksuite/cli)**
   - `feishu.mjs` 依托飞书官方 CLI 工具提供的 `lark-cli event consume im.message.receive_v1 --as bot` WebSocket 长连接能力接收实时消息，并通过 `lark-cli im +messages-send` / `+messages-reply` 实现消息与 Markdown 卡片的发送和引用回复。

3. **[len5ky/CursorRemote](https://github.com/len5ky/CursorRemote)**
   - 最初启发了通过 Electron 远程调试端口（CDP）连接并控制本机 Cursor IDE 的思路。

---

## License

本项目沿用上游项目的 [MIT License](LICENSE)。
