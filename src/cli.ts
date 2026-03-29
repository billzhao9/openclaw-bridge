#!/usr/bin/env node
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join, resolve, dirname, basename } from "node:path";
import { execSync, exec } from "node:child_process";
import { homedir, platform } from "node:os";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

// ── Config ──────────────────────────────────────────────────────────────────

const CONFIG_DIR = join(homedir(), ".openclaw-bridge");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
const IS_WINDOWS = platform() === "win32";

interface BridgeConfig {
  hubUrl: string;
  apiKey: string;
  managerPass: string;
}

function loadConfig(): BridgeConfig | null {
  if (!existsSync(CONFIG_FILE)) return null;
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf-8")) as BridgeConfig;
  } catch {
    return null;
  }
}

function saveConfig(config: BridgeConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8");
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function run(cmd: string, opts: { silent?: boolean } = {}): string {
  try {
    return execSync(cmd, {
      encoding: "utf-8",
      stdio: opts.silent ? ["pipe", "pipe", "pipe"] : ["inherit", "pipe", "inherit"],
    }).trim();
  } catch (err: any) {
    if (opts.silent) return "";
    throw err;
  }
}

function runInherit(cmd: string): void {
  execSync(cmd, { stdio: "inherit" });
}

async function fetchJson(url: string, apiKey?: string): Promise<any> {
  const headers: Record<string, string> = {};
  if (apiKey) headers["x-api-key"] = apiKey;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Resolve ~ to homedir for any path string */
function expandHome(p: string): string {
  if (p.startsWith("~/") || p === "~") return join(homedir(), p.slice(2));
  return p;
}

/** Find the ecosystem.config.cjs in common locations */
function findEcosystem(): string | null {
  const candidates = [
    join(process.cwd(), "ecosystem.config.cjs"),
    join(dirname(process.cwd()), "ecosystem.config.cjs"),
    IS_WINDOWS ? "C:\\openclaw-instances\\ecosystem.config.cjs" : "",
    join(homedir(), "openclaw-instances", "ecosystem.config.cjs"),
    join(homedir(), ".openclaw", "ecosystem.config.cjs"),
  ].filter(Boolean);

  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

/** Get the openclaw-instances directory from the ecosystem path */
function instancesDirFromEcosystem(ecosystemPath: string): string {
  return dirname(ecosystemPath);
}

// ── PM2 helpers ──────────────────────────────────────────────────────────────

interface Pm2Process {
  name: string;
  pid: number | string;
  status: string;
  memory: number;
  restarts: number;
  uptime: number;
}

function getPm2Processes(): Pm2Process[] {
  try {
    const out = run("pm2 jlist", { silent: true });
    if (!out) return [];
    const list = JSON.parse(out) as any[];
    return list.map((p) => ({
      name: p.name,
      pid: p.pid ?? "-",
      status: p.pm2_env?.status ?? "unknown",
      memory: p.monit?.memory ?? 0,
      restarts: p.pm2_env?.restart_time ?? 0,
      uptime: p.pm2_env?.pm_uptime ?? 0,
    }));
  } catch {
    return [];
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function formatUptime(ms: number): string {
  if (!ms || ms <= 0) return "-";
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function printTable(processes: Pm2Process[]): void {
  if (processes.length === 0) {
    console.log("  (no processes found)");
    return;
  }

  const cols = {
    name: Math.max(4, ...processes.map((p) => p.name.length)),
    status: 8,
    pid: 7,
    memory: 8,
    restarts: 8,
    uptime: 8,
  };

  const header = [
    "Name".padEnd(cols.name),
    "Status".padEnd(cols.status),
    "PID".padEnd(cols.pid),
    "Memory".padEnd(cols.memory),
    "Restarts".padEnd(cols.restarts),
    "Uptime".padEnd(cols.uptime),
  ].join("  ");

  const sep = "-".repeat(header.length);
  console.log(`\n  ${header}`);
  console.log(`  ${sep}`);

  for (const p of processes) {
    const statusIcon = p.status === "online" ? "online  " : p.status.padEnd(cols.status);
    const row = [
      p.name.padEnd(cols.name),
      statusIcon,
      String(p.pid).padEnd(cols.pid),
      formatBytes(p.memory).padEnd(cols.memory),
      String(p.restarts).padEnd(cols.restarts),
      formatUptime(p.uptime).padEnd(cols.uptime),
    ].join("  ");
    console.log(`  ${row}`);
  }
  console.log();
}

// ── Commands ─────────────────────────────────────────────────────────────────

async function cmdSetup(): Promise<void> {
  console.log("\nOpenClaw Bridge — Interactive Setup");
  console.log("=====================================\n");

  const rl = createInterface({ input, output });

  const existing = loadConfig();

  const hubUrl = (await rl.question(
    `Hub URL [${existing?.hubUrl ?? "http://localhost:3080"}]: `
  )).trim() || existing?.hubUrl || "http://localhost:3080";

  const apiKey = (await rl.question(
    `API Key [${existing?.apiKey ? "***" + existing.apiKey.slice(-4) : "none"}]: `
  )).trim() || existing?.apiKey || "";

  const managerPass = (await rl.question(
    `Manager Password [${existing?.managerPass ? "***" : "none"}]: `
  )).trim() || existing?.managerPass || "";

  rl.close();

  const config: BridgeConfig = { hubUrl, apiKey, managerPass };
  saveConfig(config);
  console.log(`\nConfig saved to ${CONFIG_FILE}`);

  // Test connection
  console.log(`\nTesting connection to ${hubUrl} ...`);
  try {
    await fetchJson(`${hubUrl}/api/v1/registry/discover`, apiKey);
    console.log("  Connected to Hub successfully.");
  } catch (err: any) {
    console.log(`  Could not reach Hub: ${err.message}`);
    console.log("  (Config saved anyway — check your Hub URL and API key)");
  }
  console.log();
}

async function cmdStatus(): Promise<void> {
  console.log("\nOpenClaw Bridge — Status");
  console.log("=========================\n");

  // PM2 processes
  console.log("PM2 Processes:");
  const processes = getPm2Processes();
  printTable(processes);

  // Hub connection
  const config = loadConfig();
  if (!config) {
    console.log("Hub: not configured (run: openclaw-bridge setup)");
  } else {
    process.stdout.write(`Hub (${config.hubUrl}): `);
    try {
      await fetchJson(`${config.hubUrl}/api/v1/registry/discover`, config.apiKey);
      console.log("connected");
    } catch (err: any) {
      console.log(`unreachable — ${err.message}`);
    }
  }
  console.log();
}

async function cmdStart(): Promise<void> {
  const ecosystem = findEcosystem();
  if (!ecosystem) {
    console.error(
      "Could not find ecosystem.config.cjs.\n" +
      "Searched: current dir, parent dir, C:\\openclaw-instances, ~/openclaw-instances, ~/.openclaw\n" +
      "Run from your openclaw-instances directory."
    );
    process.exit(1);
  }

  console.log(`\nStarting instances from: ${ecosystem}`);
  const before = getPm2Processes().length;
  runInherit(`pm2 start "${ecosystem}"`);
  const after = getPm2Processes().length;
  const started = Math.max(0, after - before);
  console.log(`\nStarted ${started > 0 ? started : "all configured"} process(es). Run 'openclaw-bridge status' to verify.\n`);
}

async function cmdStop(): Promise<void> {
  console.log("\nStopping all PM2 processes...");
  runInherit("pm2 stop all");
  console.log();
}

async function cmdRestart(agent?: string): Promise<void> {
  if (!agent) {
    console.log("\nRestarting all PM2 processes...");
    runInherit("pm2 restart all");
  } else {
    const withPrefix = `gw-${agent}`;
    // Try gw- prefix first
    const processes = getPm2Processes();
    const hasPrefixed = processes.some((p) => p.name === withPrefix);
    const target = hasPrefixed ? withPrefix : agent;
    console.log(`\nRestarting ${target}...`);
    try {
      runInherit(`pm2 restart "${target}"`);
    } catch {
      // Fallback: try raw name if prefix attempt failed
      if (target === withPrefix) {
        console.log(`  (gw- prefix not found, trying raw name: ${agent})`);
        runInherit(`pm2 restart "${agent}"`);
      } else {
        throw new Error(`Process "${agent}" not found in PM2`);
      }
    }
  }
  console.log();
}

async function cmdLogs(agent?: string): Promise<void> {
  if (!agent) {
    runInherit("pm2 logs --nostream --lines 50");
  } else {
    const withPrefix = `gw-${agent}`;
    const processes = getPm2Processes();
    const hasPrefixed = processes.some((p) => p.name === withPrefix);
    const target = hasPrefixed ? withPrefix : agent;
    try {
      runInherit(`pm2 logs "${target}" --nostream --lines 100`);
    } catch {
      if (target === withPrefix) {
        console.log(`  (gw- prefix not found, trying raw name: ${agent})`);
        runInherit(`pm2 logs "${agent}" --nostream --lines 100`);
      }
    }
  }
}

async function cmdBackup(): Promise<void> {
  console.log("\nOpenClaw Bridge — Backup");
  console.log("=========================\n");

  const ecosystem = findEcosystem();
  if (!ecosystem) {
    console.error("Could not find openclaw-instances directory.");
    process.exit(1);
  }

  const instancesDir = instancesDirFromEcosystem(ecosystem);
  const timestamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const backupName = `openclaw-backup-${timestamp}`;
  const backupPath = join(process.cwd(), `${backupName}.tar.gz`);

  const rl = createInterface({ input, output });
  const password = (await rl.question("Encryption password for sensitive files: ")).trim();
  rl.close();

  if (!password) {
    console.log("Password required for backup encryption.");
    process.exit(1);
  }

  console.log(`\nCreating backup of: ${instancesDir}`);
  console.log(`Output: ${backupPath}`);

  // Exclusions: node_modules/, */state/, */workspace/, *.log, .claude/
  const excludes = [
    "--exclude=*/node_modules",
    "--exclude=node_modules",
    "--exclude=*/state",
    "--exclude=*/workspace",
    "--exclude=*.log",
    "--exclude=.claude",
    "--exclude=*/.claude",
  ].join(" ");

  if (IS_WINDOWS) {
    // On Windows, use tar (available in Windows 10+)
    runInherit(
      `tar -czf "${backupPath}" ${excludes} -C "${dirname(instancesDir)}" "${basename(instancesDir)}"`
    );
  } else {
    runInherit(
      `tar -czf "${backupPath}" ${excludes} -C "${dirname(instancesDir)}" "${basename(instancesDir)}"`
    );
  }

  // Encrypt sensitive files (openclaw.json, config.json) inside the archive
  // We do this by listing them and producing encrypted sidecar files
  console.log("\nEncrypting sensitive config files...");
  const sensitiveFiles = findFilesRecursive(instancesDir, (f) =>
    (f === "openclaw.json" || f === "config.json") &&
    !f.includes("node_modules") && !f.includes("state") && !f.includes("workspace")
  );

  let encryptedCount = 0;
  for (const filePath of sensitiveFiles) {
    const encPath = `${filePath}.enc`;
    try {
      runInherit(
        `openssl enc -aes-256-cbc -pbkdf2 -in "${filePath}" -out "${encPath}" -pass pass:"${password}"`
      );
      encryptedCount++;
    } catch {
      console.log(`  Warning: could not encrypt ${filePath}`);
    }
  }

  if (encryptedCount > 0) {
    console.log(`  Encrypted ${encryptedCount} config file(s) alongside backup.`);
  }

  // Report size
  try {
    const stats = statSync(backupPath);
    console.log(`\nBackup complete!`);
    console.log(`  Location: ${backupPath}`);
    console.log(`  Size:     ${formatBytes(stats.size)}`);
  } catch {
    console.log(`\nBackup file: ${backupPath}`);
  }
  console.log();
}

function findFilesRecursive(dir: string, predicate: (filename: string) => boolean): string[] {
  const results: string[] = [];
  if (!existsSync(dir)) return results;
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules" && entry.name !== "state" && entry.name !== "workspace" && entry.name !== ".claude") {
        results.push(...findFilesRecursive(fullPath, predicate));
      }
    } else if (predicate(entry.name)) {
      results.push(fullPath);
    }
  }
  return results;
}

async function cmdCleanSessions(): Promise<void> {
  console.log("\nOpenClaw Bridge — Clean Sessions");
  console.log("=================================\n");

  const ecosystem = findEcosystem();
  if (!ecosystem) {
    console.error("Could not find openclaw-instances directory.");
    process.exit(1);
  }

  const instancesDir = instancesDirFromEcosystem(ecosystem);
  let totalFiles = 0;
  let totalBytes = 0;

  // Find all */agent/sessions/ directories
  if (!existsSync(instancesDir)) {
    console.log("Instances directory not found.");
    return;
  }

  const agentDirs = readdirSync(instancesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  for (const agentDir of agentDirs) {
    const sessionsDir = join(instancesDir, agentDir, "agent", "sessions");
    if (!existsSync(sessionsDir)) continue;

    const files = readdirSync(sessionsDir).filter((f) =>
      /\.(deleted|reset)\.|old-session/.test(f)
    );

    for (const file of files) {
      const filePath = join(sessionsDir, file);
      try {
        const stats = statSync(filePath);
        totalBytes += stats.size;
        unlinkSync(filePath);
        totalFiles++;
        console.log(`  Deleted: ${agentDir}/agent/sessions/${file}`);
      } catch {
        console.log(`  Warning: could not delete ${file}`);
      }
    }
  }

  console.log(`\nCleaned ${totalFiles} file(s), freed ${formatBytes(totalBytes)}.\n`);
}

async function cmdAddAgent(): Promise<void> {
  console.log("\nOpenClaw Bridge — Add Agent Wizard");
  console.log("====================================\n");

  const ecosystem = findEcosystem();
  if (!ecosystem) {
    console.error("Could not find ecosystem.config.cjs.");
    process.exit(1);
  }

  const instancesDir = instancesDirFromEcosystem(ecosystem);
  const bridgeConfig = loadConfig();

  const rl = createInterface({ input, output });

  const agentName = (await rl.question("Agent name (e.g. Designer): ")).trim();
  if (!agentName) {
    rl.close();
    console.error("Agent name is required.");
    process.exit(1);
  }

  const suggestedId = agentName.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
  const agentIdInput = (await rl.question(`Agent ID [${suggestedId}]: `)).trim();
  const agentId = agentIdInput || suggestedId;

  const description = (await rl.question(`Description [${agentName} agent]: `)).trim() || `${agentName} agent`;

  const modelChoices = [
    "claude-sonnet-4-5-20250514",
    "claude-opus-4-5-20250514",
    "gpt-4o",
    "gpt-4o-mini",
    "gemini-2.5-flash",
    "gemini-2.5-pro",
  ];
  console.log("\nAvailable models:");
  modelChoices.forEach((m, i) => console.log(`  ${i + 1}. ${m}`));
  const modelInput = (await rl.question(`\nModel [1 = ${modelChoices[0]}]: `)).trim();
  let model = modelChoices[0];
  const modelNum = parseInt(modelInput, 10);
  if (!isNaN(modelNum) && modelNum >= 1 && modelNum <= modelChoices.length) {
    model = modelChoices[modelNum - 1];
  } else if (modelInput && !isNaN(parseInt(modelInput, 10)) === false) {
    model = modelInput; // custom model string
  }

  rl.close();

  // Auto-assign port by reading ecosystem.config.cjs
  let nextPort = 18790;
  try {
    const ecosystemContent = readFileSync(ecosystem, "utf-8");
    const portMatches = [...ecosystemContent.matchAll(/PORT['":\s]*[=:]?\s*['"]?(\d{4,5})/g)];
    if (portMatches.length > 0) {
      const ports = portMatches.map((m) => parseInt(m[1], 10)).filter((p) => p >= 18780 && p <= 19999);
      if (ports.length > 0) {
        nextPort = Math.max(...ports) + 1;
      }
    }
  } catch {
    // Keep default
  }

  const agentDir = join(instancesDir, agentId);
  if (existsSync(agentDir)) {
    console.error(`\nDirectory already exists: ${agentDir}`);
    process.exit(1);
  }

  // Determine load paths (platform-specific)
  const extensionsDir = IS_WINDOWS
    ? "C:\\\\openclaw-extensions"
    : join(homedir(), "openclaw-extensions");

  const hubUrl = bridgeConfig?.hubUrl ?? "http://localhost:3080";
  const apiKey = bridgeConfig?.apiKey ?? "";
  const managerPass = bridgeConfig?.managerPass ?? "";

  // Create openclaw.json
  const openclawJson = {
    meta: { lastTouchedVersion: "2026.3.24" },
    models: {
      default: model,
      mode: "merge",
    },
    plugins: {
      allow: ["openclaw-bridge"],
      load: { paths: [IS_WINDOWS ? "C:\\openclaw-extensions" : join(homedir(), "openclaw-extensions")] },
      entries: {
        "openclaw-bridge": {
          enabled: true,
          config: {
            role: "normal",
            agentId,
            agentName,
            description,
            registry: {
              baseUrl: hubUrl,
              apiKey,
            },
            fileRelay: {
              baseUrl: hubUrl,
              apiKey,
            },
            localManager: {
              enabled: true,
              hubUrl,
              managerPass,
            },
          },
        },
      },
    },
    gateway: {
      http: {
        endpoints: {
          chatCompletions: { enabled: true },
        },
      },
    },
  };

  // Create run.sh
  const runSh = `#!/usr/bin/env bash
cd "$(dirname "$0")"
export OPENCLAW_HOME="$(pwd)/home"
export OPENCLAW_STATE_DIR="$(pwd)/state"
export OPENCLAW_CONFIG_PATH="$(pwd)/openclaw.json"
export NODE_OPTIONS="--max-old-space-size=256"
export OPENCLAW_PROFILE="${agentId}"
export OPENCLAW_GATEWAY_PORT="${nextPort}"

# Kill any orphan process on our port before starting
if [[ "$OSTYPE" == "darwin"* ]] || [[ "$OSTYPE" == "linux"* ]]; then
  lsof -ti:$OPENCLAW_GATEWAY_PORT | xargs kill -9 2>/dev/null && sleep 1
elif command -v netstat &>/dev/null; then
  orphan=$(netstat -ano 2>/dev/null | grep ":$OPENCLAW_GATEWAY_PORT.*LISTEN" | awk '{print $5}' | head -1)
  [ -n "$orphan" ] && taskkill //F //PID $orphan 2>/dev/null && sleep 1
fi

exec openclaw gateway --port ${nextPort}
`;

  // Create run.ps1
  const runPs1 = `# Run script for ${agentName}
$PORT = ${nextPort}
$AgentDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# Kill any process using our port (orphan cleanup)
try {
  $connections = netstat -ano | Select-String ":$PORT "
  foreach ($conn in $connections) {
    $pid = ($conn -split '\\s+')[-1]
    if ($pid -match '^\\d+$') {
      Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue
    }
  }
} catch {}

$env:OPENCLAW_GATEWAY_PORT = $PORT
$env:OPENCLAW_CONFIG_PATH = "$AgentDir\\openclaw.json"

openclaw start
`;

  // Write files
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "openclaw.json"), JSON.stringify(openclawJson, null, 2), "utf-8");
  writeFileSync(join(agentDir, "run.sh"), runSh, { encoding: "utf-8", mode: 0o755 });
  writeFileSync(join(agentDir, "run.ps1"), runPs1, "utf-8");

  // Update ecosystem.config.cjs — add to instances array
  let ecosystemContent = readFileSync(ecosystem, "utf-8");
  const newEntry = `  { name: 'gw-${agentId}', dir: '${agentId}', port: '${nextPort}', profile: '${agentId}' },`;
  // Insert before the closing ]; of the instances array
  const instancesArrayEnd = /(\n\];)/;
  if (instancesArrayEnd.test(ecosystemContent)) {
    ecosystemContent = ecosystemContent.replace(
      instancesArrayEnd,
      `\n${newEntry}$1`
    );
  } else {
    console.log(`\n  ⚠️  Could not auto-update ecosystem.config.cjs. Add manually:`);
    console.log(`  ${newEntry}`);
  }
  writeFileSync(ecosystem, ecosystemContent, "utf-8");

  console.log(`\nAgent "${agentName}" (${agentId}) created successfully!`);
  console.log(`\n  Directory:   ${agentDir}`);
  console.log(`  Port:        ${nextPort}`);
  console.log(`  Model:       ${model}`);
  console.log(`  Config:      ${join(agentDir, "openclaw.json")}`);
  console.log(`  Ecosystem:   updated ${ecosystem}`);
  console.log(`\nNext steps:`);
  console.log(`  1. Review ${join(agentDir, "openclaw.json")}`);
  console.log(`  2. Run: openclaw-bridge start`);
  console.log(`  3. Run: openclaw-bridge status\n`);
}

async function cmdDoctor(): Promise<void> {
  console.log("\nOpenClaw Bridge — Doctor");
  console.log("=========================\n");

  const checks: Array<{ label: string; ok: boolean; detail?: string }> = [];

  // PM2 installed
  {
    let ok = false;
    let detail = "";
    try {
      detail = run("pm2 --version", { silent: true });
      ok = !!detail;
    } catch {
      detail = "not found";
    }
    checks.push({ label: "PM2 installed", ok, detail: ok ? `v${detail.trim()}` : detail });
  }

  // openclaw CLI installed
  {
    let ok = false;
    let detail = "";
    try {
      detail = run("openclaw --version", { silent: true });
      ok = !!detail;
    } catch {
      detail = "not found";
    }
    checks.push({ label: "openclaw CLI installed", ok, detail: ok ? detail.trim() : detail });
  }

  // Node version
  {
    const nodeVer = process.version;
    const major = parseInt(nodeVer.slice(1), 10);
    const ok = major >= 18;
    checks.push({ label: "Node.js version", ok, detail: `${nodeVer}${ok ? "" : " (need >=18)"}` });
  }

  // ecosystem.config.cjs
  {
    const ecosystem = findEcosystem();
    const ok = !!ecosystem;
    checks.push({ label: "ecosystem.config.cjs found", ok, detail: ok ? ecosystem! : "not found" });
  }

  // Hub reachable
  const config = loadConfig();
  if (!config) {
    checks.push({ label: "Hub reachable", ok: false, detail: "not configured (run: openclaw-bridge setup)" });
  } else {
    let ok = false;
    let detail = "";
    try {
      await fetchJson(`${config.hubUrl}/api/v1/registry/discover`, config.apiKey);
      ok = true;
      detail = config.hubUrl;
    } catch (err: any) {
      detail = `${config.hubUrl} — ${err.message}`;
    }
    checks.push({ label: "Hub reachable", ok, detail });
  }

  // Port conflicts (scan 18790-18799)
  {
    const portRange = Array.from({ length: 10 }, (_, i) => 18790 + i);
    const conflictPorts: number[] = [];
    for (const port of portRange) {
      try {
        const out = run(
          IS_WINDOWS
            ? `netstat -ano | findstr ":${port} "`
            : `ss -tlnp 2>/dev/null | grep :${port} || lsof -ti tcp:${port} 2>/dev/null || true`,
          { silent: true }
        );
        if (out.trim()) conflictPorts.push(port);
      } catch {
        // no conflict
      }
    }
    const ok = conflictPorts.length === 0;
    checks.push({
      label: "Port conflicts (18790-18799)",
      ok,
      detail: ok ? "none" : `conflicts on: ${conflictPorts.join(", ")}`,
    });
  }

  // Print results
  for (const check of checks) {
    const icon = check.ok ? "✅" : "❌";
    const detail = check.detail ? `  (${check.detail})` : "";
    console.log(`  ${icon}  ${check.label}${detail}`);
  }

  const failCount = checks.filter((c) => !c.ok).length;
  console.log(`\n${failCount === 0 ? "All checks passed." : `${failCount} issue(s) found.`}\n`);
}

async function cmdUpgrade(): Promise<void> {
  console.log("\nOpenClaw Bridge — Upgrade");
  console.log("==========================\n");

  let updatedPlugin = false;
  let updatedCli = false;

  // 1. Try installing/upgrading as OpenClaw plugin
  console.log("Checking OpenClaw plugin installation...");
  try {
    // Use execSync directly to capture both stdout and error output
    let installOutput = "";
    let installFailed = false;
    try {
      installOutput = execSync("openclaw plugins install openclaw-bridge 2>&1", {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
    } catch (execErr: any) {
      installOutput = String(execErr?.stdout || "") + String(execErr?.stderr || "") + String(execErr?.message || "");
      installFailed = true;
    }

    if (!installFailed && installOutput) {
      updatedPlugin = true;
      console.log("  Plugin installed/updated.");
    } else if (installOutput.includes("already exists")) {
      // Parse the existing path from error: "plugin already exists: /path/to/openclaw-bridge (delete it first)"
      const pathMatch = installOutput.match(/already exists:\s*(.+?)\s*\(/);
      const existingPath = pathMatch?.[1]?.trim();

      if (existingPath && existsSync(existingPath)) {
        console.log(`  Old plugin found at ${existingPath}. Removing...`);
        run(IS_WINDOWS ? `rmdir /s /q "${existingPath}"` : `rm -rf "${existingPath}"`, { silent: true });
      } else {
        // Fallback: search common plugin directories
        const candidates = [
          join(homedir(), ".openclaw", "extensions", "openclaw-bridge"),
          join(homedir(), "openclaw-extensions", "openclaw-bridge"),
          IS_WINDOWS ? "C:\\openclaw-extensions\\openclaw-bridge" : "",
        ].filter(Boolean);
        for (const dir of candidates) {
          if (existsSync(dir)) {
            console.log(`  Old plugin found at ${dir}. Removing...`);
            run(IS_WINDOWS ? `rmdir /s /q "${dir}"` : `rm -rf "${dir}"`, { silent: true });
            break;
          }
        }
      }

      // Retry install after removing old version
      console.log("  Installing new version...");
      try {
        runInherit("openclaw plugins install openclaw-bridge");
        updatedPlugin = true;
        console.log("  Plugin updated.");
      } catch {
        console.log("  Plugin install failed. Try manually:");
        console.log("    openclaw plugins install openclaw-bridge");
      }
    } else {
      // Install failed for unknown reason — show the output for debugging
      console.log(`  Plugin install failed: ${installOutput.slice(0, 200)}`);
    }
  } catch {
    console.log("  openclaw CLI not found. Skipping plugin check.");
  }

  // 2. Check if installed as global npm package
  console.log("\nChecking global npm installation...");
  try {
    const globalPath = run("npm list -g openclaw-bridge --depth=0", { silent: true });
    if (globalPath.includes("openclaw-bridge")) {
      console.log("  Found global openclaw-bridge. Updating...");
      runInherit("npm install -g openclaw-bridge");
      updatedCli = true;
      console.log("  CLI updated.");
    } else {
      console.log("  Not installed as global npm package.");
    }
  } catch {
    console.log("  Not installed as global npm package.");
  }

  // 3. If neither found, suggest installation
  if (!updatedPlugin && !updatedCli) {
    console.log("\nopenclaw-bridge is not installed. Choose an installation method:");
    console.log("  1. As OpenClaw plugin:  openclaw plugins install openclaw-bridge");
    console.log("  2. As CLI tool:         npm install -g openclaw-bridge");
    console.log("  3. Both (recommended for full functionality)");
  } else {
    // Print new version
    try {
      const ver = run("npm view openclaw-bridge version", { silent: true });
      console.log(`\nUpgraded to openclaw-bridge v${ver.trim()}`);
    } catch {
      console.log("\nUpgrade complete.");
    }
  }

  // 4. Config health check — scan openclaw.json and fix missing settings
  console.log("\nChecking bridge configuration...");
  const configFixCount = checkAndFixBridgeConfig();
  if (configFixCount === 0) {
    console.log("  Config OK — all required settings present.");
  } else {
    console.log(`  Fixed ${configFixCount} config issue(s). Restart your gateway to apply.`);
  }

  console.log();
}

/** Scan openclaw.json for missing bridge config fields and auto-fix them */
function checkAndFixBridgeConfig(): number {
  // Find openclaw.json — check env var, then common locations
  const candidates = [
    process.env.OPENCLAW_CONFIG_PATH,
    join(process.cwd(), "openclaw.json"),
    join(homedir(), ".openclaw", "openclaw.json"),
    IS_WINDOWS ? "C:\\openclaw-instances\\main\\openclaw.json" : "",
  ].filter(Boolean) as string[];

  let fixes = 0;

  for (const configPath of candidates) {
    if (!existsSync(configPath)) continue;

    try {
      const raw = readFileSync(configPath, "utf-8");
      const config = JSON.parse(raw);
      const bridgeConfig = config.plugins?.entries?.["openclaw-bridge"]?.config;
      if (!bridgeConfig) continue;

      let changed = false;

      // Fix 1: Auto-add messageRelay from fileRelay
      if (!bridgeConfig.messageRelay && bridgeConfig.fileRelay?.baseUrl) {
        const baseUrl = bridgeConfig.fileRelay.baseUrl as string;
        const wsUrl = baseUrl.replace(/^http/, "ws") + "/ws";
        bridgeConfig.messageRelay = {
          url: wsUrl,
          apiKey: bridgeConfig.fileRelay.apiKey || "",
        };
        console.log(`  [${configPath}] Added messageRelay.url = ${wsUrl}`);
        changed = true;
        fixes++;
      }

      // Fix 2: Ensure chatCompletions is enabled (needed for message relay)
      if (!config.gateway?.http?.endpoints?.chatCompletions?.enabled) {
        config.gateway = config.gateway || {};
        config.gateway.http = config.gateway.http || {};
        config.gateway.http.endpoints = config.gateway.http.endpoints || {};
        config.gateway.http.endpoints.chatCompletions = { enabled: true };
        console.log(`  [${configPath}] Enabled gateway.http.endpoints.chatCompletions`);
        changed = true;
        fixes++;
      }

      // Fix 3: Ensure gateway.auth is configured (needed for callGatewayAPI)
      if (!config.gateway?.auth?.token) {
        config.gateway = config.gateway || {};
        config.gateway.auth = config.gateway.auth || {};
        if (!config.gateway.auth.mode) config.gateway.auth.mode = "token";
        if (!config.gateway.auth.token) {
          const token = `bridge-${bridgeConfig.agentId || "agent"}-${Date.now().toString(36)}`;
          config.gateway.auth.token = token;
          console.log(`  [${configPath}] Added gateway.auth.token`);
          changed = true;
          fixes++;
        }
      }

      // Fix 4: Check required fields
      const required = ["role", "agentId", "agentName"];
      for (const field of required) {
        if (!bridgeConfig[field]) {
          console.log(`  [${configPath}] WARNING: missing required field "${field}" in bridge config`);
        }
      }

      // Fix 5: Check fileRelay and registry baseUrls aren't pointing to localhost in remote setup
      if (bridgeConfig.registry?.baseUrl && bridgeConfig.fileRelay?.baseUrl) {
        const regUrl = bridgeConfig.registry.baseUrl as string;
        const relayUrl = bridgeConfig.fileRelay.baseUrl as string;
        if (regUrl.includes("localhost") !== relayUrl.includes("localhost")) {
          console.log(`  [${configPath}] WARNING: registry and fileRelay point to different hosts (${regUrl} vs ${relayUrl})`);
        }
      }

      if (changed) {
        writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
      }
    } catch (err: any) {
      console.log(`  [${configPath}] Could not parse: ${err.message}`);
    }
  }

  return fixes;
}

// ── Usage ─────────────────────────────────────────────────────────────────────

function printUsage(): void {
  console.log(`
openclaw-bridge — OpenClaw Bridge CLI

Usage:
  openclaw-bridge <command> [args]

Commands:
  setup                  Interactive setup (Hub URL, API key, manager password)
  status                 Show PM2 processes and Hub connection status
  start                  Start all openclaw instances via ecosystem.config.cjs
  stop                   Stop all PM2 processes
  restart [agent]        Restart specific agent or all (gw- prefix auto-applied)
  logs [agent]           View PM2 logs for agent or all
  backup                 Backup openclaw instances (tar.gz with encryption)
  clean-sessions         Clean old session files (*.deleted.*, *.reset.*, *.old-session*)
  add-agent              Wizard to create a new agent instance
  doctor                 Diagnose common issues
  upgrade                Upgrade openclaw-bridge (plugin + CLI)

Examples:
  openclaw-bridge setup
  openclaw-bridge status
  openclaw-bridge start
  openclaw-bridge restart writer
  openclaw-bridge logs pm
  openclaw-bridge add-agent
  openclaw-bridge doctor
`);
}

// ── Entry point ───────────────────────────────────────────────────────────────

const command = process.argv[2];
const arg = process.argv[3];

(async () => {
  switch (command) {
    case "setup":
      await cmdSetup();
      break;
    case "status":
      await cmdStatus();
      break;
    case "start":
      await cmdStart();
      break;
    case "stop":
      await cmdStop();
      break;
    case "restart":
      await cmdRestart(arg);
      break;
    case "logs":
      await cmdLogs(arg);
      break;
    case "backup":
      await cmdBackup();
      break;
    case "clean-sessions":
      await cmdCleanSessions();
      break;
    case "add-agent":
      await cmdAddAgent();
      break;
    case "doctor":
      await cmdDoctor();
      break;
    case "upgrade":
      await cmdUpgrade();
      break;
    case "--help":
    case "-h":
    case "help":
    case undefined:
      printUsage();
      break;
    default:
      console.error(`Unknown command: ${command}\n`);
      printUsage();
      process.exit(1);
  }
})();
