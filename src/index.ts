import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
import { buildMentionMap, applyMentions } from "./mention-interceptor.js";
import { DiscordApi } from "./discord-api.js";
import { ProjectManager } from "./project-manager.js";
import { CircuitBreaker } from "./circuit-breaker.js";

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
        if (freshBridgeConfig?.messageRelay && !(api.pluginConfig as any).messageRelay) {
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
    const discordApi = new DiscordApi(api.logger);
    discordApi.loadToken();
    const projectMgr = new ProjectManager(workspacePath, api.logger);
    const circuitBreaker = new CircuitBreaker(projectMgr, api.logger);

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
## Cross-Gateway Communication (Auto-injected — MUST follow strictly)

Online gateways (${online.length}):
${lines.join("\n")}
${superuserNote}

### Core Rule: Use Discord mention for ALL cross-gateway communication
When notifying another agent (sending files, messages, assigning tasks), you **MUST mention them using <@discordId> format**.
The mention format is listed next to each agent above — copy and use it exactly.

### File Sending Workflow (every step mandatory)
1. Call bridge_send_file to send the file
2. **Mention the recipient in Discord**: "Sent [filename] to your _inbox/, please check"
3. Wait for confirmation

⚠️ Step 2 is mandatory! Sending a file without mentioning the recipient = task incomplete.

### When You Receive a File Notification
- Someone mentions you about a file → read from _inbox/{sender}/ → mention sender to confirm
- Format: "Received [filename], content: [brief summary]"

### User Handoff (user asks you to contact another agent)
- User says "find pm", "call bot1", "@bot2" → mention that agent, explain user is looking for them
- Contacted agent should reply to user directly
- Identify user: the first non-bot speaker in the message

### Passing Messages / Assigning Tasks
- Mention the target agent directly in the channel
- Target agent should mention you back to confirm

### Error Handling
- Agent offline → tell user "[agent name] is currently offline"
- File send failed → tell user the specific error
- Agent not found → tell user "No agent named [xxx] found. Currently online: [list]"

### Agent Name Mapping (from registry, auto-updated)
${nameMapping}

${config.agentId === "pm" ? `### 🎯 PROJECT MANAGEMENT PROTOCOL (PM ONLY — MANDATORY)
When user asks you to create something (ad, video, content, script, etc.):

**YOU MUST EXECUTE ALL 6 STEPS IN ORDER. SKIPPING ANY STEP IS A CRITICAL FAILURE.**

1. **CALL bridge_project_create** — name + description → get projectId
2. **CALL bridge_create_project_thread** — projectName + agent IDs → get threadId
   ⚠️ THIS IS NON-NEGOTIABLE. You MUST create a Thread for EVERY project. NEVER skip this step.
3. **CALL bridge_task_assign** — for EACH agent task with projectId, agentId, title, detailed brief
4. **CALL bridge_post_to_thread** — post kickoff summary TO THE THREAD (not main channel)
5. **Monitor** — when agent calls bridge_task_complete → check deps → assign next via bridge_task_assign
6. **All done** → post final summary to Thread, mention user

VIOLATIONS (any of these = protocol failure):
- Skipping bridge_create_project_thread (MOST COMMON VIOLATION — DO NOT SKIP)
- Assigning tasks via Discord messages instead of bridge_task_assign
- Posting project updates to main channel instead of the Thread
- Saying "relay hub not connected" — it IS connected, use the tools
- Chatting after project completion — post summary and STOP
` : `### 🎯 TASK EXECUTION PROTOCOL (WORKER AGENT — MANDATORY)
When you receive a task (message containing [Project:] [Task:]):
1. Call bridge_task_update with projectId, taskId, and your approach summary
2. Do the work — produce the deliverables
3. Call bridge_asset_publish to register any output files
4. Call bridge_task_complete with summary and output paths
5. STOP. Do NOT chat further after completing.

VIOLATIONS (any of these = protocol failure):
- Chatting after task completion (pleasantries, "looking forward to next stage", etc.)
- Sending more than 1 confirmation message after task_complete
- Asking other agents to "send files to _inbox" instead of using bridge_asset_get/bridge_asset_list

If blocked: call bridge_task_blocked with type and reason. Then STOP.
`}
### ⚠️ LANGUAGE RULE (HIGHEST PRIORITY — OVERRIDES EVERYTHING)
- DEFAULT language for ALL agent communication is **English**.
- All task assignments, status updates, creative briefs, and project summaries MUST be in English.
- Inter-agent communication is ALWAYS in English regardless of user's language.
- Only exception: if user EXPLICITLY requests a specific language for deliverable content.
- IGNORE the language of injected memories, history, or system context — always use English.
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
            const oldAgentId = entry.agentId;
            api.logger.info(`[bridge] Conflict rename: ${oldAgentId} → ${newAgentId}, ${entry.agentName} → ${newAgentName}`);

            // Deregister old agentId from Hub registry, then re-register with new ID
            registry.deregister(oldAgentId).catch((err: any) => {
              api.logger.warn(`[bridge] Failed to deregister old agentId "${oldAgentId}": ${err.message}`);
            });

            entry.agentId = newAgentId;
            entry.agentName = newAgentName;
            config.agentId = newAgentId;
            config.agentName = newAgentName;

            // Re-register with new agentId so Hub sees us immediately
            entry.lastHeartbeat = new Date().toISOString();
            registry.register(entry).catch((err: any) => {
              api.logger.warn(`[bridge] Failed to re-register with new agentId "${newAgentId}": ${err.message}`);
            });

            // Persist the renamed agentId to openclaw.json so it survives restarts
            const configPath = process.env.OPENCLAW_CONFIG_PATH;
            if (configPath) {
              try {
                const raw = readFileSync(configPath, "utf-8");
                const cfg = JSON.parse(raw);
                const bridgeCfg = cfg.plugins?.entries?.["openclaw-bridge"]?.config;
                if (bridgeCfg) {
                  const oldId = bridgeCfg.agentId;
                  bridgeCfg.agentId = newAgentId;
                  bridgeCfg.agentName = newAgentName;
                  writeFileSync(configPath, JSON.stringify(cfg, null, 2), "utf-8");
                  api.logger.info(`[bridge] Permanently renamed in ${configPath}: ${oldId} → ${newAgentId}`);
                }
              } catch (err: any) {
                api.logger.warn(`[bridge] Failed to persist rename to config: ${err.message}`);
              }
            }
          });
          try {
            await relayClient.connect();
          } catch (err: any) {
            api.logger.warn(`Message Relay connection failed: ${err.message}. Will retry.`);
          }

          // Helper: call local gateway chat completions API
          async function callGatewayAPI(payload: string): Promise<string> {
            let gatewayToken = '';
            const configCandidates = [
              process.env.OPENCLAW_CONFIG_PATH,
              process.env.OPENCLAW_HOME ? `${process.env.OPENCLAW_HOME}/openclaw.json` : '',
              join(homedir(), '.openclaw', 'openclaw.json'),
            ].filter(Boolean) as string[];
            for (const cp of configCandidates) {
              try {
                if (!existsSync(cp)) continue;
                const raw = JSON.parse(readFileSync(cp, 'utf-8'));
                gatewayToken = raw.gateway?.auth?.token || '';
                if (gatewayToken) break;
              } catch { /* try next */ }
            }

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

    // ── Thread Management Tools ──────────────────────────────────────

    api.registerTool({
      name: "bridge_create_project_thread",
      label: "Bridge Create Project Thread",
      description: "Create a Discord Thread for a project in the current channel. Returns threadId.",
      parameters: Type.Object({
        projectName: Type.String({ description: "Project name for the thread title" }),
        agentIds: Type.Array(Type.String(), { description: "Agent IDs to mention in kickoff message" }),
      }),
      async execute(_id, params) {
        if (!discordApi.isAvailable) return { error: "Discord API not available — no bot token configured" };
        const projectName = params.projectName as string;
        const agentIds = params.agentIds as string[];

        const discordChannel = entry.channels.find(c => c.type === "discord");
        if (!discordChannel) return { error: "No Discord channel configured for this agent" };

        const agents = await discoverAll(registry, offlineThresholdMs);
        const mentions = agentIds
          .map(id => agents.find(a => a.agentId === id))
          .filter(Boolean)
          .map(a => a!.discordId ? `<@${a!.discordId}>` : a!.agentName)
          .join(" ");

        const thread = await discordApi.createThread(
          discordChannel.channelId,
          `🎬 ${projectName} — PM Managed`.substring(0, 100),
          `📋 **Project: ${projectName}**\n\nTeam: ${mentions}\n\nProject thread created. Updates will be posted here.`,
        );
        return { threadId: thread.id, threadName: thread.name };
      },
    });

    api.registerTool({
      name: "bridge_create_sub_thread",
      label: "Bridge Create Sub Thread",
      description: "Create a sub-thread for an agent's isolated task work.",
      parameters: Type.Object({
        projectId: Type.String({ description: "Project ID" }),
        agentId: Type.String({ description: "Agent ID assigned to this task" }),
        taskTitle: Type.String({ description: "Brief task title" }),
      }),
      async execute(_id, params) {
        if (!discordApi.isAvailable) return { error: "Discord API not available" };
        const discordChannel = entry.channels.find(c => c.type === "discord");
        if (!discordChannel) return { error: "No Discord channel configured" };

        const agents = await discoverAll(registry, offlineThresholdMs);
        const agent = agents.find(a => a.agentId === params.agentId);
        const agentName = agent?.agentName || (params.agentId as string);

        const thread = await discordApi.createThread(
          discordChannel.channelId,
          `📋 ${agentName} — ${params.taskTitle}`.substring(0, 100),
        );

        const project = projectMgr.readProject(params.projectId as string);
        if (project) {
          const task = project.tasks.find(t => t.agent === params.agentId && !t.subThreadId);
          if (task) {
            task.subThreadId = thread.id;
            projectMgr.writeProject(project);
          }
        }

        return { subThreadId: thread.id, threadName: thread.name };
      },
    });

    api.registerTool({
      name: "bridge_post_to_thread",
      label: "Bridge Post To Thread",
      description: "Post a message to a specific Discord Thread.",
      parameters: Type.Object({
        threadId: Type.String({ description: "Discord Thread ID" }),
        message: Type.String({ description: "Message content" }),
      }),
      async execute(_id, params) {
        if (!discordApi.isAvailable) return { error: "Discord API not available" };
        const agents = await discoverAll(registry, offlineThresholdMs);
        const mentionMap = buildMentionMap(agents);
        const processed = applyMentions(params.message as string, mentionMap);
        await discordApi.sendMessage(params.threadId as string, processed);
        return { success: true };
      },
    });

    // ── Project Management Tools ─────────────────────────────────────

    api.registerTool({
      name: "bridge_project_create",
      label: "Bridge Project Create",
      description: "Initialize a new project with directory structure and state tracking.",
      parameters: Type.Object({
        name: Type.String({ description: "Project name" }),
        description: Type.String({ description: "Brief project description" }),
      }),
      async execute(_id, params) {
        const project = projectMgr.createProject(params.name as string, params.description as string);
        return { projectId: project.id, projectDir: projectMgr.getProjectDir(project.id) };
      },
    });

    api.registerTool({
      name: "bridge_project_status",
      label: "Bridge Project Status",
      description: "Get project status. Omit projectId to see all active projects.",
      parameters: Type.Object({
        projectId: Type.Optional(Type.String({ description: "Project ID (omit for global overview)" })),
      }),
      async execute(_id, params) {
        if (params.projectId) {
          const project = projectMgr.readProject(params.projectId as string);
          if (!project) return { error: `Project "${params.projectId}" not found` };
          return { project };
        }
        return projectMgr.listProjects();
      },
    });

    // ── Task Management Tools ────────────────────────────────────────

    api.registerTool({
      name: "bridge_task_assign",
      label: "Bridge Task Assign",
      description: "Assign a task to an agent within a project. Sends the brief via Bridge Hub.",
      parameters: Type.Object({
        projectId: Type.String({ description: "Project ID" }),
        agentId: Type.String({ description: "Agent to assign to" }),
        title: Type.String({ description: "Task title" }),
        brief: Type.String({ description: "Detailed task brief with asset paths" }),
        dependencies: Type.Optional(Type.Array(Type.String(), { description: "Task IDs that must complete first" })),
      }),
      async execute(_id, params) {
        const task = projectMgr.addTask(
          params.projectId as string,
          params.agentId as string,
          params.title as string,
          params.brief as string,
          (params.dependencies as string[]) || [],
        );
        if (!task) return { error: "Failed to create task — project not found" };

        const ready = task.dependencies.length === 0 ||
          projectMgr.getReadyTasks(params.projectId as string).some(t => t.id === task.id);

        if (ready) {
          projectMgr.updateTaskStatus(params.projectId as string, task.id, "in_progress");
          if (relayClient?.isConnected) {
            const msgId = `task_${Date.now()}`;
            try {
              await relayClient.sendAndWait({
                type: "message",
                id: msgId,
                from: config.agentId,
                to: params.agentId as string,
                payload: `[Project: ${params.projectId}] [Task: ${task.id}] ${params.brief}`,
              }, 120_000);
            } catch { /* agent may not reply immediately */ }
          }
        }

        return { taskId: task.id, status: ready ? "in_progress" : "pending" };
      },
    });

    api.registerTool({
      name: "bridge_task_reassign",
      label: "Bridge Task Reassign",
      description: "Reassign a task to a different agent.",
      parameters: Type.Object({
        projectId: Type.String({ description: "Project ID" }),
        taskId: Type.String({ description: "Task ID" }),
        newAgentId: Type.String({ description: "New agent ID" }),
        reason: Type.String({ description: "Reason for reassignment" }),
      }),
      async execute(_id, params) {
        const task = projectMgr.updateTaskStatus(
          params.projectId as string,
          params.taskId as string,
          "pending",
          { agent: params.newAgentId as string, blockType: null, blockReason: null } as any,
        );
        if (!task) return { error: "Task or project not found" };
        return { taskId: task.id, newAgent: params.newAgentId, status: "pending" };
      },
    });

    api.registerTool({
      name: "bridge_task_update",
      label: "Bridge Task Update",
      description: "Post a progress update / thinking summary to the project's main Thread.",
      parameters: Type.Object({
        projectId: Type.String({ description: "Project ID" }),
        taskId: Type.String({ description: "Task ID" }),
        summary: Type.String({ description: "Progress summary" }),
      }),
      async execute(_id, params) {
        const project = projectMgr.readProject(params.projectId as string);
        if (!project) return { error: "Project not found" };
        const task = project.tasks.find(t => t.id === params.taskId);
        if (!task) return { error: "Task not found" };

        if (project.threadId && discordApi.isAvailable) {
          const agents = await discoverAll(registry, offlineThresholdMs);
          const mentionMap = buildMentionMap(agents);
          const processed = applyMentions(
            `📊 **${task.title}** (${config.agentName}): ${params.summary}`,
            mentionMap,
          );
          await discordApi.sendMessage(project.threadId, processed);
        }

        return { success: true };
      },
    });

    api.registerTool({
      name: "bridge_task_complete",
      label: "Bridge Task Complete",
      description: "Mark a task as completed with summary and output paths.",
      parameters: Type.Object({
        projectId: Type.String({ description: "Project ID" }),
        taskId: Type.String({ description: "Task ID" }),
        summary: Type.String({ description: "Completion summary" }),
        outputPaths: Type.Optional(Type.Array(Type.String(), { description: "Output file paths" })),
      }),
      async execute(_id, params) {
        const outputs = (params.outputPaths as string[]) || [];
        const task = projectMgr.updateTaskStatus(
          params.projectId as string,
          params.taskId as string,
          "completed",
          { outputs },
        );
        if (!task) return { error: "Task or project not found" };

        if (relayClient?.isConnected && config.agentId !== "pm") {
          relayClient.send({
            type: "message",
            id: `complete_${Date.now()}`,
            from: config.agentId,
            to: "pm",
            payload: `[Task Complete] Project: ${params.projectId}, Task: ${params.taskId}. ${params.summary}`,
          });
        }

        return { taskId: task.id, status: "completed", outputs };
      },
    });

    api.registerTool({
      name: "bridge_task_blocked",
      label: "Bridge Task Blocked",
      description: "Report that a task is blocked. Types: capability_missing, dependency_failed, clarification_needed.",
      parameters: Type.Object({
        projectId: Type.String({ description: "Project ID" }),
        taskId: Type.String({ description: "Task ID" }),
        blockType: Type.String({ description: "capability_missing | dependency_failed | clarification_needed" }),
        reason: Type.String({ description: "Detailed blocker explanation" }),
      }),
      async execute(_id, params) {
        const task = projectMgr.updateTaskStatus(
          params.projectId as string,
          params.taskId as string,
          "blocked",
          { blockType: params.blockType as any, blockReason: params.reason as string },
        );
        if (!task) return { error: "Task or project not found" };

        if (relayClient?.isConnected && config.agentId !== "pm") {
          relayClient.send({
            type: "message",
            id: `blocked_${Date.now()}`,
            from: config.agentId,
            to: "pm",
            payload: `[Task Blocked] Project: ${params.projectId}, Task: ${params.taskId}, Type: ${params.blockType}. ${params.reason}`,
          });
        }

        return { taskId: task.id, status: "blocked", blockType: params.blockType };
      },
    });

    // ── Asset Management Tools ───────────────────────────────────────

    api.registerTool({
      name: "bridge_asset_publish",
      label: "Bridge Asset Publish",
      description: "Publish an output asset to the project's asset directory.",
      parameters: Type.Object({
        projectId: Type.String({ description: "Project ID" }),
        filePath: Type.String({ description: "Path to file (relative to workspace)" }),
        assetType: Type.String({ description: "Asset type: storyboard, script, reference-images, video, etc." }),
        description: Type.String({ description: "Brief description" }),
        taskId: Type.String({ description: "Task ID that produced this asset" }),
      }),
      async execute(_id, params) {
        const fullPath = join(workspacePath, params.filePath as string);
        const asset = projectMgr.publishAsset(
          params.projectId as string,
          fullPath,
          params.assetType as string,
          params.description as string,
          config.agentId,
          params.taskId as string,
        );
        if (!asset) return { error: "Project not found" };
        return { assetId: asset.id, path: asset.path };
      },
    });

    api.registerTool({
      name: "bridge_asset_list",
      label: "Bridge Asset List",
      description: "List all assets in a project, optionally filtered.",
      parameters: Type.Object({
        projectId: Type.String({ description: "Project ID" }),
        type: Type.Optional(Type.String({ description: "Filter by asset type" })),
        agent: Type.Optional(Type.String({ description: "Filter by producer agent ID" })),
      }),
      async execute(_id, params) {
        const assets = projectMgr.listAssets(
          params.projectId as string,
          params.type as string | undefined,
          params.agent as string | undefined,
        );
        return { assets };
      },
    });

    api.registerTool({
      name: "bridge_asset_get",
      label: "Bridge Asset Get",
      description: "Get the full path and metadata of a specific asset.",
      parameters: Type.Object({
        projectId: Type.String({ description: "Project ID" }),
        assetId: Type.Optional(Type.String({ description: "Asset ID" })),
        assetType: Type.Optional(Type.String({ description: "Asset type to find latest of" })),
      }),
      async execute(_id, params) {
        const assets = projectMgr.listAssets(params.projectId as string);
        let asset: any;
        if (params.assetId) {
          asset = assets.find(a => a.id === params.assetId);
        } else if (params.assetType) {
          asset = assets.filter(a => a.type === params.assetType).pop();
        }
        if (!asset) return { error: "Asset not found" };
        const fullPath = join(projectMgr.getProjectDir(params.projectId as string), asset.path);
        return { ...asset, fullPath };
      },
    });
  },
};

export default bridgePlugin;
