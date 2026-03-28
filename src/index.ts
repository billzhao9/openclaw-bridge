import { readFileSync, writeFileSync } from "node:fs";
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
import { LocalManager } from "./manager/local-manager.js";
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

/**
 * Auto-patch openclaw.json with recommended bridge settings.
 * Adds messageRelay config (derived from fileRelay) and chatCompletions endpoint.
 * Returns list of changes made.
 */
function autoPatchConfig(logger: { info: (...a: any[]) => void; warn: (...a: any[]) => void }): string[] {
  const configPath = process.env.OPENCLAW_CONFIG_PATH;
  if (!configPath) return [];

  try {
    const raw = readFileSync(configPath, 'utf-8');
    const config = JSON.parse(raw);
    const changes: string[] = [];

    // 1. Auto-add messageRelay from fileRelay URL
    const bridgeConfig = config.plugins?.entries?.['openclaw-bridge']?.config;
    if (bridgeConfig && !bridgeConfig.messageRelay && bridgeConfig.fileRelay?.baseUrl) {
      const baseUrl = bridgeConfig.fileRelay.baseUrl as string;
      const wsUrl = baseUrl.replace(/^http/, 'ws') + '/ws';
      bridgeConfig.messageRelay = {
        url: wsUrl,
        apiKey: bridgeConfig.fileRelay.apiKey || '',
      };
      changes.push(`Added messageRelay.url = ${wsUrl} (derived from fileRelay)`);
    }

    // 2. Auto-enable chatCompletions
    if (!config.gateway?.http?.endpoints?.chatCompletions?.enabled) {
      config.gateway = config.gateway || {};
      config.gateway.http = config.gateway.http || {};
      config.gateway.http.endpoints = config.gateway.http.endpoints || {};
      config.gateway.http.endpoints.chatCompletions = { enabled: true };
      changes.push('Enabled gateway.http.endpoints.chatCompletions');
    }

    // 3. Auto-set dmHistoryLimit to 0 if not set (OpenViking handles memory)
    const discordAccounts = config.channels?.discord?.accounts;
    if (discordAccounts) {
      for (const [accountId, account] of Object.entries(discordAccounts)) {
        const acc = account as Record<string, unknown>;
        if (acc.dmPolicy && acc.dmHistoryLimit === undefined) {
          acc.dmHistoryLimit = 0;
          changes.push(`Set dmHistoryLimit=0 for discord account "${accountId}"`);
        }
      }
    }

    if (changes.length > 0) {
      writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
      logger.info(`[bridge] Auto-patched openclaw.json (${changes.length} changes):`);
      changes.forEach(c => logger.info(`  - ${c}`));
    }

    return changes;
  } catch (err: any) {
    logger.warn(`[bridge] Auto-patch failed: ${err.message}`);
    return [];
  }
}

