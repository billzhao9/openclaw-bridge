import WebSocket from "ws";
import { getMachineId } from "../config.js";
export class ManagerHubClient {
    hubUrl;
    apiKey;
    managerPass;
    machineId;
    ws = null;
    _connected = false;
    reconnectDelay = 1000;
    logger;
    onCommand = null;
    constructor(hubUrl, apiKey, managerPass, logger) {
        this.hubUrl = hubUrl;
        this.apiKey = apiKey;
        this.managerPass = managerPass;
        this.machineId = getMachineId();
        this.logger = logger;
    }
    get connected() {
        return this._connected;
    }
    async connect() {
        return new Promise((resolve, reject) => {
            const wsUrl = this.hubUrl.replace(/^http/, "ws") + "/ws/manager";
            this.ws = new WebSocket(wsUrl);
            this.ws.on("open", () => {
                this.ws.send(JSON.stringify({
                    type: "auth",
                    role: "manager",
                    machineId: this.machineId,
                    apiKey: this.apiKey,
                    managerPass: this.managerPass,
                }));
            });
            this.ws.on("message", (data) => {
                const msg = JSON.parse(data.toString());
                if (msg.type === "auth_ok") {
                    this._connected = true;
                    this.reconnectDelay = 1000;
                    this.logger.info(`[local-manager] Hub connected as ${this.machineId}`);
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
                this.logger.warn(`[local-manager] Hub disconnected, reconnecting in ${this.reconnectDelay}ms...`);
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
    sendStatus(agents, logs) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({
                type: "manager_status",
                machineId: this.machineId,
                agents,
                logs,
            }));
        }
    }
    sendResult(action, target, success) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type: "manager_result", action, target, success }));
        }
    }
    disconnect() {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
            this._connected = false;
        }
    }
}
