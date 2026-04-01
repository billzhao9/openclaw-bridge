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

These tools are available to agents during conversations:

| Tool | Description |
|------|-------------|
| `bridge_discover` | List all online agents |
| `bridge_whois` | Get details for a specific agent |
| `bridge_send_file` | Send a file to another agent's inbox |
| `bridge_send_message` | Send a message and wait for reply |
| `bridge_handoff` | Hand off conversation to another agent |
| `bridge_handoff_end` | End handoff and return to original agent |
| `bridge_handoff_switch` | Switch handoff to a different agent |
| `bridge_read_file` | Read a file from any agent's workspace (superuser) |
| `bridge_write_file` | Write a file to any agent's workspace (superuser) |
| `bridge_restart` | Restart another gateway (superuser) |

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
