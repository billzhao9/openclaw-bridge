import { readFile, writeFile, copyFile, mkdir, access } from "node:fs/promises";
import { join, resolve, dirname, basename, extname } from "node:path";
/** If dest exists, append _1, _2, etc. before the extension */
async function deduplicatePath(destPath) {
    let candidate = destPath;
    let counter = 0;
    const ext = extname(destPath);
    const base = destPath.slice(0, destPath.length - ext.length);
    while (true) {
        try {
            await access(candidate);
            counter++;
            candidate = `${base}_${counter}${ext}`;
        }
        catch {
            return candidate; // File doesn't exist, use this path
        }
    }
}
export class BridgeFileOps {
    config;
    machineId;
    workspacePath;
    logger;
    constructor(config, machineId, workspacePath, logger) {
        this.config = config;
        this.machineId = machineId;
        this.workspacePath = workspacePath;
        this.logger = logger;
    }
    isSameMachine(target) {
        return target.machineId === this.machineId;
    }
    validatePathWithinWorkspace(filePath, workspace) {
        const resolved = resolve(workspace, filePath);
        if (!resolved.startsWith(resolve(workspace))) {
            throw new Error(`openclaw-bridge: path escapes workspace: ${filePath}`);
        }
        return resolved;
    }
    fileRelayHeaders() {
        const h = { "Content-Type": "application/json" };
        if (this.config.fileRelay?.apiKey)
            h["X-API-Key"] = this.config.fileRelay.apiKey;
        return h;
    }
    fileRelayUrl(path) {
        if (!this.config.fileRelay?.baseUrl) {
            throw new Error("openclaw-bridge: fileRelay.baseUrl not configured");
        }
        return `${this.config.fileRelay.baseUrl.replace(/\/+$/, "")}${path}`;
    }
    async sendFile(target, localRelativePath) {
        const sourcePath = this.validatePathWithinWorkspace(localRelativePath, this.workspacePath);
        if (this.isSameMachine(target)) {
            const destDir = join(target.workspacePath, "_inbox", this.config.agentId);
            await mkdir(destDir, { recursive: true });
            const originalFilename = localRelativePath.split(/[\\/]/).pop();
            const rawDestPath = join(destDir, originalFilename);
            const destPath = await deduplicatePath(rawDestPath);
            await copyFile(sourcePath, destPath);
            const actualFilename = basename(destPath);
            const renamed = actualFilename !== originalFilename;
            this.logger.info(`openclaw-bridge: sent ${localRelativePath} to ${target.agentId} (local)${renamed ? ` (renamed to ${actualFilename})` : ""}`);
            return {
                delivered: true,
                message: renamed
                    ? `File copied to ${target.agentId}/_inbox/ (renamed to ${actualFilename} because a file with the same name already existed)`
                    : `File copied to ${target.agentId}/_inbox/`,
                filename: actualFilename,
                renamed,
            };
        }
        const content = await readFile(sourcePath);
        const res = await fetch(this.fileRelayUrl("/api/v1/files/upload"), {
            method: "POST",
            headers: this.fileRelayHeaders(),
            body: JSON.stringify({
                fromAgent: this.config.agentId,
                toAgent: target.agentId,
                filename: localRelativePath.split(/[\\/]/).pop(),
                content: content.toString("base64"),
                metadata: {},
            }),
        });
        if (!res.ok) {
            throw new Error(`openclaw-bridge: FileRelay upload failed: ${res.status}`);
        }
        this.logger.info(`openclaw-bridge: sent ${localRelativePath} to ${target.agentId} (FileRelay)`);
        return { delivered: false, message: `File uploaded to FileRelay for ${target.agentId}` };
    }
    async readRemoteFile(target, relativePath) {
        if (this.isSameMachine(target)) {
            const fullPath = this.validatePathWithinWorkspace(relativePath, target.workspacePath);
            return await readFile(fullPath, "utf-8");
        }
        const enqueueRes = await fetch(this.fileRelayUrl("/api/v1/commands/enqueue"), {
            method: "POST",
            headers: this.fileRelayHeaders(),
            body: JSON.stringify({
                fromAgent: this.config.agentId,
                toAgent: target.agentId,
                type: "read_file",
                payload: { path: relativePath },
            }),
        });
        if (!enqueueRes.ok) {
            throw new Error(`openclaw-bridge: command enqueue failed: ${enqueueRes.status}`);
        }
        const { id: cmdId } = (await enqueueRes.json());
        const deadline = Date.now() + 90_000;
        while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 5_000));
            const resultRes = await fetch(this.fileRelayUrl(`/api/v1/commands/result/${cmdId}`), {
                headers: this.fileRelayHeaders(),
            });
            if (!resultRes.ok)
                continue;
            const result = (await resultRes.json());
            if (result.status === "ok" && result.payload?.content) {
                return Buffer.from(result.payload.content, "base64").toString("utf-8");
            }
            if (result.status === "error") {
                throw new Error(`openclaw-bridge: remote read failed`);
            }
        }
        throw new Error("openclaw-bridge: remote read timed out (90s)");
    }
    async writeRemoteFile(target, relativePath, content) {
        if (this.isSameMachine(target)) {
            const fullPath = this.validatePathWithinWorkspace(relativePath, target.workspacePath);
            await mkdir(dirname(fullPath), { recursive: true });
            await writeFile(fullPath, content, "utf-8");
            this.logger.info(`openclaw-bridge: wrote ${relativePath} to ${target.agentId} workspace`);
            return;
        }
        const res = await fetch(this.fileRelayUrl("/api/v1/files/upload"), {
            method: "POST",
            headers: this.fileRelayHeaders(),
            body: JSON.stringify({
                fromAgent: this.config.agentId,
                toAgent: target.agentId,
                filename: relativePath.split(/[\\/]/).pop(),
                content: Buffer.from(content).toString("base64"),
                metadata: { writeToPath: relativePath },
            }),
        });
        if (!res.ok) {
            throw new Error(`openclaw-bridge: FileRelay write-upload failed: ${res.status}`);
        }
    }
    async processPendingFiles() {
        if (!this.config.fileRelay?.baseUrl)
            return 0;
        try {
            const res = await fetch(this.fileRelayUrl(`/api/v1/files/pending?agent=${this.config.agentId}`), { headers: this.fileRelayHeaders() });
            if (!res.ok)
                return 0;
            const data = (await res.json());
            let count = 0;
            for (const file of data.files) {
                const dlRes = await fetch(this.fileRelayUrl(`/api/v1/files/download/${file.id}`), {
                    headers: this.fileRelayHeaders(),
                });
                if (!dlRes.ok)
                    continue;
                const dlData = (await dlRes.json());
                const fileContent = Buffer.from(dlData.content, "base64");
                let destPath;
                if (file.metadata?.writeToPath) {
                    destPath = this.validatePathWithinWorkspace(file.metadata.writeToPath, this.workspacePath);
                }
                else {
                    const inboxDir = join(this.workspacePath, "_inbox", file.fromAgent);
                    await mkdir(inboxDir, { recursive: true });
                    destPath = await deduplicatePath(join(inboxDir, file.filename));
                }
                await mkdir(dirname(destPath), { recursive: true });
                await writeFile(destPath, fileContent);
                await fetch(this.fileRelayUrl(`/api/v1/files/ack/${file.id}`), {
                    method: "POST",
                    headers: this.fileRelayHeaders(),
                });
                count++;
            }
            if (count > 0) {
                this.logger.info(`openclaw-bridge: processed ${count} pending file(s) from FileRelay`);
            }
            return count;
        }
        catch (err) {
            this.logger.warn(`openclaw-bridge: FileRelay file poll failed: ${String(err)}`);
            return 0;
        }
    }
    async processPendingCommands() {
        if (!this.config.fileRelay?.baseUrl)
            return 0;
        try {
            const res = await fetch(this.fileRelayUrl(`/api/v1/commands/pending?agent=${this.config.agentId}`), { headers: this.fileRelayHeaders() });
            if (!res.ok)
                return 0;
            const data = (await res.json());
            let count = 0;
            for (const cmd of data.commands) {
                try {
                    if (cmd.type === "read_file") {
                        const path = cmd.payload.path;
                        const fullPath = this.validatePathWithinWorkspace(path, this.workspacePath);
                        const content = await readFile(fullPath);
                        await fetch(this.fileRelayUrl(`/api/v1/commands/respond/${cmd.id}`), {
                            method: "POST",
                            headers: this.fileRelayHeaders(),
                            body: JSON.stringify({
                                status: "ok",
                                payload: { content: content.toString("base64") },
                            }),
                        });
                    }
                    else if (cmd.type === "restart") {
                        // Acknowledge the command first
                        await fetch(this.fileRelayUrl(`/api/v1/commands/respond/${cmd.id}`), {
                            method: "POST",
                            headers: this.fileRelayHeaders(),
                            body: JSON.stringify({ status: "ok", payload: {} }),
                        });
                        // Schedule self-restart after responding
                        setTimeout(() => {
                            this.logger.info("openclaw-bridge: executing remote restart command");
                            process.exit(0); // PM2 or run.ps1 will restart the process
                        }, 1_000);
                    }
                    count++;
                }
                catch (err) {
                    await fetch(this.fileRelayUrl(`/api/v1/commands/respond/${cmd.id}`), {
                        method: "POST",
                        headers: this.fileRelayHeaders(),
                        body: JSON.stringify({ status: "error", payload: { error: String(err) } }),
                    });
                }
            }
            if (count > 0) {
                this.logger.info(`openclaw-bridge: processed ${count} pending command(s) from FileRelay`);
            }
            return count;
        }
        catch (err) {
            this.logger.warn(`openclaw-bridge: FileRelay command poll failed: ${String(err)}`);
            return 0;
        }
    }
}
