import WebSocket from 'ws';
import type { PluginLogger, MessageRelayConfig } from './types.js';

type MessageHandler = (msg: any) => void;

export class MessageRelayClient {
  private ws: WebSocket | null = null;
  private agentId: string;
  private config: MessageRelayConfig;
  private logger: PluginLogger;
  private handlers = new Map<string, MessageHandler[]>();
  private reconnectDelay = 1000;
  private maxReconnectDelay = 30000;
  private shouldReconnect = true;
  private pendingCallbacks = new Map<string, {
    resolve: (msg: any) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  constructor(agentId: string, config: MessageRelayConfig, logger: PluginLogger) {
    this.agentId = agentId;
    this.config = config;
    this.logger = logger;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.config.url);

        this.ws.on('open', () => {
          this.logger.info('Connected to Message Relay Hub');
          this.reconnectDelay = 1000;

          this.ws!.send(JSON.stringify({
            type: 'auth',
            agentId: this.agentId,
            apiKey: this.config.apiKey,
          }));
        });

        this.ws.on('message', (data) => {
          let msg: any;
          try {
            msg = JSON.parse(data.toString());
          } catch {
            return;
          }

          if (msg.type === 'auth_ok') {
            this.logger.info('Authenticated with Message Relay Hub');
            resolve();
            return;
          }

          if (msg.type === 'auth_error') {
            this.logger.error(`Auth failed: ${msg.reason}`);
            reject(new Error(msg.reason));
            return;
          }

          // Check for pending request callbacks
          if (msg.replyTo && this.pendingCallbacks.has(msg.replyTo)) {
            const cb = this.pendingCallbacks.get(msg.replyTo)!;
            clearTimeout(cb.timer);
            this.pendingCallbacks.delete(msg.replyTo);
            cb.resolve(msg);
            return;
          }

          // Also check sessionId for handoff ack
          if (msg.sessionId && this.pendingCallbacks.has(msg.sessionId)) {
            const cb = this.pendingCallbacks.get(msg.sessionId)!;
            clearTimeout(cb.timer);
            this.pendingCallbacks.delete(msg.sessionId);
            cb.resolve(msg);
            return;
          }

          // Dispatch to type-based handlers
          const handlers = this.handlers.get(msg.type) || [];
          for (const handler of handlers) {
            handler(msg);
          }
        });

        this.ws.on('close', () => {
          this.logger.info('Disconnected from Message Relay Hub');
          if (this.shouldReconnect) {
            this.scheduleReconnect();
          }
        });

        this.ws.on('error', (err) => {
          this.logger.error(`WebSocket error: ${err.message}`);
        });
      } catch (err: any) {
        reject(err);
      }
    });
  }

  private scheduleReconnect(): void {
    this.logger.info(`Reconnecting in ${this.reconnectDelay}ms...`);
    setTimeout(() => {
      this.connect().catch(() => {
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
      });
    }, this.reconnectDelay);
  }

  on(type: string, handler: MessageHandler): void {
    const existing = this.handlers.get(type) || [];
    existing.push(handler);
    this.handlers.set(type, existing);
  }

  send(msg: any): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  async sendAndWait(msg: any, timeoutMs = 60_000): Promise<any> {
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

  async disconnect(): Promise<void> {
    this.shouldReconnect = false;
    for (const [id, cb] of this.pendingCallbacks.entries()) {
      clearTimeout(cb.timer);
      cb.reject(new Error('Disconnecting'));
    }
    this.pendingCallbacks.clear();

    if (this.ws) {
      this.ws.close(1000, 'plugin deactivated');
      this.ws = null;
    }
  }

  get isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }
}
