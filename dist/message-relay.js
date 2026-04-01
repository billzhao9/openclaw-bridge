import WebSocket from 'ws';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// Read version from package.json at module load time
let BRIDGE_VERSION = 'unknown';
try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    BRIDGE_VERSION = JSON.parse(readFileSync(pkgPath, 'utf-8')).version;
}
catch { }
export class MessageRelayClient {
    ws = null;
    agentId;
    config;
    logger;
    handlers = new Map();
    reconnectDelay = 1000;
    maxReconnectDelay = 30000;
    shouldReconnect = true;
    authenticated = false;
    reconnectTimer = null;
    pendingCallbacks = new Map();
    machineId;
    originalAgentId;
    originalAgentName = '';
    conflictRetries = 0;
    maxConflictRetries = 5;
    onConflictRename = null;
    constructor(agentId, config, logger, machineId) {
        this.agentId = agentId;
        this.originalAgentId = agentId;
        this.config = config;
        this.logger = logger;
        this.machineId = machineId;
    }
    setAgentName(name) {
        if (!this.originalAgentName)
            this.originalAgentName = name;
    }
    setOnConflictRename(cb) {
        this.onConflictRename = cb;
    }
    async connect() {
        // Clean up any existing connection
        if (this.ws) {
            try {
                this.ws.removeAllListeners();
                this.ws.close();
            }
            catch { }
            this.ws = null;
        }
        this.authenticated = false;
        return new Promise((resolve, reject) => {
            let settled = false;
            const settle = (fn, arg) => {
                if (!settled) {
                    settled = true;
                    fn(arg);
                }
            };
            try {
                this.ws = new WebSocket(this.config.url);
                // Auth timeout — if no auth_ok within 10s, fail
                const authTimer = setTimeout(() => {
                    settle(reject, new Error('Auth timeout'));
                    if (this.ws) {
                        try {
                            this.ws.close();
                        }
                        catch { }
                    }
                }, 10_000);
                this.ws.on('open', () => {
                    this.logger.info('Connected to Message Relay Hub');
                    this.ws.send(JSON.stringify({
                        type: 'auth',
                        agentId: this.agentId,
                        apiKey: this.config.apiKey,
                        machineId: this.machineId,
                        bridgeVersion: BRIDGE_VERSION,
                    }));
                });
                this.ws.on('message', (data) => {
                    let msg;
                    try {
                        msg = JSON.parse(data.toString());
                    }
                    catch {
                        return;
                    }
                    if (msg.type === 'auth_ok') {
                        clearTimeout(authTimer);
                        this.authenticated = true;
                        this.reconnectDelay = 1000; // Reset on success
                        this.logger.info('Authenticated with Message Relay Hub');
                        settle(resolve);
                        return;
                    }
                    if (msg.type === 'auth_error') {
                        clearTimeout(authTimer);
                        this.logger.error(`Auth failed: ${msg.reason}`);
                        settle(reject, new Error(msg.reason));
                        return;
                    }
                    if (msg.type === 'auth_conflict') {
                        clearTimeout(authTimer);
                        this.conflictRetries++;
                        if (this.conflictRetries > this.maxConflictRetries) {
                            this.logger.error(`agentId conflict: max retries (${this.maxConflictRetries}) exhausted, giving up`);
                            this.shouldReconnect = false;
                            settle(reject, new Error('agentId conflict: max retries exhausted'));
                            return;
                        }
                        let newAgentId;
                        if (this.conflictRetries === 1) {
                            newAgentId = msg.suggestedId;
                        }
                        else {
                            const base = `${this.originalAgentId}@${this.machineId}`;
                            newAgentId = `${base}-${this.conflictRetries - 1}`;
                        }
                        const newAgentName = this.originalAgentName
                            ? `${this.originalAgentName} (${this.machineId})`
                            : newAgentId;
                        this.logger.info(`agentId "${this.agentId}" conflicts with machine "${msg.existingMachine}", renaming to "${newAgentId}"`);
                        this.agentId = newAgentId;
                        if (this.onConflictRename) {
                            this.onConflictRename(newAgentId, newAgentName);
                        }
                        settle(reject, new Error('auth_conflict - reconnecting with new name'));
                        if (this.ws) {
                            try {
                                this.ws.close();
                            }
                            catch { }
                        }
                        this.reconnectDelay = 100;
                        return;
                    }
                    // Check for pending request callbacks (replyTo or sessionId)
                    const callbackKey = msg.replyTo || msg.sessionId;
                    if (callbackKey && this.pendingCallbacks.has(callbackKey)) {
                        const cb = this.pendingCallbacks.get(callbackKey);
                        clearTimeout(cb.timer);
                        this.pendingCallbacks.delete(callbackKey);
                        cb.resolve(msg);
                        return;
                    }
                    // Dispatch to type-based handlers
                    const handlers = this.handlers.get(msg.type) || [];
                    for (const handler of handlers) {
                        try {
                            handler(msg);
                        }
                        catch (e) {
                            this.logger.error(`Handler error for ${msg.type}: ${e.message}`);
                        }
                    }
                });
                this.ws.on('close', (code) => {
                    clearTimeout(authTimer);
                    this.authenticated = false;
                    this.logger.info(`Disconnected from Hub (code: ${code})`);
                    settle(reject, new Error('Connection closed'));
                    if (this.shouldReconnect) {
                        this.scheduleReconnect();
                    }
                });
                this.ws.on('error', (err) => {
                    this.logger.error(`WebSocket error: ${err.message}`);
                    // Don't settle here — let 'close' event handle it
                });
            }
            catch (err) {
                settle(reject, err);
                // No 'close' event will fire if constructor threw — schedule reconnect manually
                if (this.shouldReconnect) {
                    this.scheduleReconnect();
                }
            }
        });
    }
    scheduleReconnect() {
        // Prevent multiple reconnect timers
        if (this.reconnectTimer)
            return;
        this.logger.info(`Reconnecting in ${this.reconnectDelay}ms...`);
        this.reconnectTimer = setTimeout(async () => {
            this.reconnectTimer = null;
            try {
                await this.connect();
                this.logger.info('Reconnected to Message Relay Hub');
            }
            catch {
                this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
                // If connect() failure didn't trigger 'close' (e.g., constructor threw),
                // scheduleReconnect was already called in the catch block above.
                // If 'close' did fire, scheduleReconnect is called from the close handler.
                // Either way, the next reconnect is already scheduled.
            }
        }, this.reconnectDelay);
    }
    on(type, handler) {
        const existing = this.handlers.get(type) || [];
        existing.push(handler);
        this.handlers.set(type, existing);
    }
    send(msg) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN && this.authenticated) {
            this.ws.send(JSON.stringify(msg));
        }
    }
    async sendAndWait(msg, timeoutMs = 60_000) {
        return new Promise((resolve, reject) => {
            const id = msg.id || msg.sessionId;
            const timer = setTimeout(() => {
                this.pendingCallbacks.delete(id);
                reject(new Error(`Timeout waiting for reply to ${id}`));
            }, timeoutMs);
            this.pendingCallbacks.set(id, { resolve, reject, timer });
            this.send(msg);
        });
    }
    async disconnect() {
        this.shouldReconnect = false;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        for (const [id, cb] of this.pendingCallbacks.entries()) {
            clearTimeout(cb.timer);
            cb.reject(new Error('Disconnecting'));
        }
        this.pendingCallbacks.clear();
        if (this.ws) {
            this.ws.removeAllListeners();
            this.ws.close(1000, 'plugin deactivated');
            this.ws = null;
        }
        this.authenticated = false;
    }
    get isConnected() {
        return this.ws !== null && this.ws.readyState === WebSocket.OPEN && this.authenticated;
    }
}
