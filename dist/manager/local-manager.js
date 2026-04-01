import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ManagerHubClient } from "./hub-client.js";
import { listProcesses, getProcessLogs, restartProcess, stopProcess, startProcess, stopAll, } from "./pm2-bridge.js";
const LOCK_FILE = join(tmpdir(), "openclaw-local-manager.lock");
function acquireLock() {
    if (existsSync(LOCK_FILE)) {
        try {
            const pid = parseInt(readFileSync(LOCK_FILE, "utf-8").trim(), 10);
            process.kill(pid, 0);
            return false;
        }
        catch {
            // Process is dead, steal the lock
        }
    }
    writeFileSync(LOCK_FILE, String(process.pid));
    return true;
}
function releaseLock() {
    try {
        unlinkSync(LOCK_FILE);
    }
    catch { }
}
export class LocalManager {
    config;
    apiKey;
    logger;
    hubClient = null;
    statusTimer = null;
    hasLock = false;
    constructor(config, apiKey, logger) {
        this.config = config;
        this.apiKey = apiKey;
        this.logger = logger;
    }
    async start() {
        if (!this.config.enabled)
            return;
        this.hasLock = acquireLock();
        if (!this.hasLock) {
            this.logger.info("[local-manager] Another instance is already managing this machine, skipping");
            return;
        }
        this.hubClient = new ManagerHubClient(this.config.hubUrl, this.apiKey, this.config.managerPass, this.logger);
        this.hubClient.onCommand = async (msg) => {
            const processes = await listProcesses();
            let target = msg.target;
            if (msg.action !== "restart-all" && msg.action !== "stop-all") {
                const match = processes.find((p) => p.agentId === msg.target || p.name === msg.target);
                if (match) {
                    target = match.name;
                }
                else {
                    this.logger.error(`[local-manager] No PM2 process found for: ${msg.target}`);
                    this.hubClient.sendResult(msg.action, msg.target, false);
                    return;
                }
            }
            this.logger.info(`[local-manager] ${msg.action} ${target}`);
            try {
                if (msg.action === "restart")
                    await restartProcess(target);
                else if (msg.action === "stop")
                    await stopProcess(target);
                else if (msg.action === "start")
                    await startProcess(target);
                else if (msg.action === "restart-all")
                    await stopAll();
                else if (msg.action === "stop-all")
                    await stopAll();
                this.hubClient.sendResult(msg.action, msg.target, true);
            }
            catch (err) {
                this.logger.error(`[local-manager] Failed: ${err.message}`);
                this.hubClient.sendResult(msg.action, msg.target, false);
            }
        };
        try {
            await this.hubClient.connect();
        }
        catch (err) {
            this.logger.warn(`[local-manager] Hub connect failed: ${err.message}. Will retry.`);
        }
        this.statusTimer = setInterval(async () => {
            try {
                const processes = await listProcesses();
                const logs = {};
                for (const proc of processes) {
                    logs[proc.name] = await getProcessLogs(proc.name);
                }
                if (this.hubClient?.connected) {
                    this.hubClient.sendStatus(processes, logs);
                }
            }
            catch (err) {
                this.logger.warn(`[local-manager] Status tick failed: ${err.message}`);
            }
        }, 30_000);
        this.logger.info("[local-manager] Started (reporting every 30s)");
    }
    async stop() {
        if (this.statusTimer) {
            clearInterval(this.statusTimer);
            this.statusTimer = null;
        }
        if (this.hubClient) {
            this.hubClient.disconnect();
            this.hubClient = null;
        }
        if (this.hasLock)
            releaseLock();
        this.logger.info("[local-manager] Stopped");
    }
}