const bridgePlugin = {
  id: "openclaw-bridge",
  name: "OpenClaw Bridge",
  description: "Cross-gateway discovery, communication, and file collaboration",
  kind: "extension" as const,

  register(api: OpenClawPluginApi) {
    // Auto-patch missing config on first run (writes to openclaw.json for next restart)
    const patches = autoPatchConfig(api.logger);

    // If we patched messageRelay, also update the in-memory pluginConfig
    if (patches.length > 0) {
      try {
        const configPath = process.env.OPENCLAW_CONFIG_PATH!;
        const fresh = JSON.parse(readFileSync(configPath, 'utf-8'));
        const freshBridgeConfig = fresh.plugins?.entries?.['openclaw-bridge']?.config;
        if (freshBridgeConfig?.messageRelay && !api.pluginConfig.messageRelay) {
          (api.pluginConfig as any).messageRelay = freshBridgeConfig.messageRelay;
        }
      } catch { /* use original */ }
    }

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
      description: config.description,
      supportsVision: config.supportsVision,
    };

    const heartbeat = new BridgeHeartbeat(config, registry, fileOps, entry, api.logger);

    let localManager: LocalManager | null = null;
    if (config.localManager?.enabled) {
      localManager = new LocalManager(
        config.localManager,
        config.fileRelay?.apiKey ?? "",
        api.logger,
      );
    }

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
        if (localManager) {
          await localManager.start();
        }
        await refreshAgentContext();

        // Initialize Message Relay if configured
        if (config.messageRelay) {
          relayClient = new MessageRelayClient(config.agentId, config.messageRelay, api.logger, machineId);
          relayClient.setAgentName(config.agentName);
          relayClient.setOnConflictRename((newAgentId, newAgentName) => {
            api.logger.info(`[bridge] Conflict rename: ${entry.agentId} → ${newAgentId}, ${entry.agentName} → ${newAgentName}`);
            entry.agentId = newAgentId;
            entry.agentName = newAgentName;
          });
          try {
            await relayClient.connect();
          } catch (err: any) {
            api.logger.warn(`Message Relay connection failed: ${err.message}. Will retry.`);
          }

          // Helper: call local gateway chat completions API
          async function callGatewayAPI(payload: string): Promise<string> {
            const configPath = process.env.OPENCLAW_CONFIG_PATH
              || `${process.env.OPENCLAW_HOME || ''}/openclaw.json`;
            let gatewayToken = '';
            try {
              const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
              gatewayToken = raw.gateway?.auth?.token || '';
            } catch { /* no token */ }

            // Check if payload is multimodal JSON (from Hub chat with image)
            let messages: any[];
            try {
              const parsed = JSON.parse(payload);
              if (parsed.text && parsed.image) {
                // Multimodal: text + image
                messages = [{ role: 'user', content: [
                  { type: 'text', text: parsed.text },
                  { type: 'image_url', image_url: { url: parsed.image } },
                ]}];
              } else {
                messages = [{ role: 'user', content: payload }];
              }
            } catch {
              messages = [{ role: 'user', content: payload }];
            }

            const url = `http://127.0.0.1:${entry.port}/v1/chat/completions`;
            const res = await fetch(url, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                ...(gatewayToken ? { 'Authorization': `Bearer ${gatewayToken}` } : {}),
              },
              body: JSON.stringify({
                model: 'openclaw/default',
                messages,
              }),
              signal: AbortSignal.timeout(55_000),
            });

            if (res.ok) {
              const data = await res.json() as any;
              return data.choices?.[0]?.message?.content || 'No response';
            } else {
              const text = await res.text();
              throw new Error(`Gateway returned ${res.status}: ${text.substring(0, 200)}`);
            }
          }

          // Handle incoming handoff start (this agent is target)
          relayClient.on('handoff_start', (msg) => {
            api.logger.info(`[handoff] Taking over session ${msg.sessionId} from ${msg.from}`);
            relayClient!.send({ type: 'handoff_ack', sessionId: msg.sessionId, from: config.agentId });
          });

          // Handle handoff messages (this agent is target — process via API and reply)
          relayClient.on('handoff_message', async (msg) => {
            api.logger.info(`[handoff] Message from ${msg.from}: ${msg.payload}`);
            try {
              const reply = await callGatewayAPI(msg.payload);
              api.logger.info(`[handoff] Reply (${reply.length} chars): ${reply.substring(0, 100)}`);
              relayClient!.send({
                type: 'handoff_reply',
                sessionId: msg.sessionId,
                from: config.agentId,
                to: msg.from,
                payload: reply,
              });
            } catch (err: any) {
              api.logger.error(`[handoff] Error: ${err.message}`);
              relayClient!.send({
                type: 'handoff_reply',
                sessionId: msg.sessionId,
                from: config.agentId,
                to: msg.from,
                payload: `Error: ${err.message}`,
              });
            }
          });

          // Handle handoff end (this agent is being released OR proxy getting end notification)
          relayClient.on('handoff_end', (msg) => {
            api.logger.info(`[handoff] Session ${msg.sessionId} ended`);
            if (proxySession.isInHandoff()) {
              proxySession.clearSession();
            }
          });

          // Handle switch notification (proxy side)
          relayClient.on('handoff_switch', (msg) => {
            proxySession.updateCurrentAgent(msg.to, msg.to);
            api.logger.info(`[handoff] Session switched to ${msg.to}`);
          });

          // Handle incoming relay messages — process via gateway chat completions API
          relayClient.on('message', async (msg) => {
            api.logger.info(`[relay] Message from ${msg.from}: ${msg.payload}`);
            try {
              const reply = await callGatewayAPI(msg.payload);
              api.logger.info(`[relay] Reply (${reply.length} chars): ${reply.substring(0, 100)}`);
              relayClient!.send({
                type: 'message_reply',
                replyTo: msg.id,
                from: config.agentId,
                to: msg.from,
                payload: reply,
              });
            } catch (err: any) {
              api.logger.error(`[relay] Error: ${err.message}`);
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
        if (localManager) {
          await localManager.stop();
        }
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
跨 Agent 通信工具使用规则（必须严格遵守）：

1. 传话模式 — 用户说"帮我问下XX"、"跟XX说"、"问XX一个问题"：
   → 调用 bridge_send_message(agentId, message) 发消息并等待回复
   → 收到回复后转达给用户

2. 切换模式 — 用户说"让XX来和我聊"、"换XX"、"我要跟XX说话"、"把XX叫来"：
   → 必须调用 bridge_handoff(agentId, reason) 而不是 bridge_send_message
   → bridge_handoff 会建立持久会话，之后用户的所有消息都转发给目标 agent
   → 这是完全不同的工具，不要混淆

不要建议用户去其他频道或 @mention，这些工具通过 Hub 中转，无需共同频道。
</messaging>`;
      }

      // Add session status if in handoff (proxy side)
      const session = proxySession.getSession();
      api.logger.info(`[bridge] before_prompt_build: handoff=${session ? 'YES session=' + session.sessionId + ' target=' + session.currentAgent : 'NO'}`);
      if (session) {
        context += `
<session-status>
【重要】当前对话已交接给 ${session.currentAgentName} (${session.currentAgent})。
你现在是消息中转代理，必须执行以下规则：
1. 用户发的每条消息，你都必须立即调用 bridge_send_message(agentId="${session.currentAgent}", message="用户原文") 转发给对方
2. 收到回复后，直接告诉用户：[${session.currentAgentName}] 回复内容
3. 如果用户说"换回来"、"我要和你聊"，调用 bridge_handoff_end() 结束交接
4. 如果用户说"换XX来"，调用 bridge_handoff_switch(agentId) 切换
5. 不要自己回答用户的问题，所有内容都转发给 ${session.currentAgentName}
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
        "Send a ONE-TIME message to another agent and wait for reply. Use for: '帮我问下XX', '跟XX说', 'ask XX'. Do NOT use this when user wants to SWITCH to another agent (use bridge_handoff instead).",
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
        "Switch the conversation to another agent. MUST use this (not bridge_send_message) when user says: '让XX来和我聊', '换XX', '我要跟XX说话', '把XX叫来', 'switch to XX', 'let me talk to XX'. After handoff, all user messages will be forwarded to the target agent automatically.",
      parameters: Type.Object({
        agentId: Type.String({ description: "Target agent ID" }),
        reason: Type.String({ description: "Why the handoff is happening" }),
      }),
      async execute(_id, params) {
        if (!relayClient?.isConnected) {
          return { error: "Message Relay Hub is not connected" };
        }
        try {
          // Use one-shot handler instead of sendAndWait (sessionId is "" at send time)
          const ack = await new Promise<any>((resolve, reject) => {
            const timer = setTimeout(() => {
              reject(new Error("Handoff timeout — target agent did not respond"));
            }, 15_000);
            relayClient!.on('handoff_ack', (msg) => {
              clearTimeout(timer);
              resolve(msg);
            });
            relayClient!.send({
              type: "handoff_start",
              from: config.agentId,
              to: params.agentId as string,
              sessionId: "",
              reason: params.reason as string,
            });
          });
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
