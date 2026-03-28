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

## Requirements

- [openclaw-bridge-hub](https://www.npmjs.com/package/openclaw-bridge-hub) v0.2.4+ running on a reachable server
- OpenClaw gateway 2026.3.24+

## License

MIT
