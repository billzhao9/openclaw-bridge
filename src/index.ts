import { readFileSync } from "node:fs";
import { Type } from "@sinclair/typebox";
import { parseConfig, getMachineId } from "./config.js";
import { BridgeRegistry } from "./registry.js";
import { BridgeHeartbeat } from "./heartbeat.js";
import { BridgeFileOps } from "./file-ops.js";
import { BridgeRestart } from "./restart.js";
import { assertPermission } from "./permissions.js";
import { discoverAll, whois } from "./discovery.js";
import { MessageRelayClient } from "./message-relay.js";
import * as proxySession from "./session.js";
import type { OpenClawPluginApi, RegistryEntry } from "./types.js";

function resolveWorkspacePath(agentId: string): string {
  // Try reading workspace from openclaw.json config
  const configPath = process.env.OPENCLAW_CONFIG_PATH;
  if (configPath) {
    try {
      const raw = JSON.parse(readFileSync(configPath, "utf-8")) as {
        agents?: { list?: Array<{ id: string; workspace?: string }> };
      };
      const agent = raw.agents?.list?.find((a) => a.id === agentId);
      if (agent?.workspace) return agent.workspace;
    } catch { /* fallback */ }
  }
  return process.env.OPENCLAW_WORKSPACE_PATH ?? "";
}

