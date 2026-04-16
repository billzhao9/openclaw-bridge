import { exec } from "node:child_process";
import { promisify } from "node:util";
import { platform, homedir } from "node:os";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const _exec = promisify(exec);
const execAsync = async (cmd: string, opts?: Record<string, unknown>) => {
  const result = await _exec(cmd, { windowsHide: true, encoding: "utf-8", ...opts } as any);
  return { stdout: result.stdout as unknown as string, stderr: result.stderr as unknown as string };
};
const IS_WIN = platform() === "win32";
const IS_MAC = platform() === "darwin";

export interface PM2Process {
  name: string;
  agentId: string;
  pid: number;
  status: string;
  memory: number;
  cpu: number;
  restarts: number;
  uptime: number;
}

async function killPort(port: number): Promise<void> {
  if (!port) return;
  try {
    if (IS_WIN) {
      const { stdout } = await execAsync(
        `netstat -ano | findstr :${port} | findstr LISTENING`,
      );
      const pids = new Set<string>();
      stdout.split("\n").forEach((line: string) => {
        const pid = line.trim().split(/\s+/).pop();
        if (pid && /^\d+$/.test(pid) && pid !== "0") pids.add(pid);
      });
      for (const pid of pids) {
        await execAsync(`taskkill /F /PID ${pid}`).catch(() => {});
      }
    } else {
      await execAsync(`lsof -ti:${port} | xargs kill -9`).catch(() => {});
    }
  } catch {
    // No process on port
  }
}

async function getProcessPort(name: string): Promise<number | null> {
  try {
    const { stdout } = await execAsync("pm2 jlist");
    const apps = JSON.parse(stdout);
    const app = apps.find((a: any) => a.name === name);
    if (app?.pm2_env?.env?.OPENCLAW_GATEWAY_PORT) {
      return parseInt(app.pm2_env.env.OPENCLAW_GATEWAY_PORT, 10);
    }
    if (app?.pm2_env?.pm_exec_path) {
      const { readFileSync } = await import("node:fs");
      const dir = app.pm2_env.pm_exec_path.replace(/[/\\]run\.sh$/, "");
      const script = readFileSync(dir + "/run.sh", "utf-8");
      const match = script.match(/OPENCLAW_GATEWAY_PORT="?(\d+)/);
      if (match) return parseInt(match[1], 10);
    }
  } catch {}
  return null;
}

export async function listProcesses(): Promise<PM2Process[]> {
  // Try PM2 first
  try {
    const { stdout } = await execAsync("pm2 jlist");
    const apps = JSON.parse(stdout);
    const procs = apps.map((p: any) => ({
      name: p.name,
      agentId: p.name.replace(/^gw-/, ""),
      pid: p.pid,
      status: p.pm2_env?.status || "unknown",
      memory: p.monit?.memory || 0,
      cpu: p.monit?.cpu || 0,
      restarts: p.pm2_env?.restart_time || 0,
      uptime: p.pm2_env?.pm_uptime ? Date.now() - p.pm2_env.pm_uptime : 0,
    }));
    if (procs.length > 0) return procs;
  } catch {
    // PM2 not available or no processes
  }

  // macOS launchd fallback — detect openclaw gateway running via launchd
  if (IS_MAC) {
    try {
      const { stdout } = await execAsync("launchctl list | grep openclaw");
      const lines = stdout.trim().split("\n").filter(Boolean);
      const procs: PM2Process[] = [];
      for (const line of lines) {
        const parts = line.split("\t");
        const pid = parseInt(parts[0], 10);
        const label = parts[2] || "";
        if (!label.includes("openclaw")) continue;
        // Read agentId from openclaw.json
        let agentId = "main-mac";
        try {
          const configPath = join(homedir(), ".openclaw", "openclaw.json");
          const config = JSON.parse(readFileSync(configPath, "utf-8"));
          agentId = config.plugins?.entries?.["openclaw-bridge"]?.config?.agentId || agentId;
        } catch { /* use default */ }
        procs.push({
          name: `gw-${agentId}`,
          agentId,
          pid: isNaN(pid) ? 0 : pid,
          status: pid > 0 ? "online" : "stopped",
          memory: 0,
          cpu: 0,
          restarts: 0,
          uptime: 0,
        });
      }
      return procs;
    } catch {
      // launchctl failed
    }
  }

  return [];
}

export async function getProcessLogs(name: string): Promise<string> {
  // Try PM2 logs first — but only if process is actually managed by PM2
  try {
    const { stdout: jlist } = await execAsync("pm2 jlist");
    const apps = JSON.parse(jlist);
    const hasPM2Process = apps.some((a: any) => a.name === name);
    if (hasPM2Process) {
      const { stdout } = await execAsync(
        `pm2 logs ${name} --nostream --lines 100`,
        { timeout: 10_000 },
      );
      // Filter out PM2 header lines that contain no actual log content
      const lines = stdout.split("\n").filter((l: string) => !l.startsWith("[TAILING]") && l.trim());
      if (lines.length > 0) return lines.join("\n");
    }
  } catch {
    // PM2 not available
  }

  // macOS launchd fallback — read from /private/tmp/openclaw/ log files
  if (IS_MAC) {
    try {
      const logDir = "/private/tmp/openclaw";
      if (!existsSync(logDir)) return "(logs unavailable — no log directory)";

      // Find today's log file (format: openclaw-YYYY-MM-DD.log)
      const today = new Date().toISOString().slice(0, 10);
      const logFile = join(logDir, `openclaw-${today}.log`);

      if (existsSync(logFile)) {
        const { stdout } = await execAsync(`tail -100 "${logFile}"`, { timeout: 5_000 });
        return stdout;
      }

      // Fallback: find the most recent log file
      const files = readdirSync(logDir)
        .filter(f => f.startsWith("openclaw-") && f.endsWith(".log"))
        .sort()
        .reverse();
      if (files.length > 0) {
        const { stdout } = await execAsync(`tail -100 "${join(logDir, files[0])}"`, { timeout: 5_000 });
        return stdout;
      }
    } catch {
      // log read failed
    }
  }

  return "(logs unavailable)";
}

export async function restartProcess(name: string): Promise<void> {
  await execAsync("pm2 stop " + name).catch(() => {});
  const port = await getProcessPort(name);
  if (port) await killPort(port);
  await new Promise((r) => setTimeout(r, 1000));
  await execAsync("pm2 restart " + name);
}

export async function stopProcess(name: string): Promise<void> {
  await execAsync("pm2 stop " + name);
  const port = await getProcessPort(name);
  if (port) await killPort(port);
}

export async function startProcess(name: string): Promise<void> {
  const port = await getProcessPort(name);
  if (port) await killPort(port);
  await execAsync("pm2 restart " + name);
}

export async function stopAll(): Promise<void> {
  const procs = await listProcesses();
  await execAsync("pm2 stop all");
  for (const proc of procs) {
    const port = await getProcessPort(proc.name);
    if (port) await killPort(port);
  }
}

export async function startAll(ecosystemPath: string): Promise<void> {
  await execAsync("pm2 start " + ecosystemPath);
}
