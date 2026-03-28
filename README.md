# openclaw-bridge

Cross-gateway communication plugin for [OpenClaw](https://github.com/nicepkg/openclaw). Enables independent gateway instances to discover each other, exchange files, relay messages, and hand off conversations.

## Features

- **Agent Discovery** — Auto-register and discover online agents via heartbeat
- **File Transfer** — Send files between agents (local or cross-machine via Hub)
- **Message Relay** — Send messages to any agent through the Hub and get replies
- **Session Handoff** — Transfer active conversations between agents seamlessly
- **Superuser Tools** — Read/write files and restart remote gateways
- **Auto-Config** — Automatically patches `openclaw.json` with recommended settings on first run

## Prerequisites

You need [openclaw-bridge-hub](https://www.npmjs.com/package/openclaw-bridge-hub) (v0.2.4+) running on a reachable server first:

```bash
# On your server:
npm install -g openclaw-bridge-hub
openclaw-bridge-hub init          # generates API key — save it!
openclaw-bridge-hub start         # starts on port 3080
openclaw-bridge-hub install-service  # auto-start on boot (Linux)
```

Save the generated API key — you'll need it for the plugin config below.

## Installation

```bash
openclaw plugins install openclaw-bridge
```

Or manually: place this plugin in a directory listed in `plugins.load.paths` of your `openclaw.json`.

## Configuration

Add to `openclaw.json` under `plugins.entries` (replace the API key and server URL with your own):

```json
{
  "plugins": {
    "entries": {
      "openclaw-bridge": {
        "config": {
          "role": "normal",
          "agentId": "my-agent",
          "agentName": "My Agent",
          "registry": {
            "baseUrl": "http://your-server:3080",
            "apiKey": "your-hub-api-key"
          },
          "fileRelay": {
            "baseUrl": "http://your-server:3080",
            "apiKey": "your-hub-api-key"
          }
        }
      }
    }
  }
}
```

### New Config Fields

| Field | Type | Description |
|-------|------|-------------|
| `description` | string | Short description shown on the Hub dashboard agent card |
| `supportsVision` | boolean | Whether this agent accepts image inputs. Auto-detected from the gateway model config if not set. |
| `localManager` | object | Local Manager settings — see [Local Manager](#local-manager) section below |

Example with all new fields:

```json
{
  "plugins": {
    "entries": {
      "openclaw-bridge": {
        "config": {
          "role": "normal",
          "agentId": "my-agent",
          "agentName": "My Agent",
          "description": "Handles project management tasks and sprint planning",
          "supportsVision": false,
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

### Local Manager

Installing `openclaw-bridge` now bundles a **Local Manager** that handles PM2 process management for your gateway instances on your local machine. It connects to the Hub via WebSocket so the Hub dashboard can remotely start, stop, and restart individual gateways.

**Requirements:**

- PM2 installed globally: `npm install -g pm2`
- A running `openclaw-bridge-hub` server

**How it works:**

- On startup, the plugin checks if `localManager.enabled` is `true`
- Only one Local Manager process runs per machine (enforced via a lock file)
- It connects to Hub at `localManager.hubUrl` over `/ws/manager` and authenticates with `localManager.managerPass`
- The Hub dashboard can then send `start`, `stop`, and `restart` commands for any gateway on that machine
- PM2 reports process status (running state, memory, uptime) back to the Hub every heartbeat cycle

**Config fields:**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `localManager.enabled` | boolean | `false` | Enable Local Manager on this machine |
| `localManager.hubUrl` | string | (required) | Full URL of the Hub server, e.g. `http://your-server:3080` |
| `localManager.managerPass` | string | (required) | Password set via `openclaw-bridge-hub manager-pass` |

### Auto-configured settings

On first startup, the plugin automatically adds these if missing:

| Setting | Value | Purpose |
|---------|-------|---------|
| `messageRelay.url` | Derived from `fileRelay.baseUrl` | WebSocket connection to Hub |
| `messageRelay.apiKey` | Same as `fileRelay.apiKey` | Hub authentication |
| `gateway.http.endpoints.chatCompletions.enabled` | `true` | Required for message relay processing |
| `channels.discord.accounts.*.dmHistoryLimit` | `0` | Fast DM responses (OpenViking handles memory) |

### Roles

| Role | Capabilities |
|------|-------------|
| `normal` | discover, whois, send_file, send_message, handoff |
| `superuser` | All of normal + read_file, write_file, restart |

## Tools

| Tool | Description |
|------|-------------|
| `bridge_discover` | List all online agents |
| `bridge_whois` | Get details for a specific agent |
| `bridge_send_file` | Send a file to another agent's inbox |
| `bridge_send_message` | Send a message and wait for reply (relay mode) |
| `bridge_handoff` | Hand off conversation to another agent |
| `bridge_handoff_end` | End handoff and return to original agent |
| `bridge_handoff_switch` | Switch handoff to a different agent |
| `bridge_read_file` | Read a file from any agent's workspace (superuser) |
| `bridge_write_file` | Write a file to any agent's workspace (superuser) |
| `bridge_restart` | Restart another gateway (superuser) |

## Architecture

```
User ←→ Discord DM ←→ Main Gateway
                            ↕ (WebSocket)
                      openclaw-bridge-hub (port 3080)
                            ↕ (WebSocket)
                       PM Gateway / Bot1-4
```

- Each gateway runs one agent with this shared plugin
- Plugin auto-registers to Hub, heartbeats every 30 seconds
- Messages and handoffs route through Hub WebSocket (`/ws`)
- File transfers use local filesystem (same machine) or Hub relay (cross-machine)

## CLI Commands

After installing globally (`npm install -g openclaw-bridge`), the `openclaw-bridge` command is available:

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

### Quick Start

1. Install the plugin: `npm install -g openclaw-bridge`
2. Run setup: `openclaw-bridge setup`
3. Check environment: `openclaw-bridge doctor`
4. Start all agents: `openclaw-bridge start`
5. Check status: `openclaw-bridge status`

### Adding a New Agent

```bash
openclaw-bridge add-agent
```

The wizard will prompt for:
- Agent name and ID
- Description
- AI model selection
- Automatically assigns the next available port
- Creates directory, config files, and updates PM2 ecosystem

### Backup & Restore

```bash
openclaw-bridge backup
```

Creates an encrypted backup archive. Config files are encrypted with AES-256-CBC. Excludes node_modules, state, workspace, and logs.

## CLI 命令说明

安装后 (`npm install -g openclaw-bridge`)，可使用 `openclaw-bridge` 命令：

| 命令 | 说明 |
|------|------|
| `setup` | 交互式设置 — 配置 Hub 地址、API 密钥和管理密码 |
| `status` | 查看 PM2 进程状态和 Hub 连接情况 |
| `start` | 查找并启动所有 openclaw 实例 |
| `stop` | 停止所有实例 |
| `restart [agent]` | 重启指定或全部 agent |
| `logs [agent]` | 查看 agent 日志（最近100行） |
| `backup` | 创建加密备份 |
| `clean-sessions` | 清理旧会话文件释放磁盘空间 |
| `add-agent` | 向导式创建新 agent 实例 |
| `doctor` | 环境诊断（PM2、Node、端口、Hub 连接） |

### 快速开始

1. 安装插件：`npm install -g openclaw-bridge`
2. 运行设置：`openclaw-bridge setup`
3. 检查环境：`openclaw-bridge doctor`
4. 启动所有 agent：`openclaw-bridge start`
5. 查看状态：`openclaw-bridge status`

## Mac Compatibility

The same plugin code runs on both **Windows** and **macOS** without modification. The Local Manager and orphan process cleanup routines use cross-platform detection — on Windows they use `taskkill`, on macOS/Linux they use `kill` signals. PM2 itself is cross-platform, so the full feature set (start/stop/restart, log streaming, process metrics) works identically on both platforms.

## Requirements

- [openclaw-bridge-hub](https://www.npmjs.com/package/openclaw-bridge-hub) v0.2.4+ running on a reachable server
- OpenClaw gateway 2026.3.24+

---

## 中文说明

openclaw-bridge 是 [OpenClaw](https://github.com/nicepkg/openclaw) 的跨网关通信插件，让独立运行的 Agent 网关之间能够互相发现、传输文件、实时传话和无缝切换对话。

### 核心功能

- **Agent 发现** — 通过心跳自动注册和发现在线 Agent
- **文件传输** — Agent 之间发送文件（同机直传，跨机走 Hub 中转）
- **消息中继** — 通过 Hub 向任意 Agent 发消息并等待回复（传话模式）
- **会话交接** — 将对话无缝切换给其他 Agent（Handoff 模式）
- **超级用户工具** — 读写远程 Agent 文件、重启远程网关
- **自动配置** — 首次启动时自动补全推荐配置项

### 快速开始

1. 先在服务器部署 [openclaw-bridge-hub](https://www.npmjs.com/package/openclaw-bridge-hub)
2. 安装本插件：`openclaw plugins install openclaw-bridge`
3. 在 `openclaw.json` 中配置 Hub 地址和 API Key
4. 启动网关，插件会自动注册和连接

### 使用场景

- 用户在 DM 中让 Main Bot 传话给 PM Bot
- 用户要求切换到其他 Bot 继续对话，无需换频道
- 跨机器部署的 Agent 之间互相通信
- Superuser 远程管理其他 Agent 的文件和生命周期

## Author

**Bill Zhao** — [LinkedIn](https://www.linkedin.com/in/billzhaodi/)

## License

MIT
