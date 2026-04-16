# openclaw-bridge

The all-in-one client plugin for [OpenClaw](https://github.com/nicepkg/openclaw) distributed gateway architecture. Provides cross-gateway communication, local process management, and a full CLI for managing your OpenClaw agents.

## What's Included

- **Cross-Gateway Communication** — Agent discovery, file transfer, message relay, and session handoff
- **Local Manager** — PM2-based process management with remote control via Hub
- **CLI Tools** — Setup, status, start/stop/restart, log viewing, backup, agent creation, diagnostics
- **Auto-Config** — Automatically patches missing settings on first run

## Installation

### As OpenClaw Plugin (cross-gateway communication)

```bash
openclaw plugins install openclaw-bridge
```

Then configure in your `openclaw.json` — see [Plugin Configuration](#plugin-configuration) below.

### As CLI Tool (PM2 process management, optional)

```bash
npm install -g openclaw-bridge
openclaw-bridge setup
openclaw-bridge doctor
```

### Both (recommended)

The plugin provides bridge tools (discover, send_file, handoff, etc.) inside OpenClaw conversations. The CLI provides ops management (start/stop/restart agents, backup, diagnostics). They are independent and do not conflict.

### Upgrading

```bash
openclaw-bridge upgrade    # updates both plugin and CLI automatically
```

**Prerequisites:** [openclaw-bridge-hub](https://www.npmjs.com/package/openclaw-bridge-hub) running on a server, PM2 installed globally (`npm install -g pm2`), Node.js 18+.

## What's New in v0.6.0

### Breaking Changes
- **PM-Centralized Project Architecture** — `bridge_project_create`, `bridge_task_assign`, `bridge_task_reassign`, `bridge_asset_publish`, `bridge_create_project_thread`, and `bridge_create_sub_thread` are now **PM-only**. Non-PM agents receive a clear `STOP` error directing them to use `bridge_submit_deliverable` or `bridge_send_file` instead. Set `"isProjectManager": true` in the PM agent's bridge config to enable.
- **Worker ProjectManager is Read-Only** — Non-PM agents no longer create `_projects/` directories locally. All project state is centrally managed by PM. This prevents duplicate projects and stale local state.

### New Features
- **`bridge_submit_deliverable`** — New tool for worker agents to submit final deliverables to PM. Sends the file to PM's `_inbox/` AND registers it as a project asset via relay in one call.
- **Auto-Asset Registration via `bridge_send_file`** — When a worker sends a file from `_projects/<projectId>/...` to PM, it automatically triggers asset registration. No separate `bridge_submit_deliverable` call needed.
- **Auto-Thread Creation** — `bridge_project_create` now auto-creates a Discord Thread for each project. `bridge_task_assign` auto-creates isolated sub-threads per task.
- **Discord Sidebar Visibility** — New `creatorUserId` parameter on `bridge_project_create` and `bridge_create_project_thread`. When provided, the user is auto-added to the thread via Discord API so it appears in their sidebar immediately.
- **Worker Tools Relay to PM** — `bridge_task_update`, `bridge_task_complete`, `bridge_task_blocked`, `bridge_project_status`, `bridge_asset_list`, and `bridge_asset_get` now route through the PM via relay when called by non-PM agents. All project state reads/writes go through the single PM authority.
- **PM-Side Relay Handlers** — PM listens for `task_update`, `task_complete`, `task_blocked`, `query_project`, `query_assets`, `query_asset`, and `register_asset` messages. Automatically updates project state and posts to Discord threads.
- **UUID-Based Project IDs** — Project IDs now use UUID suffixes instead of `Date.now()` timestamps, eliminating any collision risk under concurrent creation.
- **Anti-Loop STOP Messages** — Tool errors return `"STOP — DO NOT retry"` messages to prevent LLM models from infinite-looping on failed tool calls.
- **Hard Round Limit Auto-Block** — When a task exceeds its hard round limit (15), PM auto-blocks it with status `stalled` and posts a warning to the project thread.
- **macOS launchd Fallback** — Process listing and log reading now fall back to launchd when PM2 is unavailable (macOS single-instance setups).
- **Auto-Config Fixes 6-8** — CLI `doctor --fix` now auto-adds `localManager` from `fileRelay`, auto-detects `discordId` from Discord token, and sets `dmHistoryLimit=0`.
- **Discord Token Detection Fallback** — Heartbeat now uses the first enabled Discord account when no bindings are configured.
- **extractChannels Fix** — Fixed channel extraction to parse `guilds.<guildId>.channels.<channelId>` structure (previously always returned `[]`).

### v0.6.0 更新说明

#### 破坏性变更
- **PM 中心化项目架构** — `bridge_project_create`、`bridge_task_assign`、`bridge_asset_publish` 等 6 个工具现为 PM 专属。非 PM agent 调用会收到 `STOP` 错误提示。PM 的 bridge 配置需设 `"isProjectManager": true`。
- **Worker ProjectManager 只读** — 非 PM agent 不再在本地创建 `_projects/` 目录，所有项目状态由 PM 统一管理。

#### 新功能
- **`bridge_submit_deliverable`** — Worker 提交最终交付物给 PM 的新工具，一次调用完成文件传输 + 资产注册。
- **`bridge_send_file` 自动资产注册** — 发给 PM 的文件如果路径含 `_projects/<projectId>/`，自动触发资产注册。
- **自动 Thread 创建** — 创建项目时自动建 Discord Thread；分派任务时自动建隔离子线程。
- **Discord 侧边栏可见** — 支持传入 `creatorUserId`，自动将用户加入 Thread。
- **Worker 工具 Relay 到 PM** — 6 个 Worker 工具全部改为通过 relay 路由到 PM 执行。
- **UUID 项目 ID** — 消除并发创建时的 ID 冲突风险。
- **防死循环 STOP 消息** — 工具错误返回 "STOP" 指令防止 LLM 无限重试。
- **macOS launchd 回退** — 无 PM2 时自动使用 launchd 获取进程状态和日志。
- **extractChannels 修复** — 修复 Discord channel 提取始终返回空数组的 bug。

---

## What's New in v0.5.1

### Bug Fixes
- **Conflict Rename Re-registration** — After agentId conflict rename, the plugin now re-registers with the new ID immediately. Previously, the old ID was deregistered but the new ID was not registered until the next heartbeat, leaving the agent invisible on Hub.
- **Channel Auto-Detection** — Fixed `discordId` and `channels` always showing as `null` / `[]` on Hub. Root causes: (1) config path had no fallback when `OPENCLAW_CONFIG_PATH` env was unset, (2) `extractChannels()` treated `accounts` as Array instead of Record (always returned `[]`), (3) detection only ran on heartbeat tick, not at startup. All three fixed.
- **WebSocket Reconnection** — Fixed reconnection stopping permanently if `new WebSocket()` threw synchronously (e.g., DNS failure). Now schedules retry in the catch block.
- **Stable Machine ID** — `getMachineId()` now persists a stable ID to `~/.openclaw/.machine-id` instead of using `os.hostname()`. Prevents ghost nodes on Hub when macOS hostname changes (hostname vs LocalHostName mismatch).

### v0.5.1 Bug 修复
- **冲突重命名后重新注册** — agentId 冲突重命名后，现在立即用新 ID 重新注册。此前旧 ID 被注销但新 ID 要等下一次心跳才注册，导致 Hub 上看不到该节点。
- **Channel 自动检测** — 修复 Hub 上 `discordId` 和 `channels` 始终显示为 `null` / `[]` 的问题。根因：(1) 没设 `OPENCLAW_CONFIG_PATH` 环境变量时 config 路径无 fallback，(2) `extractChannels()` 把 `accounts` 当数组解析（实际是对象），(3) 检测只在心跳 tick 运行不在启动时运行。三个问题全部修复。
- **WebSocket 重连** — 修复 `new WebSocket()` 同步抛异常（如 DNS 解析失败）时重连永久停止的问题。
- **稳定机器 ID** — `getMachineId()` 现在将稳定 ID 持久化到 `~/.openclaw/.machine-id`，不再依赖 `os.hostname()`。防止 macOS 主机名变化时 Hub 上产生幽灵节点。

## What's New in v0.4.0

### Multi-Device Support
- **Automatic agentId Conflict Resolution** — If two machines use the same `agentId`, the second machine automatically renames to `agentId@hostname` (e.g., `main@MacBookPro`). No manual config change needed.
- **Proper Plugin Packaging** — Now ships compiled JavaScript. Installs correctly via `openclaw plugins install`.
- **Upgrade Command** — Run `openclaw-bridge upgrade` to update both plugin and CLI in one step.

### 多设备支持 (v0.4.0)
- **agentId 冲突自动解决** — 两台机器用相同 agentId 时，第二台自动改名为 `agentId@主机名`（如 `main@MacBookPro`），无需手动改配置。
- **规范打包** — 现在发布编译后的 JavaScript，通过 `openclaw plugins install` 正确安装。
- **一键升级** — 运行 `openclaw-bridge upgrade` 同时更新插件和 CLI。

## CLI Commands

| Command | Description |
|---------|-------------|
| `setup` | Interactive setup — configure Hub URL, API key, and manager password |
| `status` | Show PM2 process status and Hub connection |
| `start` | Find and start all openclaw instances via PM2 ecosystem |
| `stop` | Stop all openclaw instances |
| `restart [agent]` | Restart a specific agent or all |
| `logs [agent]` | View PM2 logs for an agent (last 100 lines) |
| `backup` | Create encrypted backup of openclaw-instances |
| `clean-sessions` | Remove old/deleted session files to free disk space |
| `add-agent` | Wizard to create a new agent instance |
| `doctor` | Diagnose environment issues (PM2, Node, ports, Hub) |
| `upgrade` | Upgrade openclaw-bridge (plugin + CLI) |

### Adding a New Agent

```bash
openclaw-bridge add-agent
```

The wizard prompts for agent name, ID, description, and AI model. It automatically:
- Assigns the next available port
- Creates the directory with `openclaw.json`, `run.sh`, `run.ps1`
- Updates `ecosystem.config.cjs`

### Backup

```bash
openclaw-bridge backup
```

Creates an encrypted tar.gz archive. Config files are encrypted with AES-256-CBC. Excludes node_modules, state, workspace, and logs.

---

## Plugin Configuration

The plugin is also loaded by each OpenClaw gateway instance for cross-agent communication. Add to `openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "openclaw-bridge": {
        "enabled": true,
        "config": {
          "role": "normal",
          "agentId": "my-agent",
          "agentName": "My Agent",
          "description": "Handles project management and sprint planning",
          "registry": {
            "baseUrl": "http://your-server:3080",
            "apiKey": "your-hub-api-key"
          },
          "fileRelay": {
            "baseUrl": "http://your-server:3080",
            "apiKey": "your-hub-api-key"
          },
          "localManager": {
            "enabled": true,
            "hubUrl": "http://your-server:3080",
            "managerPass": "your-manager-password"
          }
        }
      }
    }
  }
}
```

### Config Fields

| Field | Type | Description |
|-------|------|-------------|
| `role` | `"normal"` \| `"superuser"` | Agent permission level |
| `isProjectManager` | boolean | Set `true` on the PM agent only. Enables project creation, task assignment, and relay handlers |
| `agentId` | string | Unique identifier (e.g., `pm`, `director`) |
| `agentName` | string | Display name (e.g., `PM Bot`, `Director`) |
| `description` | string | Short description shown on Hub dashboard |
| `supportsVision` | boolean | Accept image inputs. Auto-detected from model config if not set |
| `registry.baseUrl` | string | Hub server URL |
| `registry.apiKey` | string | Hub API key |
| `fileRelay.baseUrl` | string | Hub server URL (same as registry) |
| `fileRelay.apiKey` | string | Hub API key (same as registry) |
| `localManager.enabled` | boolean | Enable Local Manager on this machine |
| `localManager.hubUrl` | string | Hub server URL |
| `localManager.managerPass` | string | Password set via `openclaw-bridge-hub manager-pass` |

### Roles

| Role | Capabilities |
|------|-------------|
| `normal` | discover, whois, send_file, send_message, handoff |
| `superuser` | All of normal + read_file, write_file, restart |

### Auto-configured Settings

On first startup, the plugin automatically adds these if missing:

| Setting | Value | Purpose |
|---------|-------|---------|
| `messageRelay.url` | Derived from `fileRelay.baseUrl` | WebSocket connection to Hub |
| `gateway.http.endpoints.chatCompletions.enabled` | `true` | Required for message relay |
| `channels.discord.accounts.*.dmHistoryLimit` | `0` | Fast DM responses |

## Local Manager

The Local Manager handles PM2 process management for your gateway instances. It connects to the Hub via WebSocket so the Hub dashboard can remotely start, stop, and restart gateways.

- Only one instance runs per machine (enforced via lock file)
- Reports process status (running state, memory, uptime) and logs every 30 seconds
- Handles remote commands from Hub dashboard
- Starts automatically when `localManager.enabled: true` in any gateway's bridge config

## Bridge Tools

### All Agents
| Tool | Description |
|------|-------------|
| `bridge_discover` | List all online agents |
| `bridge_whois` | Get details for a specific agent |
| `bridge_send_file` | Send a file to another agent's inbox (auto-registers to PM if path contains `_projects/`) |
| `bridge_send_message` | Send a message and wait for reply |
| `bridge_handoff` | Hand off conversation to another agent |
| `bridge_handoff_end` | End handoff and return to original agent |
| `bridge_handoff_switch` | Switch handoff to a different agent |
| `bridge_submit_deliverable` | Submit final deliverable to PM (file + asset registration) |
| `bridge_task_update` | Post progress update to project thread (relays to PM) |
| `bridge_task_complete` | Mark task done (relays to PM) |
| `bridge_task_blocked` | Report blocker (relays to PM) |
| `bridge_project_status` | Query project state (relays to PM) |
| `bridge_asset_list` | List project assets (relays to PM) |
| `bridge_asset_get` | Get asset details (relays to PM) |
| `bridge_post_to_thread` | Post to a Discord thread |

### PM Only (`isProjectManager: true`)
| Tool | Description |
|------|-------------|
| `bridge_project_create` | Create project + auto-create Discord thread |
| `bridge_task_assign` | Assign task + auto-create sub-thread |
| `bridge_task_reassign` | Reroute a blocked task |
| `bridge_asset_publish` | Direct asset registration |
| `bridge_create_project_thread` | Standalone thread creation |
| `bridge_create_sub_thread` | Standalone sub-thread creation |

### Superuser Only
| Tool | Description |
|------|-------------|
| `bridge_read_file` | Read a file from any agent's workspace |
| `bridge_write_file` | Write a file to any agent's workspace |
| `bridge_restart` | Restart another gateway |

## Architecture

```
User ←→ Discord/Web ←→ Gateway Agent
                            ↕ (WebSocket)
                      openclaw-bridge-hub (:3080 + :9090 dashboard)
                            ↕ (WebSocket)
                       Other Gateway Agents
```

- Each gateway runs one agent with this plugin
- Plugin auto-registers to Hub, heartbeats every 30 seconds
- Messages and handoffs route through Hub WebSocket (`/ws`)
- File transfers use local filesystem (same machine) or Hub relay (cross-machine)
- Local Manager connects to Hub via `/ws/manager` for remote control

## Cross-Platform

Same code runs on **Windows** and **macOS** without modification. Local Manager and orphan process cleanup use platform detection. PM2 is cross-platform, so start/stop/restart, logs, and process metrics work identically on both.

---

## 中文说明

openclaw-bridge 是 [OpenClaw](https://github.com/nicepkg/openclaw) 的一站式客户端插件，提供跨网关通信、本地进程管理和完整的 CLI 工具。

### 核心功能

- **跨网关通信** — Agent 发现、文件传输、消息中继、会话交接
- **本地管理器** — 基于 PM2 的进程管理，支持通过 Hub 远程控制
- **CLI 工具** — 设置、状态查看、启停重启、日志、备份、创建 Agent、环境诊断
- **自动配置** — 首次启动自动补全推荐配置

### 安装

```bash
# 作为 OpenClaw 插件安装（跨网关通信）
openclaw plugins install openclaw-bridge

# 作为 CLI 工具安装（可选，用于 PM2 进程管理）
npm install -g openclaw-bridge
openclaw-bridge setup

# 一键升级
openclaw-bridge upgrade
```

### CLI 命令

| 命令 | 说明 |
|------|------|
| `setup` | 交互式设置 Hub 地址、API 密钥、管理密码 |
| `status` | 查看 PM2 进程状态和 Hub 连接 |
| `start` | 启动所有 openclaw 实例 |
| `stop` | 停止所有实例 |
| `restart [agent]` | 重启指定或全部 agent |
| `logs [agent]` | 查看 agent 日志（最近100行） |
| `backup` | 创建加密备份 |
| `clean-sessions` | 清理旧会话文件 |
| `add-agent` | 向导式创建新 agent |
| `doctor` | 环境诊断 |
| `upgrade` | 一键升级 openclaw-bridge（插件 + CLI） |

### 使用场景

- 多台电脑部署 Agent，统一通过 Hub 互相通信和管理
- 用户让 Main Bot 传话给其他 Bot，或直接切换对话
- 通过 Hub Dashboard 远程监控和重启 Agent
- 一键备份整个 OpenClaw 实例，跨平台迁移部署

## Author

**Bill Zhao** — [LinkedIn](https://www.linkedin.com/in/billzhaodi/)

## License

MIT