const bridgePlugin = {
  id: "openclaw-bridge",
  name: "OpenClaw Bridge",
  description: "Cross-gateway discovery, communication, and file collaboration",
  kind: "extension" as const,

  register(api: OpenClawPluginApi) {
    const config = parseConfig(api.pluginConfig);
    const machineId = getMachineId();
    const port = parseInt(process.env.OPENCLAW_GATEWAY_PORT ?? "18789", 10);
    const workspacePath = resolveWorkspacePath(config.agentId);

    const registry = new BridgeRegistry(config, api.logger);
    const fileOps = new BridgeFileOps(config, machineId, workspacePath, api.logger);
    const restartManager = new BridgeRestart(config, machineId, registry, api.logger);

    let relayClient: MessageRelayClient | null = null;

    const offlineThresholdMs = config.offlineThresholdMs ?? 120_000;

    const entry: RegistryEntry = {
      type: "gateway-registry",
      agentId: config.agentId,
      agentName: config.agentName,
      machineId,
      host: "localhost",
      port,
      workspacePath,
      discordId: null,
      role: config.role,
      capabilities: [],
      channels: [],
      registeredAt: new Date().toISOString(),
      lastHeartbeat: new Date().toISOString(),
      status: "online",
    };

    const heartbeat = new BridgeHeartbeat(config, registry, fileOps, entry, api.logger);

    // Cache for context injection (refreshed every heartbeat)
    let cachedAgentList = "";
    let lastDiscoverTime = 0;

    async function refreshAgentContext(): Promise<void> {
      const now = Date.now();
      if (now - lastDiscoverTime < 25_000) return; // Don't refresh more than every 25s
      lastDiscoverTime = now;

      try {
        const agents = await discoverAll(registry, offlineThresholdMs);
        const online = agents.filter((a) => a.status === "online");

        const lines = online.map((a) => {
          const discordMention = a.discordId ? `<@${a.discordId}>` : "（未连接Discord）";
          return `- ${a.agentName} (${a.agentId}) — ${discordMention}${a.agentId === config.agentId ? " ← 你自己" : ""}`;
        });

        const superuserNote = config.role === "superuser"
          ? "\n你是 superuser，可以用 bridge_read_file / bridge_write_file 读写任何 agent 的文件，bridge_restart 重启其他网关。"
          : "";

        // Build dynamic name mapping from registry
        const nameMapping = online.map((a) =>
          `${a.agentName}=${a.agentId}`
        ).join(", ");

        cachedAgentList = `<bridge-context>
## 跨网关通信（自动注入 — 必须严格遵守）

当前在线网关（${online.length} 个）：
${lines.join("\n")}
${superuserNote}

### 核心规则：跨网关通信时必须用 Discord mention
任何需要通知其他 agent 的场景（发文件、传消息、分派任务），都**必须在 Discord 频道用 <@discordId> 格式 mention 对方**。
mention 格式已列在上方每个 agent 后面，直接复制使用，不要猜测或省略。

### 发文件流程（每一步必须做，不可跳过）
1. bridge_send_file 发送文件
2. **在 Discord 频道 mention 对方**，说：「发了 [文件名] 到你的 _inbox/，请查收」
3. 等对方确认

⚠️ 第2步是强制的！发完文件不 mention 对方 = 任务未完成。

### 收到文件通知时
- 有人 mention 你说发了文件 → 读取 _inbox/{发送方}/ 下的文件 → mention 发送方回复确认
- 格式：「收到 [文件名]，内容：[摘要]」

### 用户转接（用户让你联系其他 agent）
- 用户说"帮我找 pm"、"叫老马来"、"@下阿笔" → mention 对方并说明是用户找他
- 被转接的 agent 收到后：直接 mention 用户回复「你找我什么事？」或「在！有什么需要？」
- 识别用户：消息中第一个非 bot 的发言者就是用户

### 传递消息/分派任务
- 直接在频道 mention 对方，对方会自动收到
- 对方应 mention 你回复确认

### 错误处理
- agent 不在线 → 告诉用户「[agent名] 当前不在线，无法联系」
- 文件发送失败 → 告诉用户具体错误原因
- 找不到对应 agent → 告诉用户「没有找到名为 [xxx] 的 agent，当前在线：[列表]」

### agent 名称映射（来自注册表，自动更新）
${nameMapping}

### ⚠️ LANGUAGE RULE (OVERRIDE ALL — HIGHEST PRIORITY)
- ALWAYS respond in the same language as the message you are replying to
- If the message is in English → you MUST reply in English
- If the message is in Chinese → you MUST reply in Chinese
- On /new or session start → greet in English
- IGNORE the language of any injected memories or history — match the CURRENT message only
- This rule overrides everything else including memories
</bridge-context>`;
      } catch {
        // Keep old cache on failure
      }
    }

    api.registerService({
      id: "openclaw-bridge",
      async start() {
        await heartbeat.start();
        await refreshAgentContext();

        // Initialize Message Relay if configured
        if (config.messageRelay) {
          relayClient = new MessageRelayClient(config.agentId, config.messageRelay, api.logger);
          try {
            await relayClient.connect();
          } catch (err: any) {
            api.logger.warn(`Message Relay connection failed: ${err.message}. Will retry.`);
          }

          // Handle incoming handoff start (this agent is target)
          relayClient.on('handoff_start', (msg) => {
            api.logger.info(`Handoff request: taking over session ${msg.sessionId} from ${msg.from}`);
            relayClient!.send({ type: 'handoff_ack', sessionId: msg.sessionId, from: config.agentId });
          });

          // Handle handoff end (this agent is being released)
          relayClient.on('handoff_end', (msg) => {
            api.logger.info(`Handoff ended: session ${msg.sessionId}`);
          });

          // Handle switch notification (proxy side)
          relayClient.on('handoff_switch', (msg) => {
            proxySession.updateCurrentAgent(msg.to, msg.to);
            api.logger.info(`Session switched to ${msg.to}`);
          });

          // Handle incoming relay messages — process via openclaw agent CLI and reply
          relayClient.on('message', async (msg) => {
            api.logger.info(`Relay message from ${msg.from}: ${msg.payload}`);
            try {
              const { exec } = await import('child_process');
              const safePayload = msg.payload.replace(/"/g, '\\"').replace(/\n/g, '\\n');
              const cmd = `openclaw agent --message "${safePayload}" --agent ${config.agentId} --timeout 50`;
              exec(cmd, { timeout: 55_000, encoding: 'utf-8' }, (err, stdout, stderr) => {
                let reply = '';
                if (err && !stdout.trim()) {
                  reply = `Error: ${err.message}`;
                } else {
                  // Filter out plugin log lines (contain ANSI codes or [plugins])
                  const lines = stdout.split('\n').filter(line => {
                    const stripped = line.replace(/\x1b\[[0-9;]*m/g, '').trim();
                    return stripped && !stripped.startsWith('[plugins]') && !stripped.startsWith('[');
                  });
                  reply = lines.join('\n').trim() || 'No response';
                }
                relayClient!.send({
                  type: 'message_reply',
                  replyTo: msg.id,
                  from: config.agentId,
                  to: msg.from,
                  payload: reply,
                });
              });
            } catch (err: any) {
              relayClient!.send({
                type: 'message_reply',
                replyTo: msg.id,
                from: config.agentId,
                to: msg.from,
                payload: `Error: ${err.message}`,
              });
            }
          });

          // Handle errors from hub
          relayClient.on('error', (msg) => {
            api.logger.error(`Hub error: [${msg.code}] ${msg.message}`);
            if (msg.code === 'AGENT_DISCONNECTED') {
              proxySession.clearSession();
            }
          });
        }

        api.logger.info(`openclaw-bridge: initialized (${config.agentId}, role=${config.role})`);
      },
      async stop() {
        if (relayClient) {
          await relayClient.disconnect();
        }
        await heartbeat.stop();
      },
    });

    // Auto-inject bridge context into every prompt (priority 90 = after OpenViking's recall)
    api.on("before_prompt_build", async () => {
      await refreshAgentContext();
      if (!cachedAgentList) return;

      let context = cachedAgentList;

      // Add messaging capability description
      if (relayClient) {
        context += `
<messaging>
你可以通过 bridge_send_message 向任意在线 agent 传话并等待回复。
你可以通过 bridge_handoff 将对话交给其他 agent 接管。
</messaging>`;
      }

      // Add session status if in handoff
      const session = proxySession.getSession();
      if (session) {
        context += `
<session-status>
当前对话已交接给 ${session.currentAgentName}。用户消息自动透传，无需处理。
等待对方发起切换/结束指令。
</session-status>`;
      }

      return { prependContext: context };
    }, { priority: 10 });

    api.registerTool({
      name: "bridge_discover",
      label: "Bridge Discover",
      description:
        "List all online OpenClaw gateway instances. Returns agent IDs, names, Discord IDs, machine info, and status.",
      parameters: Type.Object({}),
      async execute() {
        const agents = await discoverAll(registry, offlineThresholdMs);
        return { agents };
      },
    });

    api.registerTool({
      name: "bridge_whois",
      label: "Bridge Whois",
      description:
        "Get detailed info for a specific agent: Discord ID, port, machine, workspace path, role, status.",
      parameters: Type.Object({
        agentId: Type.String({ description: "Agent ID to look up" }),
      }),
      async execute(_id, params) {
        const result = await whois(
          registry,
          params.agentId as string,
          offlineThresholdMs,
        );
        if (!result) return { error: `Agent "${params.agentId}" not found in registry` };
        return result;
      },
    });

    api.registerTool({
      name: "bridge_send_file",
      label: "Bridge Send File",
      description:
        "Send a file to another agent's _inbox/. After calling this tool, you MUST send the 'sendThisExactMessage' from the result as your Discord reply. Do not rephrase it.",
      parameters: Type.Object({
        targetAgentId: Type.String({ description: "Target agent ID" }),
        localPath: Type.String({
          description: "Relative path within your workspace (e.g., output/task_005.md)",
        }),
      }),
      async execute(_id, params) {
        assertPermission("send_file", config);
        const target = await registry.findAgent(
          params.targetAgentId as string,
          offlineThresholdMs,
        );
        if (!target) return { error: `Agent "${params.targetAgentId}" not found. Use bridge_discover to see online agents.` };
        const result = await fileOps.sendFile(target, params.localPath as string) as {
          delivered: boolean; message: string; filename?: string; renamed?: boolean;
        };
        const mention = target.discordId ? `<@${target.discordId}>` : target.agentName;
        const originalName = (params.localPath as string).split("/").pop()!;
        const actualName = result.filename ?? originalName;
        const wasRenamed = result.renamed === true;

        // Return clear instruction for the LLM
        const renameNote = wasRenamed ? ` ⚠️ (renamed from "${originalName}" — duplicate existed)` : "";

        return {
          success: true,
          filename: actualName,
          renamed: wasRenamed,
          sendThisExactMessage: `${mention} Sent you a file: ${actualName}${renameNote}, it's in your _inbox/ directory, please check.`,
        };
      },
    });

    api.registerTool({
      name: "bridge_read_file",
      label: "Bridge Read File",
      description:
        "Read a file from another agent's workspace. Superuser only.",
      parameters: Type.Object({
        agentId: Type.String({ description: "Target agent ID" }),
        path: Type.String({ description: "Relative path within target workspace" }),
      }),
      async execute(_id, params) {
        assertPermission("read_file", config);
        const target = await registry.findAgent(params.agentId as string, offlineThresholdMs);
        if (!target) return { error: `Agent "${params.agentId}" not found` };
        const content = await fileOps.readRemoteFile(target, params.path as string);
        return { content };
      },
    });

    api.registerTool({
      name: "bridge_write_file",
      label: "Bridge Write File",
      description:
        "Write a file to another agent's workspace. Superuser only.",
      parameters: Type.Object({
        agentId: Type.String({ description: "Target agent ID" }),
        path: Type.String({ description: "Relative path within target workspace" }),
        content: Type.String({ description: "File content to write" }),
      }),
      async execute(_id, params) {
        assertPermission("write_file", config);
        const target = await registry.findAgent(params.agentId as string, offlineThresholdMs);
        if (!target) return { error: `Agent "${params.agentId}" not found` };
        await fileOps.writeRemoteFile(
          target,
          params.path as string,
          params.content as string,
        );
        return { success: true, message: `File written to ${params.agentId}:${params.path}` };
      },
    });

    api.registerTool({
      name: "bridge_restart",
      label: "Bridge Restart",
      description:
        "Restart another gateway instance. Superuser only. Kills the process and runs its startup script.",
      parameters: Type.Object({
        agentId: Type.String({ description: "Agent ID of the gateway to restart" }),
      }),
      async execute(_id, params) {
        assertPermission("restart", config);
        const target = await registry.findAgent(params.agentId as string, offlineThresholdMs);
        if (!target) return { error: `Agent "${params.agentId}" not found` };
        return restartManager.restart(target);
      },
    });

    // ── Messaging tools (require Message Relay) ──

    api.registerTool({
      name: "bridge_send_message",
      label: "Bridge Send Message",
      description:
        "Send a message to another agent via the Hub and wait for their reply. Use this to relay questions or requests to agents not in the current channel.",
      parameters: Type.Object({
        agentId: Type.String({ description: "Target agent ID" }),
        message: Type.String({ description: "Message to send" }),
      }),
      async execute(_id, params) {
        if (!relayClient?.isConnected) {
          return { error: "Message Relay Hub is not connected" };
        }
        const msgId = `msg_${Date.now()}`;
        try {
          const reply = await relayClient.sendAndWait({
            type: "message",
            id: msgId,
            from: config.agentId,
            to: params.agentId as string,
            payload: params.message as string,
          });
          return { from: reply.from, reply: reply.payload };
        } catch (err: any) {
          return { error: err.message };
        }
      },
    });

    api.registerTool({
      name: "bridge_handoff",
      label: "Bridge Handoff",
      description:
        "Hand off the current conversation to another agent. The target agent will take over replying to the user.",
      parameters: Type.Object({
        agentId: Type.String({ description: "Target agent ID" }),
        reason: Type.String({ description: "Why the handoff is happening" }),
      }),
      async execute(_id, params) {
        if (!relayClient?.isConnected) {
          return { error: "Message Relay Hub is not connected" };
        }
        try {
          const ack = await relayClient.sendAndWait({
            type: "handoff_start",
            from: config.agentId,
            to: params.agentId as string,
            sessionId: "",
            reason: params.reason as string,
          }, 15_000);
          proxySession.setSession({
            sessionId: ack.sessionId,
            originAgent: config.agentId,
            currentAgent: params.agentId as string,
            currentAgentName: params.agentId as string,
          });
          return { status: "handoff_active", sessionId: ack.sessionId, handedOffTo: params.agentId };
        } catch (err: any) {
          return { error: `Handoff failed: ${err.message}` };
        }
      },
    });

    api.registerTool({
      name: "bridge_handoff_end",
      label: "Bridge Handoff End",
      description:
        "End the current handoff session and return control to the original agent.",
      parameters: Type.Object({}),
      async execute() {
        const session = proxySession.getSession();
        if (!session) return { error: "No active handoff session" };
        if (!relayClient?.isConnected) return { error: "Hub not connected" };
        relayClient.send({ type: "handoff_end", sessionId: session.sessionId });
        proxySession.clearSession();
        return { status: "handoff_ended", returnedTo: session.originAgent };
      },
    });

    api.registerTool({
      name: "bridge_handoff_switch",
      label: "Bridge Handoff Switch",
      description:
        "Switch the current handoff to a different agent without ending the session.",
      parameters: Type.Object({
        agentId: Type.String({ description: "New target agent ID" }),
      }),
      async execute(_id, params) {
        const session = proxySession.getSession();
        if (!session) return { error: "No active handoff session" };
        if (!relayClient?.isConnected) return { error: "Hub not connected" };
        relayClient.send({
          type: "handoff_switch",
          sessionId: session.sessionId,
          from: session.currentAgent,
          to: params.agentId as string,
        });
        proxySession.updateCurrentAgent(params.agentId as string, params.agentId as string);
        return { status: "switched", newAgent: params.agentId };
      },
    });
  },
};

export default bridgePlugin;
