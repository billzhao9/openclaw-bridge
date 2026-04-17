import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, readdirSync, statSync } from "node:fs";
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

    // 4. Auto-add localManager from fileRelay
    if (bridgeConfig && !bridgeConfig.localManager && bridgeConfig.fileRelay?.baseUrl) {
      const relayUrl = bridgeConfig.fileRelay.baseUrl as string;
      try {
        const u = new URL(relayUrl);
        bridgeConfig.localManager = {
          baseUrl: `${u.protocol}//${u.hostname}:9090`,
          password: '',
        };
        changes.push(`Added localManager.baseUrl = ${u.protocol}//${u.hostname}:9090 (derived from fileRelay)`);
      } catch { /* invalid URL */ }
    }

    // 5. Auto-add gateway.auth.token if missing
    if (!config.gateway?.auth?.token) {
      config.gateway = config.gateway || {};
      config.gateway.auth = config.gateway.auth || {};
      if (!config.gateway.auth.mode) config.gateway.auth.mode = 'token';
      if (!config.gateway.auth.token) {
        const agentId = bridgeConfig?.agentId || 'agent';
        const token = `bridge-${agentId}-${Date.now().toString(36)}`;
        config.gateway.auth.token = token;
        changes.push(`Added gateway.auth.token = ${token}`);
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
    const projectMgr = new ProjectManager(workspacePath, api.logger, { readOnly: !config.isProjectManager });
    const circuitBreaker = new CircuitBreaker(projectMgr, api.logger);

    let relayClient: MessageRelayClient | null = null;

    const offlineThresholdMs = config.offlineThresholdMs ?? 120_000;

    // Extract Discord channels at init time so entry.channels is populated immediately.
    // This is critical because hot-reloads call init() but NOT start()/heartbeat.start().
    // Without this, entry.channels stays [] until the first heartbeat tick.
    function extractChannelsFromConfig(): Array<{ type: string; channelId: string; name: string }> {
      const candidates = [
        process.env.OPENCLAW_CONFIG_PATH,
        process.env.OPENCLAW_HOME ? join(process.env.OPENCLAW_HOME, "openclaw.json") : "",
        join(homedir(), ".openclaw", "openclaw.json"),
      ].filter(Boolean) as string[];
      const configPath = candidates.find(p => existsSync(p));
      if (!configPath) { api.logger.warn("[bridge] init-time channel extraction: no config file found"); return []; }
      try {
        const raw = readFileSync(configPath, "utf-8");
        const cfg = JSON.parse(raw) as any;
        const accounts = cfg.channels?.discord?.accounts;
        if (!accounts || typeof accounts !== "object") return [];
        const result: Array<{ type: string; channelId: string; name: string }> = [];
        const seen = new Set<string>();
        for (const account of Object.values(accounts) as any[]) {
          if (account.guilds && typeof account.guilds === "object") {
            for (const guild of Object.values(account.guilds) as any[]) {
              if (guild.channels && typeof guild.channels === "object") {
                for (const channelId of Object.keys(guild.channels)) {
                  if (channelId && /^\d+$/.test(channelId) && !seen.has(channelId)) {
                    seen.add(channelId);
                    result.push({ type: "discord", channelId, name: channelId });
                  }
                }
              }
            }
          }
        }
        if (result.length > 0) api.logger.info(`[bridge] init-time channel extraction: ${result.length} channels found`);
        return result;
      } catch { return []; }
    }

    // Also detect discordId from token at init time
    function detectDiscordIdFromConfig(): string | null {
      const candidates = [
        process.env.OPENCLAW_CONFIG_PATH,
        process.env.OPENCLAW_HOME ? join(process.env.OPENCLAW_HOME, "openclaw.json") : "",
        join(homedir(), ".openclaw", "openclaw.json"),
      ].filter(Boolean) as string[];
      const configPath = candidates.find(p => existsSync(p));
      if (!configPath) { api.logger.warn("[bridge] detectDiscordId: no config file found from candidates: " + candidates.join(", ")); return null; }
      try {
        const raw = readFileSync(configPath, "utf-8");
        const cfg = JSON.parse(raw) as any;
        const accounts = cfg.channels?.discord?.accounts;
        if (!accounts) { api.logger.warn("[bridge] detectDiscordId: no discord accounts in config"); return null; }
        for (const account of Object.values(accounts) as any[]) {
          if (account.token) {
            const decoded = Buffer.from(account.token.split(".")[0], "base64").toString("utf-8");
            if (/^\d+$/.test(decoded)) {
              api.logger.info(`[bridge] init-time discordId detected: ${decoded}`);
              return decoded;
            }
          }
        }
        api.logger.warn("[bridge] detectDiscordId: no valid token found in any account");
      } catch (err: any) { api.logger.error(`[bridge] detectDiscordId error: ${err.message}`); }
      return null;
    }

    /**
     * Resolve an agent's Discord ID by scanning local instance configs.
     * Since all instances are on the same machine, we can read their openclaw.json
     * directly. This is more reliable than the registry which may not store discordId.
     */
    function resolveAgentDiscordId(agentId: string): string | null {
      // Scan local openclaw-instances directory for the agent's config
      const instancesDir = process.env.OPENCLAW_CONFIG_PATH
        ? join(process.env.OPENCLAW_CONFIG_PATH, "..", "..")  // e.g., C:\openclaw-instances\pm\openclaw.json → C:\openclaw-instances
        : "";
      if (!instancesDir || !existsSync(instancesDir)) return null;

      try {
        const dirs = readdirSync(instancesDir);
        for (const dir of dirs) {
          const configPath = join(instancesDir, dir, "openclaw.json");
          if (!existsSync(configPath)) continue;
          try {
            const raw = readFileSync(configPath, "utf-8");
            const cfg = JSON.parse(raw) as any;
            // Check if this config's bridge agentId matches
            const bridgeConfig = cfg.plugins?.entries?.["openclaw-bridge"]?.config;
            if (bridgeConfig?.agentId === agentId) {
              // Found the right instance — decode discordId from its Discord token
              const accounts = cfg.channels?.discord?.accounts;
              if (accounts) {
                for (const acc of Object.values(accounts) as any[]) {
                  if (acc.token) {
                    const decoded = Buffer.from(acc.token.split(".")[0], "base64").toString("utf-8");
                    if (/^\d+$/.test(decoded)) return decoded;
                  }
                }
              }
            }
          } catch { /* skip this config */ }
        }
      } catch {}
      return null;
    }

    /**
     * Non-PM agents route project/task/asset operations to PM via relay.
     * Returns { ok: boolean, ...data }.
     *
     * Fallback mechanism: if the relay is disconnected or PM does not respond,
     * the message is appended as a JSON line to <workspacePath>/_outbox/pending_relay.jsonl.
     * PM can periodically scan worker _outbox directories to pick up and process
     * these queued messages, ensuring no task updates are lost during outages.
     */
    async function askPm(type: string, data: Record<string, unknown>, timeoutMs = 20_000, pmAgentId = "pm"): Promise<any> {
      const msgId = `${type}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const envelope = { type, id: msgId, from: config.agentId, to: pmAgentId, ...data, ts: new Date().toISOString() };

      // Helper: queue a failed relay message to local _outbox for later PM pickup
      function queueToOutbox(): { ok: true; fallback: true; message: string } {
        try {
          const outboxDir = join(workspacePath, "_outbox");
          if (!existsSync(outboxDir)) mkdirSync(outboxDir, { recursive: true });
          const outboxPath = join(outboxDir, "pending_relay.jsonl");
          appendFileSync(outboxPath, JSON.stringify(envelope) + "\n", "utf-8");
          api.logger.warn(`[bridge] askPm fallback: queued ${type} (${msgId}) to ${outboxPath}`);
        } catch (writeErr: any) {
          api.logger.error(`[bridge] askPm fallback: failed to write outbox — ${writeErr.message}`);
        }
        return { ok: true, fallback: true, message: "Queued for PM pickup" };
      }

      if (!relayClient?.isConnected) {
        return queueToOutbox();
      }

      try {
        const reply = await relayClient.sendAndWait(envelope, timeoutMs);
        return reply;
      } catch (err: any) {
        // PM did not respond in time — fall back to local queue
        return queueToOutbox();
      }
    }

    const entry: RegistryEntry = {
      type: "gateway-registry",
      agentId: config.agentId,
      agentName: config.agentName,
      machineId,
      host: "localhost",
      port,
      workspacePath,
      discordId: detectDiscordIdFromConfig(),
      role: config.role,
      capabilities: [],
      channels: extractChannelsFromConfig(),
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

          // PM-side handlers: worker agents route project/task/asset operations here.
          // All project state lives on PM; workers never touch local _projects/.
          if (config.isProjectManager) {
            // Helper: send typed reply for request/response relay messages
            const replyOk = (msg: any, replyType: string, data: Record<string, unknown>) => {
              relayClient!.send({ type: replyType, replyTo: msg.id, from: config.agentId, to: msg.from, ok: true, ...data });
            };
            const replyErr = (msg: any, replyType: string, error: string) => {
              relayClient!.send({ type: replyType, replyTo: msg.id, from: config.agentId, to: msg.from, ok: false, error });
            };

            // Task update: post progress summary to project's main thread.
            // Also increments round counter — if the task hits its hard round limit,
            // force-block it so the worker's model stops looping.
            relayClient.on('task_update', async (msg) => {
              try {
                const bumped = projectMgr.incrementRounds(msg.projectId as string, msg.taskId as string);
                if (!bumped) return replyErr(msg, 'task_update_reply', "Project or task not found");
                const { task, hardLimit } = bumped as any;
                const project = projectMgr.readProject(msg.projectId as string);
                if (project?.threadId && discordApi.isAvailable) {
                  const agents = await discoverAll(registry, offlineThresholdMs);
                  const mentionMap = buildMentionMap(agents);
                  const agentName = agents.find(a => a.agentId === msg.from)?.agentName || msg.from;
                  const processed = applyMentions(`📊 **${task.title}** (${agentName}): ${msg.summary}`, mentionMap);
                  await discordApi.sendMessage(project.threadId, processed);
                  if (hardLimit) {
                    projectMgr.updateTaskStatus(msg.projectId as string, msg.taskId as string, "blocked",
                      { blockType: "stalled" as any, blockReason: `Task exceeded hard round limit (${task.rounds})` } as any);
                    await discordApi.sendMessage(project.threadId,
                      `⛔ **${task.title}** auto-blocked — hit hard round limit (${task.rounds}). Worker should stop and PM must intervene.`);
                  }
                }
                replyOk(msg, 'task_update_reply', { posted: !!project?.threadId, rounds: task.rounds, hardLimitHit: !!hardLimit });
              } catch (err: any) { replyErr(msg, 'task_update_reply', err.message); }
            });

            // Task complete: update task status + outputs
            relayClient.on('task_complete', async (msg) => {
              try {
                const task = projectMgr.updateTaskStatus(
                  msg.projectId as string, msg.taskId as string, "completed",
                  { outputs: (msg.outputPaths as string[]) || [] } as any,
                );
                if (!task) return replyErr(msg, 'task_complete_reply', "Project or task not found");
                // Post completion notice to thread
                const project = projectMgr.readProject(msg.projectId as string);
                if (project?.threadId && discordApi.isAvailable) {
                  const agents = await discoverAll(registry, offlineThresholdMs);
                  const agentName = agents.find(a => a.agentId === msg.from)?.agentName || msg.from;
                  await discordApi.sendMessage(project.threadId, `✅ **${task.title}** completed by ${agentName}. ${msg.summary || ""}`);
                }
                replyOk(msg, 'task_complete_reply', { taskId: task.id, status: "completed" });
              } catch (err: any) { replyErr(msg, 'task_complete_reply', err.message); }
            });

            // Task blocked
            relayClient.on('task_blocked', async (msg) => {
              try {
                const task = projectMgr.updateTaskStatus(
                  msg.projectId as string, msg.taskId as string, "blocked",
                  { blockType: msg.blockType, blockReason: msg.reason } as any,
                );
                if (!task) return replyErr(msg, 'task_blocked_reply', "Project or task not found");
                const project = projectMgr.readProject(msg.projectId as string);
                if (project?.threadId && discordApi.isAvailable) {
                  const agents = await discoverAll(registry, offlineThresholdMs);
                  const agentName = agents.find(a => a.agentId === msg.from)?.agentName || msg.from;
                  await discordApi.sendMessage(project.threadId, `⚠️ **${task.title}** blocked by ${agentName} — ${msg.blockType}: ${msg.reason}`);
                }
                replyOk(msg, 'task_blocked_reply', { taskId: task.id, status: "blocked", blockType: msg.blockType });
              } catch (err: any) { replyErr(msg, 'task_blocked_reply', err.message); }
            });

            // Query project(s)
            relayClient.on('query_project', async (msg) => {
              try {
                if (msg.projectId) {
                  const project = projectMgr.readProject(msg.projectId as string);
                  if (!project) return replyErr(msg, 'query_project_reply', `Project "${msg.projectId}" not found`);
                  return replyOk(msg, 'query_project_reply', { project });
                }
                replyOk(msg, 'query_project_reply', { projects: projectMgr.listProjects() });
              } catch (err: any) { replyErr(msg, 'query_project_reply', err.message); }
            });

            // Query assets for a project
            relayClient.on('query_assets', async (msg) => {
              try {
                const assets = projectMgr.listAssets(
                  msg.projectId as string,
                  msg.type as string | undefined,
                  msg.agent as string | undefined,
                );
                replyOk(msg, 'query_assets_reply', { assets });
              } catch (err: any) { replyErr(msg, 'query_assets_reply', err.message); }
            });

            // Query single asset by id or latest of a type
            relayClient.on('query_asset', async (msg) => {
              try {
                const assets = projectMgr.listAssets(msg.projectId as string);
                let asset: any;
                if (msg.assetId) asset = assets.find(a => a.id === msg.assetId);
                else if (msg.assetType) asset = assets.filter(a => a.type === msg.assetType).pop();
                if (!asset) return replyErr(msg, 'query_asset_reply', "Asset not found");
                const fullPath = join(projectMgr.getProjectDir(msg.projectId as string), asset.path);
                replyOk(msg, 'query_asset_reply', { asset: { ...asset, fullPath } });
              } catch (err: any) { replyErr(msg, 'query_asset_reply', err.message); }
            });

            relayClient.on('register_asset', async (msg) => {
              api.logger.info(`[register_asset] from ${msg.from}: project=${msg.projectId} file=${msg.filename}`);
              try {
                const inboxPath = join(workspacePath, "_inbox", msg.from as string, msg.filename as string);
                if (!existsSync(inboxPath)) {
                  throw new Error(`inbox file not found: ${inboxPath}`);
                }
                const asset = projectMgr.publishAsset(
                  msg.projectId as string,
                  inboxPath,
                  (msg.assetType as string) || "deliverable",
                  (msg.description as string) || "",
                  msg.from as string,
                  (msg.taskId as string) || "",
                );
                if (!asset) {
                  relayClient!.send({
                    type: 'register_asset_reply',
                    replyTo: msg.id,
                    from: config.agentId,
                    to: msg.from,
                    ok: false,
                    error: `Project "${msg.projectId}" not found in PM workspace`,
                  });
                  return;
                }
                // Auto-mark task complete if taskId provided
                if (msg.taskId) {
                  projectMgr.updateTaskStatus(msg.projectId as string, msg.taskId as string, "completed");
                }
                relayClient!.send({
                  type: 'register_asset_reply',
                  replyTo: msg.id,
                  from: config.agentId,
                  to: msg.from,
                  ok: true,
                  assetId: asset.id,
                  assetPath: asset.path,
                });
              } catch (err: any) {
                api.logger.error(`[register_asset] failed: ${err.message}`);
                relayClient!.send({
                  type: 'register_asset_reply',
                  replyTo: msg.id,
                  from: config.agentId,
                  to: msg.from,
                  ok: false,
                  error: err.message,
                });
              }
            });
          }

          // PM inbox auto-organizer — periodically scan inbox and register files as project assets.
          // Files may arrive via bridge_send_file without a corresponding register_asset relay message
          // (relay down, bot used wrong tool, etc.). This scanner catches those orphaned files.
          if (config.isProjectManager) {
            const inboxDir = join(workspacePath, '_inbox');
            setInterval(() => {
              try {
                if (!existsSync(inboxDir)) return;
                const agentDirs = readdirSync(inboxDir).filter(d => {
                  const p = join(inboxDir, d);
                  try { return statSync(p).isDirectory(); } catch { return false; }
                });

                // Get all active projects
                const projects = projectMgr.listProjects();
                const activeProjects = (projects.activeProjects || [])
                  .map(p => projectMgr.readProject(p.id))
                  .filter(Boolean);

                for (const agentDir of agentDirs) {
                  const dirPath = join(inboxDir, agentDir);
                  const files = readdirSync(dirPath);
                  for (const file of files) {
                    const filePath = join(dirPath, file);
                    try { if (!statSync(filePath).isFile()) continue; } catch { continue; }

                    // Try to match file to a project by checking if any project slug appears in the filename
                    let matched = false;
                    for (const project of activeProjects) {
                      if (!project) continue;
                      const slug = project.id.replace(/-[a-f0-9]{10}$/, ''); // remove UUID suffix
                      if (file.toLowerCase().includes(slug.toLowerCase()) || file.includes(project.id)) {
                        // Infer asset type from filename
                        let assetType = 'deliverable';
                        const lower = file.toLowerCase();
                        if (lower.includes('brief') || lower.includes('direction')) assetType = 'brief';
                        else if (lower.includes('script') || lower.includes('narration')) assetType = 'script';
                        else if (lower.includes('outline') || lower.includes('plan')) assetType = 'outline';
                        else if (lower.includes('storyboard')) assetType = 'storyboard';
                        else if (lower.includes('asset_list') || lower.includes('assets')) assetType = 'asset-list';
                        else if (lower.match(/\.(jpg|jpeg|png|webp)$/)) assetType = 'img';
                        else if (lower.match(/\.(mp4|mov|webm)$/)) assetType = 'video';

                        const asset = projectMgr.publishAsset(
                          project.id, filePath, assetType,
                          `Auto-organized from inbox/${agentDir}/${file}`,
                          agentDir, // producer = agent directory name
                          '', // taskId unknown
                        );
                        if (asset) {
                          api.logger.info(`[inbox-organizer] Registered ${file} -> project ${project.id} as ${assetType}`);
                          matched = true;
                          break;
                        }
                      }
                    }
                    // If not matched, leave in inbox
                  }
                }
              } catch (err: any) {
                api.logger.error(`[inbox-organizer] Error: ${err.message}`);
              }
            }, 30_000);

            // PM outbox scanner — process fallback queues from workers
            setInterval(async () => {
              try {
                const agents = await discoverAll(registry, offlineThresholdMs);
                for (const agent of agents) {
                  if (agent.agentId === config.agentId) continue; // skip self
                  const outboxPath = join(agent.workspacePath, '_outbox', 'pending_relay.jsonl');
                  if (!existsSync(outboxPath)) continue;
                  const content = readFileSync(outboxPath, 'utf-8').trim();
                  if (!content) continue;
                  const lines = content.split('\n').filter(Boolean);
                  api.logger.info(`[outbox-scanner] Processing ${lines.length} queued messages from ${agent.agentId}`);
                  for (const line of lines) {
                    try {
                      const msg = JSON.parse(line);
                      if (msg.type === 'task_complete') {
                        projectMgr.updateTaskStatus(
                          msg.projectId as string, msg.taskId as string, "completed",
                          { outputs: (msg.outputPaths as string[]) || [] } as any,
                        );
                      } else if (msg.type === 'task_update') {
                        projectMgr.incrementRounds(msg.projectId as string, msg.taskId as string);
                      } else if (msg.type === 'task_blocked') {
                        projectMgr.updateTaskStatus(
                          msg.projectId as string, msg.taskId as string, "blocked",
                          { blockType: msg.blockType, blockReason: msg.reason } as any,
                        );
                      } else if (msg.type === 'register_asset') {
                        const inboxPath = join(workspacePath, "_inbox", msg.from as string, msg.filename as string);
                        if (existsSync(inboxPath)) {
                          projectMgr.publishAsset(
                            msg.projectId as string,
                            inboxPath,
                            (msg.assetType as string) || "deliverable",
                            (msg.description as string) || "",
                            msg.from as string,
                            (msg.taskId as string) || "",
                          );
                          if (msg.taskId) {
                            projectMgr.updateTaskStatus(msg.projectId as string, msg.taskId as string, "completed");
                          }
                        }
                      }
                    } catch { /* skip malformed lines */ }
                  }
                  // Clear the processed file
                  writeFileSync(outboxPath, '', 'utf-8');
                }
              } catch (err: any) {
                api.logger.error(`[outbox-scanner] Error: ${err.message}`);
              }
            }, 60_000); // Every 60 seconds
          }

          // Handle errors from hub
          relayClient.on('error', (msg) => {
            api.logger.error(`Hub error: [${msg.code}] ${msg.message}`);
            if (msg.code === 'AGENT_DISCONNECTED') {
              proxySession.clearSession();
            }
          });
        }

        api.logger.info(`openclaw-bridge: initialized (${config.agentId}, role=${config.role}${config.isProjectManager ? ", isPM=true" : ""})`);
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
        "Send a file to another agent's _inbox/. Use this for intermediate peer collaboration files. NOTE: If you send a file from a `_projects/<projectId>/` path to the PM, this tool will AUTOMATICALLY register the file as a project asset (same as bridge_submit_deliverable) — you don't need a second call. For standalone final deliverables outside a project dir, use bridge_submit_deliverable. After calling, you MUST send the 'sendThisExactMessage' from the result as your Discord reply.",
      parameters: Type.Object({
        targetAgentId: Type.String({ description: "Target agent ID" }),
        localPath: Type.String({
          description: "Relative path within your workspace (e.g., output/task_005.md or _projects/foo-1234/ep0/_docs/script_v1.md)",
        }),
        taskId: Type.Optional(Type.String({ description: "Task ID if this is a task deliverable (used for auto-registration when target is PM)" })),
        assetType: Type.Optional(Type.String({ description: "Asset type override (script, storyboard, brief, img, video, ...). Auto-inferred from path if omitted." })),
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
        const localPath = params.localPath as string;
        const originalName = localPath.split(/[\\/]/).pop()!;
        const actualName = result.filename ?? originalName;
        const wasRenamed = result.renamed === true;

        // Auto-register as project asset when the target is the PM.
        // If the file lives under _projects/<projectId>/, extract projectId from path.
        // For files outside _projects/ (e.g. _outbox/, root workspace), still send
        // register_asset with assetType "deliverable" and a description derived from filename.
        let autoRegistered: { ok: boolean; assetId?: string; error?: string } | null = null;
        const isPmTarget = (params.targetAgentId as string) === "pm";
        if (isPmTarget && relayClient?.isConnected) {
          const projectMatch = localPath.match(/_projects[\\/]([^\\/]+)[\\/]/);
          const projectId = projectMatch ? projectMatch[1] : "";

          // Infer assetType from path if not provided
          let assetType = (params.assetType as string) || "deliverable";
          if (!params.assetType) {
            const lower = localPath.toLowerCase();
            if (lower.includes("/_briefs/") || lower.includes("\\_briefs\\")) assetType = "brief";
            else if (lower.includes("storyboard")) assetType = "storyboard";
            else if (lower.includes("script")) assetType = "script";
            else if (lower.includes("outline")) assetType = "outline";
            else if (lower.match(/\.(jpg|jpeg|png|webp|gif)$/)) assetType = "img";
            else if (lower.match(/\.(mp4|mov|webm)$/)) assetType = "video";
          }

          // Build a human-readable description from the filename when outside _projects/
          const description = projectMatch
            ? `Auto-registered from bridge_send_file: ${originalName}`
            : `Deliverable from ${config.agentId}: ${originalName.replace(/[-_]/g, " ").replace(/\.[^.]+$/, "")}`;

          const msgId = `auto_register_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
          try {
            const reply = await relayClient.sendAndWait({
              type: 'register_asset',
              id: msgId,
              from: config.agentId,
              to: params.targetAgentId as string,
              projectId,
              filename: actualName,
              assetType,
              description,
              taskId: (params.taskId as string) || "",
            }, 20_000) as { ok: boolean; assetId?: string; error?: string };
            autoRegistered = reply;

            // Auto-post file to project thread for Discord visibility
            if (reply.ok && discordApi.isAvailable) {
              try {
                const projectReply = await askPm('query_project', { projectId: projectId || "" });
                const threadId = projectReply?.project?.threadId;
                if (threadId) {
                  const displayName = localPath.split(/[\\/]/).pop() || "file";
                  await discordApi.sendMessageWithFile(
                    threadId,
                    join(workspacePath, localPath),
                    `📎 **File from ${config.agentName}**: ${displayName}`,
                  );
                }
              } catch { /* auto-post is best-effort */ }
            }
          } catch (err: any) {
            autoRegistered = { ok: false, error: err.message };
          }
        }

        const renameNote = wasRenamed ? ` ⚠️ (renamed from "${originalName}" — duplicate existed)` : "";
        const registerNote = autoRegistered?.ok
          ? ` Registered as project asset ${autoRegistered.assetId}.`
          : autoRegistered && !autoRegistered.ok
            ? ` (Auto-registration to PM failed: ${autoRegistered.error})`
            : "";

        return {
          success: true,
          filename: actualName,
          renamed: wasRenamed,
          autoRegistered: autoRegistered?.ok === true,
          assetId: autoRegistered?.assetId,
          sendThisExactMessage: `${mention} Sent you a file: ${actualName}${renameNote}, it's in your _inbox/ directory, please check.${registerNote}`,
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
      description: "Create a Discord Thread for a project in the current channel. Auto-adds agent bots + the optional creator user so the thread appears in their Discord sidebar. Returns threadId.",
      parameters: Type.Object({
        projectName: Type.String({ description: "Project name for the thread title" }),
        agentIds: Type.Array(Type.String(), { description: "Agent IDs to add to the thread" }),
        projectId: Type.Optional(Type.String({ description: "Project ID — if the project already has a thread, returns it instead of creating a duplicate" })),
        creatorUserId: Type.Optional(Type.String({ description: "Discord user ID of the human who requested the project — auto-added so thread shows in their sidebar" })),
      }),
      async execute(_id, params) {
        assertPermission("create_project_thread", config);
        // Idempotent: if project already has a thread, return it
        if (params.projectId) {
          const existing = projectMgr.readProject(params.projectId as string);
          if (existing?.threadId) {
            return { threadId: existing.threadId, threadName: `(existing thread)`, alreadyExisted: true };
          }
        }
        if (!discordApi.isAvailable) return { error: "Discord API not available — no bot token configured" };
        const projectName = params.projectName as string;
        const agentIds = params.agentIds as string[];

        const discordChannel = entry.channels.find(c => c.type === "discord");
        if (!discordChannel) return { error: "No Discord channel configured for this agent" };

        const agents = await discoverAll(registry, offlineThresholdMs);
        const hits = agentIds
          .map(id => agents.find(a => a.agentId === id))
          .filter(Boolean) as any[];
        const mentions = hits.map(a => a.discordId ? `<@${a.discordId}>` : a.agentName).join(" ");

        const thread = await discordApi.createThread(
          discordChannel.channelId,
          `🎬 ${projectName} — PM Managed`.substring(0, 100),
          `📋 **Project: ${projectName}**\n\nTeam: ${mentions}\n\nProject thread created. Updates will be posted here.`,
        );
        // Auto-add agents + creator to thread so it shows in sidebar
        const toAdd = new Set<string>();
        for (const a of hits) if (a.discordId) toAdd.add(a.discordId);
        if (params.creatorUserId) toAdd.add(params.creatorUserId as string);
        const added: string[] = [];
        for (const uid of toAdd) {
          if (await discordApi.addThreadMember(thread.id, uid)) added.push(uid);
        }
        return { threadId: thread.id, threadName: thread.name, threadMembersAdded: added };
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
        assertPermission("create_sub_thread", config);
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

    // bridge_post_file: upload any file (images, scripts, docs) to a Discord thread/channel
    const postFileExecute = async (_id: string, params: Record<string, unknown>) => {
      if (!discordApi.isAvailable) return { error: "Discord API not available" };
      const fullPath = join(workspacePath, params.filePath as string);
      if (!existsSync(fullPath)) return { error: `File not found: ${params.filePath}` };
      try {
        const msg = await discordApi.sendMessageWithFile(
          params.channelOrThreadId as string,
          fullPath,
          (params.caption as string) || undefined,
        );
        return { success: true, messageId: msg.id };
      } catch (err: any) {
        return { error: err.message };
      }
    };
    const postFileParams = Type.Object({
      channelOrThreadId: Type.String({ description: "Discord Channel or Thread ID to post to" }),
      filePath: Type.String({ description: "Local path to the file (relative to workspace) — images, scripts, docs, videos all supported" }),
      caption: Type.Optional(Type.String({ description: "Optional text caption (e.g. 'Shot 1 — hero portrait' or 'Final script v1')" })),
    });

    api.registerTool({
      name: "bridge_post_file",
      label: "Bridge Post File",
      description: "Upload any file (image, script, document, video) to a Discord Thread or Channel. Users can preview images and download files directly from Discord. Use this to share your work visibly in the project thread.",
      parameters: postFileParams,
      async execute(_id, params) { return postFileExecute(_id, params); },
    });
    // Keep bridge_post_image as alias for backward compatibility
    api.registerTool({
      name: "bridge_post_image",
      label: "Bridge Post Image",
      description: "Post an image to a Discord Thread (alias for bridge_post_file). Supports PNG, JPG, and other image formats.",
      parameters: postFileParams,
      async execute(_id, params) { return postFileExecute(_id, params); },
    });

    // ── Project Management Tools ─────────────────────────────────────

    api.registerTool({
      name: "bridge_project_create",
      label: "Bridge Project Create",
      description: "Initialize a new project with directory structure, state tracking, and auto-create a Discord Thread for visibility. The triggering user + all assigned agents are auto-added to the thread so it appears in their Discord sidebar.",
      parameters: Type.Object({
        name: Type.String({ description: "Project name" }),
        description: Type.String({ description: "Brief project description" }),
        agentIds: Type.Optional(Type.Array(Type.String(), { description: "Agent IDs assigned to this project — they'll be auto-added to the thread" })),
        creatorUserId: Type.Optional(Type.String({ description: "Discord user ID of the human who requested the project — they'll be auto-added to the thread so it appears in their sidebar" })),
      }),
      async execute(_id, params) {
        assertPermission("project_create", config);
        const project = projectMgr.createProject(params.name as string, params.description as string);
        if (params.creatorUserId) {
          (project as any).creatorUserId = params.creatorUserId as string;
          projectMgr.writeProject(project);
        }
        const result: Record<string, unknown> = {
          projectId: project.id,
          projectDir: projectMgr.getProjectDir(project.id),
        };

        // Auto-create Discord Thread for project visibility
        api.logger.info(`[bridge_project_create] discordApi.isAvailable=${discordApi.isAvailable} entry.channels=${JSON.stringify(entry.channels)}`);
        if (discordApi.isAvailable) {
          const discordChannel = entry.channels.find(c => c.type === "discord");
          api.logger.info(`[bridge_project_create] discordChannel=${JSON.stringify(discordChannel)}`);
          if (discordChannel) {
            try {
              const agentIds = (params.agentIds as string[]) || [];
              const agents = await discoverAll(registry, offlineThresholdMs);
              const agentDiscordIds: string[] = [];
              let mentions = "(team will be assigned via tasks)";
              if (agentIds.length > 0) {
                const hits = agentIds
                  .map(id => agents.find(a => a.agentId === id))
                  .filter(Boolean) as any[];
                for (const a of hits) {
                  if (a.discordId) agentDiscordIds.push(a.discordId);
                }
                mentions = hits
                  .map(a => a.discordId ? `<@${a.discordId}>` : a.agentName)
                  .join(" ") || mentions;
              }
              const thread = await discordApi.createThread(
                discordChannel.channelId,
                `🎬 ${params.name as string} — PM Managed`.substring(0, 100),
                `📋 **Project: ${params.name as string}**\n\n${params.description as string}\n\nTeam: ${mentions}\n\nProject thread created. All updates will be posted here.`,
              );
              project.threadId = thread.id;
              projectMgr.writeProject(project);
              result.threadId = thread.id;
              result.threadName = thread.name;

              // Auto-add creator + all participating agents so thread shows in sidebar
              const added: string[] = [];
              const toAdd = new Set<string>(agentDiscordIds);
              if (params.creatorUserId) toAdd.add(params.creatorUserId as string);
              for (const uid of toAdd) {
                if (await discordApi.addThreadMember(thread.id, uid)) added.push(uid);
              }
              result.threadMembersAdded = added;
            } catch (err) {
              result.threadError = String(err);
            }
          }
        }

        return result;
      },
    });

    api.registerTool({
      name: "bridge_project_status",
      label: "Bridge Project Status",
      description: "Get project status. Omit projectId to see all active projects. Routes through PM for non-PM agents.",
      parameters: Type.Object({
        projectId: Type.Optional(Type.String({ description: "Project ID (omit for global overview)" })),
      }),
      async execute(_id, params) {
        if (!config.isProjectManager) {
          try {
            const reply = await askPm('query_project', { projectId: params.projectId });
            if (!reply.ok) return { error: reply.error };
            return reply.project ? { project: reply.project } : { projects: reply.projects };
          } catch (err: any) { return { error: err.message }; }
        }
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
      description: "Assign a task to an agent within a project. Sends the brief via Bridge Hub relay.",
      parameters: Type.Object({
        projectId: Type.String({ description: "Project ID" }),
        agentId: Type.String({ description: "Agent to assign to" }),
        title: Type.String({ description: "Task title" }),
        brief: Type.String({ description: "Detailed task brief with asset paths" }),
        dependencies: Type.Optional(Type.Array(Type.String(), { description: "Task IDs that must complete first" })),
      }),
      async execute(_id, params) {
        assertPermission("task_assign", config);
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

        // Auto-add assigned agent to the project's main thread (so Discord resolves mentions)
        if (discordApi.isAvailable) {
          try {
            const project = projectMgr.readProject(params.projectId as string);
            if (project?.threadId) {
              const agentDiscordId = resolveAgentDiscordId(params.agentId as string);
              if (agentDiscordId) {
                await discordApi.addThreadMember(project.threadId, agentDiscordId);
                api.logger.info(`[task_assign] Added ${params.agentId} (${agentDiscordId}) to thread ${project.threadId}`);
              } else {
                api.logger.warn(`[task_assign] Cannot find discordId for ${params.agentId}`);
              }
            }
          } catch (err: any) {
            api.logger.error(`[task_assign] addThreadMember error: ${err.message}`);
          }
        }

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
                payload: `[Project: ${params.projectId}] [Task: ${task.id}]\n\n⚠️ IMPORTANT: When calling bridge_task_complete or bridge_submit_deliverable, use EXACTLY these IDs:\n- projectId: "${params.projectId}"\n- taskId: "${task.id}"\nDo NOT use project names or task labels like "T1".\n\n${params.brief}`,
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
      description: "Post a progress update / thinking summary to the project's main Thread. Routes through PM for non-PM agents.",
      parameters: Type.Object({
        projectId: Type.String({ description: "Project ID" }),
        taskId: Type.String({ description: "Task ID" }),
        summary: Type.String({ description: "Progress summary" }),
      }),
      async execute(_id, params) {
        if (!config.isProjectManager) {
          try {
            const reply = await askPm('task_update', {
              projectId: params.projectId, taskId: params.taskId, summary: params.summary,
            });
            return reply.ok ? { success: true, posted: reply.posted } : { error: reply.error };
          } catch (err: any) { return { error: err.message }; }
        }
        // PM-local path
        const project = projectMgr.readProject(params.projectId as string);
        if (!project) return { error: "Project not found" };
        const task = project.tasks.find(t => t.id === params.taskId);
        if (!task) return { error: "Task not found" };
        if (project.threadId && discordApi.isAvailable) {
          const agents = await discoverAll(registry, offlineThresholdMs);
          const mentionMap = buildMentionMap(agents);
          const processed = applyMentions(`📊 **${task.title}** (${config.agentName}): ${params.summary}`, mentionMap);
          await discordApi.sendMessage(project.threadId, processed);
        }
        return { success: true };
      },
    });

    api.registerTool({
      name: "bridge_task_complete",
      label: "Bridge Task Complete",
      description: "Mark a task as completed with summary and output paths. Routes through PM for non-PM agents.",
      parameters: Type.Object({
        projectId: Type.String({ description: "Project ID" }),
        taskId: Type.String({ description: "Task ID" }),
        summary: Type.String({ description: "Completion summary" }),
        outputPaths: Type.Optional(Type.Array(Type.String(), { description: "Output file paths" })),
      }),
      async execute(_id, params) {
        const outputs = (params.outputPaths as string[]) || [];
        if (!config.isProjectManager) {
          try {
            const reply = await askPm('task_complete', {
              projectId: params.projectId, taskId: params.taskId,
              summary: params.summary, outputPaths: outputs,
            });
            return reply.ok ? { taskId: reply.taskId, status: reply.status, outputs } : { error: reply.error };
          } catch (err: any) { return { error: err.message }; }
        }
        const task = projectMgr.updateTaskStatus(
          params.projectId as string, params.taskId as string, "completed", { outputs } as any,
        );
        if (!task) return { error: "Task or project not found" };
        return { taskId: task.id, status: "completed", outputs };
      },
    });

    api.registerTool({
      name: "bridge_task_blocked",
      label: "Bridge Task Blocked",
      description: "Report that a task is blocked. Types: capability_missing, dependency_failed, clarification_needed. Routes through PM for non-PM agents.",
      parameters: Type.Object({
        projectId: Type.String({ description: "Project ID" }),
        taskId: Type.String({ description: "Task ID" }),
        blockType: Type.String({ description: "capability_missing | dependency_failed | clarification_needed" }),
        reason: Type.String({ description: "Detailed blocker explanation" }),
      }),
      async execute(_id, params) {
        if (!config.isProjectManager) {
          try {
            const reply = await askPm('task_blocked', {
              projectId: params.projectId, taskId: params.taskId,
              blockType: params.blockType, reason: params.reason,
            });
            return reply.ok ? { taskId: reply.taskId, status: reply.status, blockType: reply.blockType } : { error: reply.error };
          } catch (err: any) { return { error: err.message }; }
        }
        const task = projectMgr.updateTaskStatus(
          params.projectId as string, params.taskId as string, "blocked",
          { blockType: params.blockType as any, blockReason: params.reason as string },
        );
        if (!task) return { error: "Task or project not found" };
        return { taskId: task.id, status: "blocked", blockType: params.blockType };
      },
    });

    // ── Asset Management Tools ───────────────────────────────────────

    api.registerTool({
      name: "bridge_submit_deliverable",
      label: "Bridge Submit Deliverable",
      description: "Submit a final deliverable file to the PM for central project asset management. Use this instead of bridge_asset_publish — only PM can publish assets directly. This sends the file to PM's _inbox AND registers it in the project. After calling, you MUST post the returned 'sendThisExactMessage' to Discord.",
      parameters: Type.Object({
        projectId: Type.String({ description: "PM's project ID (from your task brief)" }),
        filePath: Type.String({ description: "Local path in your workspace to the deliverable file" }),
        assetType: Type.String({ description: "Asset type: script, storyboard, direction-brief, video, etc." }),
        description: Type.String({ description: "Brief description of the deliverable" }),
        taskId: Type.String({ description: "Task ID that produced this asset" }),
        pmAgentId: Type.Optional(Type.String({ description: "PM agent ID (defaults to 'pm')" })),
      }),
      async execute(_id, params) {
        assertPermission("submit_deliverable", config);
        const pmId = (params.pmAgentId as string) || "pm";
        const pm = await registry.findAgent(pmId, offlineThresholdMs);
        if (!pm) return { error: `PM agent "${pmId}" not found online. Use bridge_discover to see available PMs.` };

        // Step 1: send the file to PM's _inbox/<myAgentId>/
        const sendResult = await fileOps.sendFile(pm, params.filePath as string) as {
          delivered: boolean; filename?: string; renamed?: boolean;
        };
        if (!sendResult.delivered) return { error: "File transfer to PM failed" };
        const filename = sendResult.filename ?? (params.filePath as string).split(/[\\/]/).pop()!;

        // Step 2: send register_asset message and wait for PM to process
        if (!relayClient?.isConnected) return { error: "Message relay not connected; cannot notify PM" };
        const msgId = `register_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        try {
          const reply = await relayClient.sendAndWait({
            type: 'register_asset',
            id: msgId,
            from: config.agentId,
            to: pmId,
            projectId: params.projectId as string,
            filename,
            assetType: params.assetType as string,
            description: params.description as string,
            taskId: params.taskId as string,
          }, 30_000) as { ok: boolean; assetId?: string; assetPath?: string; error?: string };

          if (!reply.ok) return { error: `PM rejected asset: ${reply.error}` };

          // Auto-post file to project thread for Discord visibility
          if (discordApi.isAvailable) {
            try {
              const projectReply = await askPm('query_project', { projectId: params.projectId });
              const threadId = projectReply?.project?.threadId;
              if (threadId) {
                const displayName = (params.filePath as string).split(/[\\/]/).pop() || "deliverable";
                await discordApi.sendMessageWithFile(
                  threadId,
                  join(workspacePath, params.filePath as string),
                  `📎 **Deliverable from ${config.agentName}**: ${displayName}\n${params.description || ""}`,
                );
              }
            } catch { /* auto-post is best-effort */ }
          }

          const mention = pm.discordId ? `<@${pm.discordId}>` : pm.agentName;
          return {
            success: true,
            assetId: reply.assetId,
            assetPath: reply.assetPath,
            sendThisExactMessage: `${mention} Deliverable submitted: ${filename} (task ${params.taskId}, type ${params.assetType}). Registered as ${reply.assetId}.`,
          };
        } catch (err: any) {
          return { error: `Failed to register with PM: ${err.message}` };
        }
      },
    });

    api.registerTool({
      name: "bridge_asset_publish",
      label: "Bridge Asset Publish",
      description: "PM only: publish an output asset directly to the project's asset directory. Non-PM agents should use bridge_submit_deliverable instead.",
      parameters: Type.Object({
        projectId: Type.String({ description: "Project ID" }),
        filePath: Type.String({ description: "Path to file (relative to workspace)" }),
        assetType: Type.String({ description: "Asset type: storyboard, script, reference-images, video, etc." }),
        description: Type.String({ description: "Brief description" }),
        taskId: Type.String({ description: "Task ID that produced this asset" }),
      }),
      async execute(_id, params) {
        assertPermission("asset_publish", config);
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
      description: "List all assets in a project, optionally filtered. Routes through PM for non-PM agents.",
      parameters: Type.Object({
        projectId: Type.String({ description: "Project ID" }),
        type: Type.Optional(Type.String({ description: "Filter by asset type" })),
        agent: Type.Optional(Type.String({ description: "Filter by producer agent ID" })),
      }),
      async execute(_id, params) {
        if (!config.isProjectManager) {
          try {
            const reply = await askPm('query_assets', {
              projectId: params.projectId, type: params.type, agent: params.agent,
            });
            return reply.ok ? { assets: reply.assets } : { error: reply.error };
          } catch (err: any) { return { error: err.message }; }
        }
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
      description: "Get the full path and metadata of a specific asset. Routes through PM for non-PM agents.",
      parameters: Type.Object({
        projectId: Type.String({ description: "Project ID" }),
        assetId: Type.Optional(Type.String({ description: "Asset ID" })),
        assetType: Type.Optional(Type.String({ description: "Asset type to find latest of" })),
      }),
      async execute(_id, params) {
        if (!config.isProjectManager) {
          try {
            const reply = await askPm('query_asset', {
              projectId: params.projectId, assetId: params.assetId, assetType: params.assetType,
            });
            return reply.ok ? reply.asset : { error: reply.error };
          } catch (err: any) { return { error: err.message }; }
        }
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
