import WebSocket from "ws";
import { hostname } from "node:os";
import type { PluginLogger } from "../types.js";

export class ManagerHubClient {
  private hubUrl: string;
  private apiKey: string;
  private managerPass: string;
  private machineId: string;
  private ws: WebSocket | null = null;
  private _connected = false;
  private reconnectDelay = 1000;
  private logger: PluginLogger;
  onCommand: ((msg: any) => void) | null = null;

  constructor(
    hubUrl: string,
    apiKey: string,
    managerPass: string,
    logger: PluginLogger,
  ) {
    this.hubUrl = hubUrl;
    this.apiKey = apiKey;
    this.managerPass = managerPass;
    this.machineId = hostname();
    this.logger = logger;
  }

  get connected(): boolean {
    return this._connected;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const wsUrl = this.hubUrl.replace(/^http/, "ws") + "/ws/manager";
      this.ws = new WebSocket(wsUrl);

      this.ws.on("open", () => {
        this.ws!.send(
          JSON.stringify({
            type: "auth",
            role: "manager",
            machineId: this.machineId,
            apiKey: this.apiKey,
            managerPass: this.managerPass,
          }),
        );
      });

      this.ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === "auth_ok") {
          this._connected = true;
          this.reconnectDelay = 1000;
          this.logger.info(
            `[local-manager] Hub connected as ${this.machineId}`,
          );
          resolve();
          return;
        }
        if (msg.type === "auth_error") {
          reject(new Error(msg.reason));
          return;
        }
        if (msg.type === "manager_command" && this.onCommand) {
          this.onCommand(msg);
        }
      });

      this.ws.on("close", () => {
        this._connected = false;
        this.logger.warn(
          `[local-manager] Hub disconnected, reconnecting in ${this.reconnectDelay}ms...`,
        );
        setTimeout(() => {
          this.connect().catch(() => {
            this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
          });
        }, this.reconnectDelay);
      });

      this.ws.on("error", (err) => {
        this.logger.error(`[local-manager] Hub error: ${err.message}`);
      });
    });
  }

  sendStatus(agents: any[], logs?: Record<string, string>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({
          type: "manager_status",
          machineId: this.machineId,
          agents,
          logs,
        }),
      );
    }
  }

  sendResult(action: string, target: string, success: boolean): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "manager_result", action, target, success }));
    }
  }

  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
      this._connected = false;
    }
  }
}
