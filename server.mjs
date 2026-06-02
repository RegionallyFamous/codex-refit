import { createServer } from "node:http";
import { spawn, execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const rootDir = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(process.env.CODEX_REFIT_DATA_DIR || rootDir);
const homeDir = os.homedir();
const appSupport = path.join(homeDir, "Library", "Application Support");
const codexHome = path.resolve(process.env.CODEX_HOME || path.join(homeDir, ".codex"));

const paths = {
  codexHome,
  sessions: path.join(codexHome, "sessions"),
  archivedSessions: path.join(codexHome, "archived_sessions"),
  maintenanceArchive: path.join(codexHome, "maintenance-archive"),
  generatedImages: path.join(codexHome, "generated_images"),
  generatedImagesArchive: path.join(codexHome, "archived_generated_images"),
  configToml: path.join(codexHome, "config.toml"),
  globalAgents: path.join(codexHome, "AGENTS.md"),
  stateDb: path.join(codexHome, "state_5.sqlite"),
  logsDb: path.join(codexHome, "logs_2.sqlite"),
  chromiumCodex: path.join(appSupport, "Codex"),
  desktopCodex: path.join(appSupport, "com.openai.codex"),
  openAiCodex: path.join(appSupport, "OpenAI", "Codex"),
  backupRoot: path.join(dataDir, "tmp", "codex-refit-backups"),
  historyLog: path.join(dataDir, "tmp", "codex-refit-history.jsonl"),
  benchmarkLog: path.join(dataDir, "tmp", "codex-refit-benchmarks.jsonl"),
};

const allowedRoots = [
  paths.codexHome,
  paths.chromiumCodex,
  paths.desktopCodex,
  paths.openAiCodex,
  paths.backupRoot,
].map((allowedPath) => path.resolve(allowedPath));

let actionInProgress = false;

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

function assertAllowed(targetPath) {
  const resolved = path.resolve(targetPath);
  const allowed = allowedRoots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`));
  if (!allowed) {
    throw new Error(`Refusing to operate outside known Codex paths: ${resolved}`);
  }
  return resolved;
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function normalizeDays(value, fallback, { min = 0, max = 3650 } = {}) {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

function normalizePolicy(value) {
  return ["auto", "safe", "reclaim", "max"].includes(value) ? value : "auto";
}

function parseTomlScalar(value) {
  const trimmed = String(value || "").trim();
  if (/^true$/i.test(trimmed)) return true;
  if (/^false$/i.test(trimmed)) return false;
  if (/^".*"$/.test(trimmed) || /^'.*'$/.test(trimmed)) return trimmed.slice(1, -1);
  const number = Number(trimmed);
  return Number.isFinite(number) && trimmed !== "" ? number : trimmed;
}

function parseTomlSummary(text) {
  const values = {};
  const sections = [];
  let section = "";

  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1];
      sections.push(section);
      continue;
    }
    const valueMatch = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (!valueMatch) continue;
    const key = section ? `${section}.${valueMatch[1]}` : valueMatch[1];
    values[key] = parseTomlScalar(valueMatch[2]);
  }

  return { values, sections };
}

function cutoffMs(days) {
  return Date.now() - days * 24 * 60 * 60 * 1000;
}

function basenameLabel(filePath) {
  return path.basename(filePath);
}

async function exists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function statOrNull(targetPath) {
  try {
    return await fs.lstat(targetPath);
  } catch {
    return null;
  }
}

async function duBytes(targetPath) {
  const stats = await statOrNull(targetPath);
  if (!stats) return 0;
  if (stats.isFile()) return stats.size;

  try {
    const { stdout } = await execFileAsync("du", ["-sk", targetPath], {
      timeout: 45000,
      maxBuffer: 1024 * 1024,
    });
    const blocks = Number(stdout.trim().split(/\s+/)[0]);
    return Number.isFinite(blocks) ? blocks * 1024 : 0;
  } catch {
    return 0;
  }
}

function rememberLargest(list, item, limit) {
  list.push(item);
  list.sort((a, b) => b.bytes - a.bytes);
  if (list.length > limit) list.length = limit;
}

async function summarizeDirectory(targetPath, options = {}) {
  const resolved = path.resolve(targetPath);
  const summary = {
    label: options.label || basenameLabel(resolved),
    path: resolved,
    exists: false,
    bytes: 0,
    fileCount: 0,
    dirCount: 0,
    oversized50mb: 0,
    oversized500mb: 0,
    largest: [],
    risk: options.risk || "scan",
    hotspots: [],
  };

  const rootStats = await statOrNull(resolved);
  if (!rootStats) return summary;
  summary.exists = true;

  const largestLimit = options.largestLimit ?? 10;
  const shouldTrackLargest = options.largestPredicate || (() => true);
  const shouldCount = options.filePredicate || (() => true);

  if (rootStats.isFile()) {
    if (shouldCount(resolved, rootStats)) {
      summary.bytes = rootStats.size;
      summary.fileCount = 1;
    }
    if (shouldTrackLargest(resolved, rootStats)) {
      rememberLargest(
        summary.largest,
        {
          name: path.basename(resolved),
          path: resolved,
          bytes: rootStats.size,
          mtime: rootStats.mtime.toISOString(),
          bucket: options.label || "file",
        },
        largestLimit,
      );
    }
    return summary;
  }

  const stack = [resolved];
  while (stack.length) {
    const dir = stack.pop();
    summary.dirCount += 1;

    let entries = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const stats = await statOrNull(fullPath);
      if (!stats || stats.isSymbolicLink()) continue;

      if (stats.isDirectory()) {
        stack.push(fullPath);
        continue;
      }

      if (!stats.isFile()) continue;
      if (shouldCount(fullPath, stats)) {
        summary.bytes += stats.size;
        summary.fileCount += 1;
        if (stats.size >= 50 * 1024 * 1024) summary.oversized50mb += 1;
        if (stats.size >= 500 * 1024 * 1024) summary.oversized500mb += 1;
      }

      if (shouldTrackLargest(fullPath, stats)) {
        rememberLargest(
          summary.largest,
          {
            name: path.basename(fullPath),
            path: fullPath,
            bytes: stats.size,
            mtime: stats.mtime.toISOString(),
            bucket: options.label || path.basename(resolved),
          },
          largestLimit,
        );
      }
    }
  }

  return summary;
}

async function summarizeMany(targets, options = {}) {
  const summary = {
    label: options.label || "Multiple paths",
    path: options.pathLabel || `${targets.length} paths`,
    exists: false,
    bytes: 0,
    fileCount: 0,
    dirCount: 0,
    oversized50mb: 0,
    oversized500mb: 0,
    largest: [],
    risk: options.risk || "scan",
    hotspots: [],
  };

  for (const target of targets) {
    const part = await summarizeDirectory(target, {
      ...options,
      label: path.basename(target),
      largestLimit: options.largestLimit ?? 10,
    });
    if (!part.exists) continue;
    summary.exists = true;
    summary.bytes += part.bytes;
    summary.fileCount += part.fileCount;
    summary.dirCount += part.dirCount;
    summary.oversized50mb += part.oversized50mb;
    summary.oversized500mb += part.oversized500mb;
    for (const item of part.largest) rememberLargest(summary.largest, item, options.largestLimit ?? 10);
  }

  return summary;
}

async function sqliteJson(dbPath, sql, timeout = 30000) {
  if (!(await exists(dbPath))) return [];
  const { stdout } = await execFileAsync("sqlite3", ["-json", dbPath, sql], {
    timeout,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (!stdout.trim()) return [];
  return JSON.parse(stdout);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isSqliteBusyError(error) {
  return /database is locked|database is busy|SQLITE_BUSY|SQLITE_LOCKED|busy timeout/i.test(error?.message || "");
}

async function runSqliteScriptOnce(dbPath, script, timeout = 120000) {
  if (!(await exists(dbPath))) throw new Error(`Missing SQLite database: ${dbPath}`);

  return new Promise((resolve, reject) => {
    const child = spawn("sqlite3", [dbPath], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`SQLite timed out after ${Math.round(timeout / 1000)}s`));
    }, timeout);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(stderr.trim() || `sqlite3 exited with ${code}`));
      }
    });
    child.stdin.end(script);
  });
}

async function runSqliteScript(dbPath, script, timeout = 120000, options = {}) {
  const retries = normalizeDays(options.retries, 2, { min: 0, max: 5 });
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const result = await runSqliteScriptOnce(dbPath, script, timeout);
      return { ...result, attempts: attempt + 1 };
    } catch (error) {
      lastError = error;
      if (!isSqliteBusyError(error) || attempt === retries) break;
      await sleep(300 * 2 ** attempt);
    }
  }

  throw lastError;
}

function retryDetail(result) {
  return result?.attempts > 1 ? [`SQLite busy; succeeded on attempt ${result.attempts}.`] : [];
}

function sqliteCliString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export async function backupSqlite(dbPath, label, includeWal = true) {
  const resolvedDbPath = assertAllowed(dbPath);
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");
  const backupDir = path.join(paths.backupRoot, `${stamp}-${label}`);
  assertAllowed(backupDir);
  await fs.mkdir(backupDir, { recursive: true });

  const copied = [];
  const sidecars = [];
  const manifest = {
    createdAt: new Date().toISOString(),
    method: "sqlite3.backup",
    source: resolvedDbPath,
    snapshot: null,
    sidecars,
  };

  if (await exists(resolvedDbPath)) {
    const snapshot = assertAllowed(path.join(backupDir, path.basename(resolvedDbPath)));
    const backupResult = await runSqliteScript(
      resolvedDbPath,
      `.timeout 15000\n.backup main ${sqliteCliString(snapshot)}\n`,
      90000,
    );
    manifest.snapshot = snapshot;
    manifest.attempts = backupResult.attempts;
    copied.push(snapshot);
  }

  if (includeWal) {
    for (const source of [`${resolvedDbPath}-wal`, `${resolvedDbPath}-shm`]) {
      if (!(await exists(source))) continue;
      const destination = assertAllowed(path.join(backupDir, `${path.basename(source)}.source-copy`));
      await fs.copyFile(source, destination);
      sidecars.push({ source, copy: destination });
      copied.push(destination);
    }
  }

  const manifestPath = assertAllowed(path.join(backupDir, "manifest.json"));
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  copied.push(manifestPath);
  return { backupDir, copied, manifest };
}

async function appendHistory(action, result) {
  await fs.mkdir(path.dirname(paths.historyLog), { recursive: true });
  const entry = {
    at: new Date().toISOString(),
    action,
    summary: result.summary,
    details: result.details || [],
  };
  await fs.appendFile(paths.historyLog, `${JSON.stringify(entry)}\n`, "utf8");
}

function cacheDirs() {
  const profileRoots = [
    paths.chromiumCodex,
    path.join(paths.chromiumCodex, "Default"),
    path.join(paths.chromiumCodex, "Partitions", "codex-browser-app"),
    path.join(paths.chromiumCodex, "Default", "Partitions", "codex-browser-app"),
  ];
  const names = [
    "Cache",
    "GPUCache",
    "Code Cache",
    "DawnGraphiteCache",
    "DawnWebGPUCache",
    "GraphiteDawnCache",
    "GrShaderCache",
    "ShaderCache",
    path.join("Service Worker", "CacheStorage"),
    path.join("Service Worker", "ScriptCache"),
    path.join("Shared Dictionary", "cache"),
  ];

  return [...new Set(profileRoots.flatMap((profile) => names.map((name) => path.join(profile, name))))];
}

function crashDirs() {
  return [
    path.join(paths.desktopCodex, "web", "Crashpad", "pending"),
    path.join(paths.desktopCodex, "web", "Crashpad", "completed"),
    path.join(paths.desktopCodex, "web", "Crashpad", "new"),
    path.join(paths.chromiumCodex, "Crashpad", "pending"),
    path.join(paths.chromiumCodex, "Crashpad", "completed"),
    path.join(paths.chromiumCodex, "Crashpad", "new"),
  ];
}

async function getStateStats(options = {}) {
  const days = normalizeDays(options.days, 5, { min: 1, max: 365 });
  const fallback = {
    threads: {
      total: 0,
      active: 0,
      archived: 0,
      activeOlder7d: 0,
      activeStale: 0,
      staleCutoffDays: days,
      archivedStillInSessions: 0,
    },
  };

  if (!(await exists(paths.stateDb))) return fallback;
  const sessionsPattern = `${paths.sessions}/%`;
  const rows = await sqliteJson(
    paths.stateDb,
    `
      select
        count(*) as total,
        coalesce(sum(case when archived = 0 then 1 else 0 end), 0) as active,
        coalesce(sum(case when archived = 1 then 1 else 0 end), 0) as archived,
        coalesce(sum(case when archived = 0 and updated_at < strftime('%s','now','-7 days') then 1 else 0 end), 0) as activeOlder7d,
        coalesce(sum(case when archived = 0 and updated_at < strftime('%s','now','-${days} days') then 1 else 0 end), 0) as activeStale,
        coalesce(sum(case when archived = 1 and rollout_path like ${sqlString(sessionsPattern)} then 1 else 0 end), 0) as archivedStillInSessions
      from threads;
    `,
  );
  return { threads: { ...fallback.threads, ...(rows[0] || {}) } };
}

async function archivedInActiveTreeSummary() {
  const summary = {
    label: "Archived In Active Tree",
    path: paths.sessions,
    exists: await exists(paths.sessions),
    dbRowCount: 0,
    missingFileCount: 0,
    bytes: 0,
    fileCount: 0,
    dirCount: 0,
    oversized50mb: 0,
    oversized500mb: 0,
    largest: [],
    risk: "warn",
    hotspots: [],
  };

  if (!(await exists(paths.stateDb))) return summary;
  const sessionsPattern = `${paths.sessions}/%`;
  const rows = await sqliteJson(
    paths.stateDb,
    `select rollout_path from threads where archived = 1 and rollout_path like ${sqlString(sessionsPattern)};`,
  );
  summary.dbRowCount = rows.length;

  for (const row of rows) {
    const filePath = row.rollout_path;
    const stats = await statOrNull(filePath);
    if (!stats?.isFile()) {
      summary.missingFileCount += 1;
      continue;
    }
    summary.fileCount += 1;
    summary.bytes += stats.size;
    if (stats.size >= 50 * 1024 * 1024) summary.oversized50mb += 1;
    if (stats.size >= 500 * 1024 * 1024) summary.oversized500mb += 1;
    rememberLargest(
      summary.largest,
      {
        name: path.basename(filePath),
        path: filePath,
        bytes: stats.size,
        mtime: stats.mtime.toISOString(),
        bucket: "Archived in sessions",
      },
      10,
    );
  }
  return summary;
}

async function activeStaleSummary(options = {}) {
  const days = normalizeDays(options.days, 5, { min: 1, max: 365 });
  const summary = {
    label: "Stale Active Sessions",
    path: paths.sessions,
    exists: await exists(paths.sessions),
    days,
    dbRowCount: 0,
    missingFileCount: 0,
    bytes: 0,
    fileCount: 0,
    dirCount: 0,
    oversized50mb: 0,
    oversized500mb: 0,
    largest: [],
    risk: "warn",
    hotspots: [],
  };

  if (!(await exists(paths.stateDb))) return summary;
  const sessionsPattern = `${paths.sessions}/%`;
  const rows = await sqliteJson(
    paths.stateDb,
    `
      select rollout_path
      from threads
      where archived = 0
        and updated_at < strftime('%s','now','-${days} days')
        and rollout_path like ${sqlString(sessionsPattern)};
    `,
  );
  summary.dbRowCount = rows.length;

  for (const row of rows) {
    const filePath = row.rollout_path;
    const stats = await statOrNull(filePath);
    if (!stats?.isFile()) {
      summary.missingFileCount += 1;
      continue;
    }
    summary.fileCount += 1;
    summary.bytes += stats.size;
    if (stats.size >= 50 * 1024 * 1024) summary.oversized50mb += 1;
    if (stats.size >= 500 * 1024 * 1024) summary.oversized500mb += 1;
    rememberLargest(
      summary.largest,
      {
        name: path.basename(filePath),
        path: filePath,
        bytes: stats.size,
        mtime: stats.mtime.toISOString(),
        bucket: "Stale active sessions",
      },
      10,
    );
  }

  return summary;
}

async function archivedDeletionSummary(options = {}) {
  const policy = normalizePolicy(options.policy);
  const days = normalizeDays(options.deleteDays, policy === "max" ? 14 : 30, { min: 1, max: 3650 });
  const cutoffSeconds = Math.floor(Date.now() / 1000) - days * 24 * 60 * 60;
  const summary = {
    label: "Old Archived Conversations",
    path: paths.stateDb,
    exists: await exists(paths.stateDb),
    days,
    dbRowCount: 0,
    missingFileCount: 0,
    bytes: 0,
    fileCount: 0,
    dirCount: 0,
    oversized50mb: 0,
    oversized500mb: 0,
    largest: [],
    risk: "danger",
    hotspots: [],
    ageBasis: "archived_at",
  };

  if (!(await exists(paths.stateDb))) return summary;
  const rows = await sqliteJson(
    paths.stateDb,
    `
      select id, rollout_path
      from threads
      where archived = 1
        and coalesce(archived_at, updated_at) < ${cutoffSeconds}
        and (rollout_path like ${sqlString(`${paths.archivedSessions}/%`)}
          or rollout_path like ${sqlString(`${paths.sessions}/%`)});
    `,
  );
  summary.dbRowCount = rows.length;

  for (const row of rows) {
    const stats = await statOrNull(row.rollout_path);
    if (!stats?.isFile()) {
      summary.missingFileCount += 1;
      continue;
    }
    summary.fileCount += 1;
    summary.bytes += stats.size;
    if (stats.size >= 50 * 1024 * 1024) summary.oversized50mb += 1;
    if (stats.size >= 500 * 1024 * 1024) summary.oversized500mb += 1;
    rememberLargest(
      summary.largest,
      {
        name: path.basename(row.rollout_path),
        path: row.rollout_path,
        bytes: stats.size,
        mtime: stats.mtime.toISOString(),
        bucket: "Old archived conversations",
      },
      10,
    );
  }

  return summary;
}

async function getLogsSummary() {
  const files = [paths.logsDb, `${paths.logsDb}-wal`, `${paths.logsDb}-shm`];
  const summary = {
    label: "Log Database",
    path: paths.logsDb,
    exists: false,
    bytes: 0,
    fileCount: 0,
    dirCount: 0,
    walBytes: 0,
    risk: "warn",
    hotspots: [],
  };

  for (const file of files) {
    const stats = await statOrNull(file);
    if (!stats?.isFile()) continue;
    summary.exists = true;
    summary.fileCount += 1;
    summary.bytes += stats.size;
    if (file.endsWith("-wal")) summary.walBytes = stats.size;
  }
  return summary;
}

async function getCodexConfigSummary() {
  const summary = {
    path: paths.configToml,
    exists: false,
    model: null,
    reasoningEffort: null,
    approvalPolicy: null,
    sandboxMode: null,
    serviceTier: null,
    desktopServiceTier: null,
    fastMode: false,
    fastModeFeature: true,
    shellSnapshot: true,
    goalsFeature: false,
    maxConcurrentThreadsPerSession: null,
    trustedProjectCount: 0,
    enabledPluginCount: 0,
    enabledMcpCount: 0,
    globalAgentsExists: await exists(paths.globalAgents),
  };

  if (!(await exists(paths.configToml))) return summary;
  summary.exists = true;

  try {
    const text = await fs.readFile(paths.configToml, "utf8");
    const parsed = parseTomlSummary(text);
    const { values, sections } = parsed;
    summary.model = values.model || null;
    summary.reasoningEffort = values.model_reasoning_effort || values.reasoning_effort || null;
    summary.approvalPolicy = values.approval_policy || null;
    summary.sandboxMode = values.sandbox_mode || null;
    summary.serviceTier = values.service_tier || values["desktop.default-service-tier"] || null;
    summary.desktopServiceTier = values["desktop.default-service-tier"] || null;
    summary.fastModeFeature = values["features.fast_mode"] !== false;
    summary.fastMode = summary.fastModeFeature && summary.serviceTier === "fast";
    summary.shellSnapshot = values["features.shell_snapshot"] !== false;
    summary.goalsFeature = values["features.goals"] === true;
    summary.maxConcurrentThreadsPerSession = values.max_concurrent_threads_per_session || null;
    summary.trustedProjectCount = sections.filter((section) => section.startsWith('projects."') && values[`${section}.trust_level`] === "trusted").length;
    summary.enabledPluginCount = sections.filter((section) => section.startsWith('plugins."') && values[`${section}.enabled`] === true).length;
    summary.enabledMcpCount = sections.filter((section) => section.startsWith("mcp_servers.") && values[`${section}.enabled`] !== false).length;
  } catch (error) {
    summary.error = error.message;
  }

  return summary;
}

function buildCodexDoctor(scan, codexConfig) {
  const categories = scan.categories || {};
  const activeReliefBytes = (categories.activeStaleSessions?.bytes || 0) + (categories.archivedSessionsInActiveTree?.bytes || 0);
  const logBytes = scan.logs?.bytes || 0;
  const logWalBytes = scan.logs?.walBytes || 0;
  const generatedImageBytes = categories.generatedImages?.bytes || 0;
  const staleThreads = Number(scan.state?.threads?.activeStale ?? scan.state?.threads?.activeOlder7d ?? 0);
  const model = codexConfig?.model || "Not set";
  const effort = codexConfig?.reasoningEffort || "Not set";
  const fastMode = Boolean(codexConfig?.fastMode);
  const fastModeFeature = codexConfig?.fastModeFeature !== false;
  const shellSnapshot = codexConfig?.shellSnapshot !== false;
  const goalsFeature = Boolean(codexConfig?.goalsFeature);
  const tier = codexConfig?.serviceTier || "standard";
  const isHighEffort = ["high", "xhigh", "extra-high", "extra_high"].includes(String(effort).toLowerCase());
  const docsSource = "Official Codex manual: Speed, Models, Config, Prompting, AGENTS";

  const localDetail =
    activeReliefBytes > 0 || logWalBytes > 128 * 1024 ** 2
      ? `Move ${formatBytesServer(activeReliefBytes)} out of active sessions and compact ${formatBytesServer(logBytes + logWalBytes)} of logs.`
      : "Local sessions and logs are not showing major pressure right now.";

  const modelDetail =
    effort === "xhigh" || effort === "high"
      ? `Default is ${model} with ${effort} reasoning. Great for hard work; lower reasoning can feel faster on small tasks.`
      : `Default is ${model} with ${effort} reasoning. Match effort to task size for speed.`;

  const speedDetail = fastMode
    ? `Fast Mode is configured; service tier is ${tier}.`
    : `Fast Mode is not configured here. The Codex manual says /fast can speed supported models when it is available.`;

  const workflowDetail = codexConfig?.globalAgentsExists
    ? "Global AGENTS guidance exists, so repeated preferences can stay out of prompts."
    : "No global AGENTS guidance found; adding durable guidance can reduce repeated correction loops.";

  const cards = [
    {
      id: "local-state",
      label: "Local State",
      value: activeReliefBytes > 0 ? formatBytesServer(activeReliefBytes) : "Steady",
      tone: activeReliefBytes > 1024 ** 3 || logWalBytes > 128 * 1024 ** 2 ? "high" : "low",
      detail: localDetail,
      next: activeReliefBytes > 0 ? "Run Smart Optimize" : "Run Speed Check",
    },
    {
      id: "model-speed",
      label: "Model Settings",
      value: effort === "Not set" ? model : `${model} / ${effort}`,
      tone: effort === "xhigh" ? "medium" : "low",
      detail: `${modelDetail} ${speedDetail}`,
      next: fastMode ? "Keep Fast Mode in mind" : "Check /fast status",
    },
    {
      id: "workflow-context",
      label: "Workflow Context",
      value: codexConfig?.globalAgentsExists ? "Guided" : "Needs Guidance",
      tone: codexConfig?.globalAgentsExists ? "low" : "medium",
      detail: `${workflowDetail} Keep prompts scoped with goal, context, constraints, and done-when checks.`,
      next: "Keep prompts scoped",
    },
    {
      id: "generated-images",
      label: "Image Output",
      value: formatBytesServer(generatedImageBytes),
      tone: generatedImageBytes > 10 * 1024 ** 3 ? "medium" : "low",
      detail: "Generated images are move-only in Codex Refit. They can leave the active cache without being deleted.",
      next: generatedImageBytes > 1024 ** 3 ? "Move old images" : "Leave images alone",
    },
  ];

  const profiles = [
    {
      id: "small-task-speed",
      label: "Small Tasks",
      value: isHighEffort ? "Lower effort" : "Current fit",
      tone: isHighEffort ? "medium" : "low",
      action: isHighEffort ? "Use low or medium" : "Keep prompts tight",
      detail:
        isHighEffort
          ? "The Codex manual recommends low reasoning for faster, well-scoped tasks. Keep high/xhigh for harder debugging and long agentic work."
          : "Current reasoning is not set to high/xhigh. Small, scoped prompts should already avoid unnecessary reasoning drag.",
    },
    {
      id: "fast-mode",
      label: "Fast Mode",
      value: fastMode ? "Configured" : "Check access",
      tone: fastMode ? "low" : "medium",
      action: fastMode ? "Use when worth it" : "/fast status",
      detail: fastMode
        ? `Fast Mode is enabled with service tier ${tier}. The manual notes supported models run faster with higher credit use.`
        : "Run /fast status in Codex. If available, /fast on speeds supported models at higher credit use; persistent config is service_tier = \"fast\" plus features.fast_mode = true.",
    },
    {
      id: "deep-work",
      label: "Deep Work",
      value: model === "gpt-5.5" ? "Best model" : "Use gpt-5.5",
      tone: model === "gpt-5.5" && isHighEffort ? "low" : "medium",
      action: codexConfig?.globalAgentsExists ? "Plan, test, review" : "Add AGENTS.md",
      detail:
        "The manual recommends gpt-5.5 for complex coding, computer use, research, and knowledge work. For long work, pair high reasoning with plan mode, tests, review, and durable AGENTS guidance.",
    },
  ];

  const configAdvice = [
    {
      id: "shell-snapshot",
      label: "Shell Snapshot",
      value: shellSnapshot ? "On" : "Off",
      tone: shellSnapshot ? "low" : "medium",
      action: shellSnapshot ? "Keep enabled" : "Enable shell snapshot",
      detail: shellSnapshot
        ? "Codex can snapshot the shell environment to speed up repeated commands."
        : "Set features.shell_snapshot = true so repeated command setup can be faster.",
    },
    {
      id: "fast-default",
      label: "Fast Default",
      value: fastMode ? "Fast" : fastModeFeature ? tier : "Feature off",
      tone: fastMode ? "low" : "medium",
      action: fastMode ? "Watch credits" : "/fast status",
      detail: fastMode
        ? "Fast Mode is the configured default. It is faster on supported models and uses more credits."
        : fastModeFeature
          ? "Fast Mode selection is available, but this config is not set to the fast service tier."
          : "features.fast_mode is disabled, so the persistent fast service-tier path is not available.",
    },
    {
      id: "goal-mode",
      label: "Goal Mode",
      value: goalsFeature ? "On" : "Optional",
      tone: goalsFeature ? "low" : "medium",
      action: goalsFeature ? "Use for long work" : "Enable for long work",
      detail: goalsFeature
        ? "Goal mode is enabled for persistent, multi-step objectives."
        : "For long speed/refactor work, enable features.goals = true so Codex can keep a clear completion target.",
    },
    {
      id: "guidance",
      label: "Reusable Guidance",
      value: codexConfig?.globalAgentsExists ? "Global ready" : "Missing",
      tone: codexConfig?.globalAgentsExists ? "low" : "medium",
      action: codexConfig?.globalAgentsExists ? "Keep concise" : "Add AGENTS.md",
      detail: codexConfig?.globalAgentsExists
        ? "Global AGENTS guidance is present. Keep it short, practical, and based on repeated friction."
        : "Add ~/.codex/AGENTS.md so recurring preferences do not need to be repeated in every prompt.",
    },
  ];

  const threadLimit = Number(codexConfig?.maxConcurrentThreadsPerSession || 0);
  const trustedProjectCount = Number(codexConfig?.trustedProjectCount || 0);
  const enabledPluginCount = Number(codexConfig?.enabledPluginCount || 0);
  const enabledMcpCount = Number(codexConfig?.enabledMcpCount || 0);
  const workflowAdvice = [
    {
      id: "thread-ceiling",
      label: "Thread Ceiling",
      value: threadLimit ? threadLimit.toLocaleString() : "Default",
      tone: threadLimit >= 128 ? "medium" : "low",
      action: threadLimit >= 128 ? "Avoid same-file overlap" : "Keep work scoped",
      detail:
        threadLimit >= 128
          ? "Your per-session thread ceiling is very high. The Codex manual allows parallel threads, but warns against two threads modifying the same files."
          : "Parallel threads are useful when they stay scoped and avoid editing the same files.",
    },
    {
      id: "trusted-projects",
      label: "Trusted Projects",
      value: trustedProjectCount ? trustedProjectCount.toLocaleString() : "None",
      tone: trustedProjectCount >= 20 ? "medium" : "low",
      action: trustedProjectCount >= 20 ? "Review stale trust" : "Trust intentionally",
      detail:
        trustedProjectCount >= 20
          ? "Many trusted project entries are configured. Trusted projects can load project .codex layers, so stale trust entries make behavior harder to reason about."
          : "Trusted project scope looks tidy.",
    },
    {
      id: "tool-surface",
      label: "Tool Surface",
      value: `${enabledPluginCount} / ${enabledMcpCount}`,
      tone: enabledPluginCount + enabledMcpCount > 10 ? "medium" : "low",
      action: enabledPluginCount + enabledMcpCount > 10 ? "Disable unused" : "Keep intentional",
      detail: `${enabledPluginCount.toLocaleString()} plugin${enabledPluginCount === 1 ? "" : "s"} and ${enabledMcpCount.toLocaleString()} MCP server${enabledMcpCount === 1 ? "" : "s"} are enabled. Keep only useful surfaces active for clearer runs.`,
    },
  ];

  const recommendations = [];
  const addRecommendation = (item) => {
    if (!item?.id || recommendations.some((existing) => existing.id === item.id)) return;
    recommendations.push(item);
  };

  if (activeReliefBytes > 1024 ** 3) {
    addRecommendation({
      id: "run-smart-optimize",
      label: "Smart Optimize",
      value: formatBytesServer(activeReliefBytes),
      action: "Move active weight",
      tone: "high",
      priority: 100,
      detail: "Best local win: move stale active sessions and archived transcripts out of active history without deleting conversations.",
    });
  }

  if (logWalBytes > 128 * 1024 ** 2 || logBytes > 1024 ** 3) {
    addRecommendation({
      id: "prune-logs",
      label: "Log Pressure",
      value: formatBytesServer(logBytes + logWalBytes),
      action: "Prune and checkpoint",
      tone: logWalBytes > 256 * 1024 ** 2 ? "high" : "medium",
      priority: 90,
      detail: "Prune old logs, checkpoint WAL, then compact SQLite so local log scans have less drag.",
    });
  }

  if (isHighEffort) {
    addRecommendation({
      id: "small-task-effort",
      label: "Small Tasks",
      value: effort,
      action: "Try low or medium",
      tone: "medium",
      priority: 82,
      detail: "For quick, well-scoped work, lower reasoning can feel faster. Keep high/xhigh for hard debugging and long agentic tasks.",
    });
  }

  if (!fastMode) {
    addRecommendation({
      id: "check-fast-mode",
      label: "Fast Mode",
      value: fastModeFeature ? tier : "Off",
      action: "/fast status",
      tone: "medium",
      priority: 78,
      detail: "Check whether Fast Mode is available for this sign-in. Supported models can run faster at higher credit use.",
    });
  }

  if (threadLimit >= 128) {
    addRecommendation({
      id: "thread-discipline",
      label: "Thread Discipline",
      value: threadLimit.toLocaleString(),
      action: "Avoid overlap",
      tone: "medium",
      priority: 68,
      detail: "Parallel threads are useful, but avoid running multiple threads against the same files.",
    });
  }

  if (trustedProjectCount >= 20) {
    addRecommendation({
      id: "trusted-project-review",
      label: "Trust Map",
      value: trustedProjectCount.toLocaleString(),
      action: "Review stale trust",
      tone: "medium",
      priority: 54,
      detail: "Trusted projects can load project .codex layers. Pruning stale trusted paths makes Codex behavior easier to predict.",
    });
  }

  if (!goalsFeature) {
    addRecommendation({
      id: "enable-goals",
      label: "Long Work",
      value: "Goal Mode",
      action: "Enable when needed",
      tone: "medium",
      priority: 46,
      detail: "Goal mode helps Codex keep a persistent completion target for multi-step refits and performance work.",
    });
  }

  if (generatedImageBytes > 10 * 1024 ** 3) {
    addRecommendation({
      id: "move-generated-images",
      label: "Image Cache",
      value: formatBytesServer(generatedImageBytes),
      action: "Move old images",
      tone: "medium",
      priority: 42,
      detail: "Generated images are move-only in Codex Refit. Older items can move to archived_generated_images and are never deleted.",
    });
  }

  if (!recommendations.length) {
    addRecommendation({
      id: "run-speed-check",
      label: "Speed Check",
      value: "Ready",
      action: "Benchmark",
      tone: "low",
      priority: 10,
      detail: "No major local or configuration pressure is showing. Run Speed Check to refresh the baseline.",
    });
  }

  recommendations.sort((a, b) => b.priority - a.priority);

  const headline =
    activeReliefBytes > 1024 ** 3
      ? `Best next win: move ${formatBytesServer(activeReliefBytes)} out of active sessions.`
      : effort === "xhigh"
        ? "Local state is only one lever; xhigh reasoning can be slower on small tasks."
        : "Codex Doctor is checking local state, model settings, and workflow context.";

  return {
    headline,
    docsSource,
    model,
    reasoningEffort: effort,
    fastMode,
    serviceTier: tier,
    fastModeFeature,
    shellSnapshot,
    goalsFeature,
    maxConcurrentThreadsPerSession: codexConfig?.maxConcurrentThreadsPerSession || null,
    trustedProjectCount: codexConfig?.trustedProjectCount || 0,
    enabledPluginCount,
    enabledMcpCount,
    cards,
    profiles,
    configAdvice,
    workflowAdvice,
    recommendations,
  };
}

function addHotspots(scan) {
  const { categories, state, logs } = scan;
  categories.activeSessions.hotspots = [
    `${categories.activeSessions.oversized50mb.toLocaleString()} files over 50 MB`,
    `${categories.activeSessions.oversized500mb.toLocaleString()} files over 500 MB`,
    `${formatBytesServer(categories.activeStaleSessions.bytes)} older than ${categories.activeStaleSessions.days} days`,
  ];
  categories.activeStaleSessions.hotspots = [
    `${categories.activeStaleSessions.fileCount.toLocaleString()} active transcript${categories.activeStaleSessions.fileCount === 1 ? "" : "s"} older than ${categories.activeStaleSessions.days} days`,
    `${categories.activeStaleSessions.oversized50mb.toLocaleString()} stale file${categories.activeStaleSessions.oversized50mb === 1 ? "" : "s"} over 50 MB`,
  ];
  categories.archivedSessionsInActiveTree.hotspots = [
    `${categories.archivedSessionsInActiveTree.fileCount.toLocaleString()} archived transcript file${categories.archivedSessionsInActiveTree.fileCount === 1 ? "" : "s"} still in active sessions`,
    `${categories.archivedSessionsInActiveTree.missingFileCount.toLocaleString()} stale archived DB pointer${categories.archivedSessionsInActiveTree.missingFileCount === 1 ? "" : "s"}`,
  ];
  categories.archivedSessions.hotspots = [
    `${categories.archivedSessions.oversized50mb.toLocaleString()} files over 50 MB`,
    "Only delete old archived history when you truly want it gone.",
  ];
  categories.archivedDeleteCandidates.hotspots = [
    `${categories.archivedDeleteCandidates.dbRowCount.toLocaleString()} archived record${categories.archivedDeleteCandidates.dbRowCount === 1 ? "" : "s"} archived longer than ${categories.archivedDeleteCandidates.days} days`,
    `${formatBytesServer(categories.archivedDeleteCandidates.bytes)} of files plus ${categories.archivedDeleteCandidates.missingFileCount.toLocaleString()} stale pointer${categories.archivedDeleteCandidates.missingFileCount === 1 ? "" : "s"}`,
  ];
  categories.maintenanceArchive.hotspots = [
    "Old backup bundles are outside the active session folders.",
    "Deleting these can recover disk space, but only after you allow deletes.",
  ];
  categories.generatedImages.hotspots = [
    "Codex Refit never deletes generated images.",
    "Old image batches can move to archived_generated_images.",
  ];
  categories.generatedImagesArchive.hotspots = [
    "Generated images that were moved out of the active cache.",
    "Kept on disk so you can recover or export them later.",
  ];
  categories.logs.hotspots = [
    `${logs.fileCount.toLocaleString()} SQLite files`,
    logs.walBytes ? `${formatBytesServer(logs.walBytes)} in WAL` : "No large WAL file",
  ];
  categories.crashDumps.hotspots = [
    `${categories.crashDumps.fileCount.toLocaleString()} crash report files`,
    "Crash dumps are disposable for day-to-day speed.",
  ];
  categories.browserCaches.hotspots = [
    `${categories.browserCaches.dirCount.toLocaleString()} cache directories`,
    "Codex can rebuild these after restart.",
  ];
  categories.codexChromium.hotspots = ["Chromium profile data, models, and cache material."];
}

function formatBytesServer(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${value >= 10 || exponent === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[exponent]}`;
}

function wantsAutoArchiveDays(value) {
  return value === undefined || value === null || value === "" || ["auto", "smart"].includes(String(value).toLowerCase());
}

function resolveArchiveChoice(options = {}, activeSessions = {}) {
  if (!wantsAutoArchiveDays(options.days)) {
    const days = normalizeDays(options.days, 5, { min: 1, max: 90 });
    return {
      mode: "manual",
      days,
      label: `${days}d manual`,
      reason: `Using the manual ${days}-day stale-thread cutoff.`,
    };
  }

  const activeBytes = activeSessions.bytes || 0;
  const oversized50mb = activeSessions.oversized50mb || 0;
  const activeGb = activeBytes / 1024 ** 3;
  let days = 10;
  let pressure = "light";

  if (activeGb >= 18 || oversized50mb >= 55) {
    days = 3;
    pressure = "heavy";
  } else if (activeGb >= 5 || oversized50mb >= 20) {
    days = 5;
    pressure = "loaded";
  }

  return {
    mode: "auto",
    days,
    pressure,
    label: `Auto ${days}d`,
    reason:
      pressure === "heavy"
        ? `Active history is heavy, so Refit archives conversations older than ${days} days.`
        : pressure === "loaded"
          ? `Active history is loaded, so Refit uses a ${days}-day stale cutoff.`
          : `Active history is light, so Refit uses a gentler ${days}-day stale cutoff.`,
  };
}

function parseLsofProcesses(output) {
  const processes = [];
  let current = null;
  for (const line of String(output || "").split("\n")) {
    if (!line) continue;
    if (line.startsWith("p")) {
      if (current) processes.push(current);
      current = { pid: Number(line.slice(1)), command: "unknown" };
    } else if (line.startsWith("c") && current) {
      current.command = line.slice(1) || "unknown";
    }
  }
  if (current) processes.push(current);

  const seen = new Set();
  return processes.filter((processInfo) => {
    const key = `${processInfo.pid}:${processInfo.command}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return Number.isFinite(processInfo.pid);
  });
}

async function getPreflightStatus() {
  const candidates = [paths.stateDb, `${paths.stateDb}-wal`, paths.logsDb, `${paths.logsDb}-wal`];
  const existingTargets = [];
  for (const candidate of candidates) {
    if (await exists(candidate)) existingTargets.push(candidate);
  }

  if (!existingTargets.length) {
    return {
      status: "unknown",
      label: "Unknown",
      detail: "Codex state files were not found for preflight.",
      openProcessCount: 0,
      processes: [],
    };
  }

  try {
    const { stdout } = await execFileAsync("lsof", ["-F", "pc", ...existingTargets], {
      timeout: 2500,
      maxBuffer: 256 * 1024,
    });
    const processes = parseLsofProcesses(stdout);
    if (actionInProgress) {
      return {
        status: "busy",
        label: "Busy",
        detail: "A Codex Refit action is already running.",
        openProcessCount: processes.length,
        processes,
      };
    }
    if (processes.length) {
      const names = [...new Set(processes.map((processInfo) => processInfo.command))].slice(0, 3).join(", ");
      return {
        status: "active",
        label: "DB Active",
        detail: `${processes.length.toLocaleString()} process${processes.length === 1 ? "" : "es"} currently ${processes.length === 1 ? "has" : "have"} Codex state files open${names ? ` (${names})` : ""}. Safe moves can still run, but retry if SQLite is busy.`,
        openProcessCount: processes.length,
        processes,
      };
    }
  } catch {
    // lsof exits with code 1 when no process has the files open.
  }

  return {
    status: actionInProgress ? "busy" : "ready",
    label: actionInProgress ? "Busy" : "Ready",
    detail: actionInProgress ? "A Codex Refit action is already running." : "No open Codex state-file handles detected.",
    openProcessCount: 0,
    processes: [],
  };
}

export async function scanCodex(options = {}) {
  const activeSessions = await summarizeDirectory(paths.sessions, { label: "Active Sessions", risk: "warn", largestLimit: 12 });
  const archiveChoice = resolveArchiveChoice(options, activeSessions);
  const archiveOptions = { ...options, days: archiveChoice.days };
  const [
    archivedSessions,
    maintenanceArchive,
    generatedImages,
    generatedImagesArchive,
    crashDumps,
    browserCaches,
    archivedStillInSessions,
    activeStale,
    archivedDeleteCandidates,
    logs,
    state,
    preflight,
    codexConfig,
  ] = await Promise.all([
    summarizeDirectory(paths.archivedSessions, { label: "Archived Sessions", risk: "warn", largestLimit: 12 }),
    summarizeDirectory(paths.maintenanceArchive, {
      label: "Old Refit Backups",
      risk: "danger",
      largestLimit: 12,
      largestPredicate: (filePath) => filePath.endsWith(".jsonl"),
    }),
    summarizeDirectory(paths.generatedImages, { label: "Generated Images", risk: "warn", largestLimit: 8 }),
    summarizeDirectory(paths.generatedImagesArchive, { label: "Moved Generated Images", risk: "scan", largestLimit: 8 }),
    summarizeMany(crashDirs(), {
      label: "Crash Dumps",
      pathLabel: "Crashpad pending/completed",
      risk: "warn",
      filePredicate: (filePath) => filePath.endsWith(".dmp"),
      largestPredicate: (filePath) => filePath.endsWith(".dmp"),
      largestLimit: 8,
    }),
    summarizeMany(cacheDirs(), {
      label: "Browser Caches",
      pathLabel: "Known Chromium cache directories",
      risk: "warn",
      largestLimit: 8,
    }),
    archivedInActiveTreeSummary(),
    activeStaleSummary(archiveOptions),
    archivedDeletionSummary(options),
    getLogsSummary(),
    getStateStats(archiveOptions),
    getPreflightStatus(),
    getCodexConfigSummary(),
  ]);

  const codexHomeBytes = await duBytes(paths.codexHome);
  const codexChromiumBytes = await duBytes(paths.chromiumCodex);
  const desktopCodexBytes = await duBytes(paths.desktopCodex);

  const categories = {
    codexHome: {
      label: "Codex Home",
      path: paths.codexHome,
      exists: codexHomeBytes > 0,
      bytes: codexHomeBytes,
      fileCount: 0,
      dirCount: 0,
      risk: "scan",
      hotspots: ["Sessions, generated images, logs, and local state."],
    },
    codexChromium: {
      label: "Codex App Support",
      path: paths.chromiumCodex,
      exists: codexChromiumBytes > 0,
      bytes: codexChromiumBytes,
      fileCount: 0,
      dirCount: 0,
      risk: "scan",
      hotspots: [],
    },
    codexDesktop: {
      label: "Codex Desktop Support",
      path: paths.desktopCodex,
      exists: desktopCodexBytes > 0,
      bytes: desktopCodexBytes,
      fileCount: 0,
      dirCount: 0,
      risk: "scan",
      hotspots: ["Desktop wrapper state and crash reports."],
    },
    activeSessions,
    activeStaleSessions: activeStale,
    archivedSessions,
    archivedSessionsInActiveTree: archivedStillInSessions,
    archivedDeleteCandidates,
    maintenanceArchive,
    generatedImages,
    generatedImagesArchive,
    logs,
    crashDumps,
    browserCaches,
  };

  const largestSessionCandidates = [
    ...activeStale.largest.map((file) => ({ ...file, bucket: "Stale active sessions" })),
    ...archivedDeleteCandidates.largest.map((file) => ({ ...file, bucket: "Old archived conversations" })),
    ...activeSessions.largest.map((file) => ({ ...file, bucket: "Active sessions" })),
    ...archivedSessions.largest.map((file) => ({ ...file, bucket: "Archived sessions" })),
    ...maintenanceArchive.largest.map((file) => ({ ...file, bucket: "Old Refit backups" })),
    ...archivedStillInSessions.largest,
  ].sort((a, b) => b.bytes - a.bytes);
  const seenLargestPaths = new Set();
  const largestSessionFiles = largestSessionCandidates
    .filter((file) => {
      if (seenLargestPaths.has(file.path)) return false;
      seenLargestPaths.add(file.path);
      return true;
    })
    .slice(0, 20);

  const scan = {
    ok: true,
    generatedAt: new Date().toISOString(),
    paths,
    archiveChoice,
    preflight,
    state,
    logs,
    codexConfig,
    categories,
    largestSessionFiles,
  };

  addHotspots(scan);
  scan.smartPlan = buildSmartPlan(scan, { ...options, days: archiveChoice.days, archiveChoice });
  scan.codexDoctor = buildCodexDoctor(scan, codexConfig);
  return scan;
}

function clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function benchmarkScore(metrics) {
  const gb = (bytes) => (Number(bytes) || 0) / 1024 ** 3;
  let score = 100;
  score -= Math.min(28, gb(metrics.activeSessionBytes) * 1.2);
  score -= Math.min(22, gb(metrics.logBytes) * 2.5);
  score -= Math.min(18, gb(metrics.logWalBytes) * 12);
  score -= Math.min(18, metrics.oversizedActiveFiles * 0.25);
  score -= Math.min(10, metrics.archivedFilesInSessions * 0.2);
  score -= Math.min(10, metrics.staleThreads * 0.08);
  return Math.round(clampNumber(score, 0, 100));
}

function benchmarkLiveScore(metrics) {
  let score = benchmarkScore(metrics);
  score -= Math.min(14, metrics.scanMs / 900);
  score -= Math.min(12, metrics.stateQueryMs / 40);
  score -= Math.min(12, metrics.logQueryMs / 80);
  return Math.round(clampNumber(score, 0, 100));
}

function benchmarkRating(score) {
  if (score >= 88) return "Cruising";
  if (score >= 72) return "Healthy";
  if (score >= 55) return "Loaded";
  if (score >= 35) return "Heavy";
  return "Bogged";
}

function benchmarkMeaning(score) {
  if (score >= 88) return "Codex state is light. Keep scanning occasionally.";
  if (score >= 72) return "Codex is healthy, with only light local slowdown.";
  if (score >= 55) return "Loaded means local history and logs are starting to add drag.";
  if (score >= 35) return "Heavy means local sessions, logs, or archived pointers are probably slowing Codex down.";
  return "Bogged means local Codex state needs cleanup before speed can recover.";
}

function benchmarkGuidance(metrics) {
  const guidance = [];
  if (metrics.staleActiveBytes > 1024 ** 3) {
    guidance.push(
      `Archive ${Number(metrics.staleThreads).toLocaleString()} stale active thread${metrics.staleThreads === 1 ? "" : "s"} to move ${formatBytesServer(metrics.staleActiveBytes)} out of active sessions.`,
    );
  }
  if (metrics.archivedFilesInSessions > 0) {
    guidance.push(
      `Move ${Number(metrics.archivedFilesInSessions).toLocaleString()} archived transcript file${metrics.archivedFilesInSessions === 1 ? "" : "s"} out of active sessions.`,
    );
  }
  if (metrics.staleActiveBytes <= 1024 ** 3 && metrics.staleThreads > 0) {
    guidance.push(`Archive ${Number(metrics.staleThreads).toLocaleString()} stale thread${metrics.staleThreads === 1 ? "" : "s"} so active history is lighter.`);
  }
  if (metrics.logWalBytes > 256 * 1024 ** 2) guidance.push("Prune and checkpoint logs to shrink WAL pressure.");
  if (metrics.logBytes > 1024 ** 3) guidance.push(`Compact ${formatBytesServer(metrics.logBytes)} of local log data.`);
  if (metrics.oversizedActiveFiles > 20) guidance.push("Move or archive old large transcripts out of active sessions.");
  if (metrics.stateQueryMs > 250) guidance.push("Optimize the state database because thread queries are slow.");
  if (metrics.staleArchivedPointers > 0) {
    guidance.push(
      `Recover Space can remove ${Number(metrics.archivedDeleteRows).toLocaleString()} archived record${metrics.archivedDeleteRows === 1 ? "" : "s"} older than ${metrics.archivedDeleteDays} days; ${Number(metrics.staleArchivedPointers).toLocaleString()} stale archived pointer${metrics.staleArchivedPointers === 1 ? "" : "s"} exist in total.`,
    );
  }
  if (metrics.safeReclaimBytes > 1024 ** 3) guidance.push("Smart Optimize can move useful load out of active folders.");
  if (!guidance.length) guidance.push("Local Codex state looks reasonably tidy.");
  return guidance;
}

function scanProofMetrics(scan) {
  const categories = scan?.categories || {};
  return {
    generatedAt: scan?.generatedAt || new Date().toISOString(),
    totalStateBytes:
      (categories.codexHome?.bytes || 0) +
      (categories.codexChromium?.bytes || 0) +
      (categories.codexDesktop?.bytes || 0),
    activeSessionBytes: categories.activeSessions?.bytes || 0,
    activeStaleBytes: categories.activeStaleSessions?.bytes || 0,
    activeStaleThreads: Number(scan?.state?.threads?.activeStale ?? scan?.state?.threads?.activeOlder7d ?? 0),
    activeOversizedFiles: categories.activeSessions?.oversized50mb || 0,
    logBytes: scan?.logs?.bytes || 0,
    logWalBytes: scan?.logs?.walBytes || 0,
    archivedFilesInSessions: categories.archivedSessionsInActiveTree?.fileCount || 0,
    archivedDeleteRows: categories.archivedDeleteCandidates?.dbRowCount || 0,
    archivedDeleteBytes: categories.archivedDeleteCandidates?.bytes || 0,
  };
}

export function buildRefitOutcome(beforeScan, afterScan, { results = [], skippedLocked = [] } = {}) {
  const before = scanProofMetrics(beforeScan);
  const after = scanProofMetrics(afterScan);
  const deltaKeys = [
    "totalStateBytes",
    "activeSessionBytes",
    "activeStaleBytes",
    "activeStaleThreads",
    "activeOversizedFiles",
    "logBytes",
    "logWalBytes",
    "archivedFilesInSessions",
    "archivedDeleteRows",
    "archivedDeleteBytes",
  ];
  const deltas = Object.fromEntries(deltaKeys.map((key) => [key, after[key] - before[key]]));
  const reductions = {
    totalStateBytes: Math.max(0, -deltas.totalStateBytes),
    activeSessionBytes: Math.max(0, -deltas.activeSessionBytes),
    activeStaleBytes: Math.max(0, -deltas.activeStaleBytes),
    activeStaleThreads: Math.max(0, -deltas.activeStaleThreads),
    logBytes: Math.max(0, -deltas.logBytes),
    logWalBytes: Math.max(0, -deltas.logWalBytes),
    archivedDeleteRows: Math.max(0, -deltas.archivedDeleteRows),
  };
  const headline =
    reductions.activeSessionBytes > 0
      ? `Active folder lighter by ${formatBytesServer(reductions.activeSessionBytes)}`
      : reductions.logBytes > 0 || reductions.logWalBytes > 0
        ? `Logs lighter by ${formatBytesServer(reductions.logBytes + reductions.logWalBytes)}`
        : reductions.totalStateBytes > 0
          ? `Codex state lighter by ${formatBytesServer(reductions.totalStateBytes)}`
          : "Refit complete; scan is current";
  return {
    generatedAt: new Date().toISOString(),
    headline,
    before,
    after,
    deltas,
    reductions,
    actionCount: results.length,
    skippedLockedCount: skippedLocked.length,
  };
}

function buildSlowdownDiagnosis(scan, context = {}) {
  const gb = (bytes) => (Number(bytes) || 0) / 1024 ** 3;
  const mb = (bytes) => (Number(bytes) || 0) / 1024 ** 2;
  const categories = scan.categories || {};
  const state = scan.state?.threads || {};
  const activeFolderReliefBytes = context.activeFolderReliefBytes || 0;
  const logBytes = scan.logs?.bytes || 0;
  const logWalBytes = scan.logs?.walBytes || 0;
  const archivedDeleteBytes = context.deletePreviewBytes || 0;
  const generatedImageBytes = categories.generatedImages?.bytes || 0;
  const cacheBytes = categories.browserCaches?.bytes || 0;
  const crashBytes = categories.crashDumps?.bytes || 0;
  const staleThreads = Number(state.activeStale ?? state.activeOlder7d ?? 0);
  const oversizedActive = categories.activeSessions?.oversized50mb || 0;
  const archivedActiveFiles = categories.archivedSessionsInActiveTree?.fileCount || 0;
  const activeBytes = categories.activeSessions?.bytes || 0;
  const nonDestructiveSteps = context.nonDestructiveSteps || [];
  const destructiveSteps = context.destructiveSteps || [];
  const archiveChoice = context.archiveChoice || scan.archiveChoice || null;

  const signals = [
    {
      id: "active-history",
      label: "Active History",
      value: formatBytesServer(activeFolderReliefBytes || activeBytes),
      score: gb(activeFolderReliefBytes) * 8 + gb(activeBytes) * 1.2 + staleThreads * 0.05 + oversizedActive * 0.25 + archivedActiveFiles * 0.6,
      tone: activeFolderReliefBytes > 1024 ** 3 ? "high" : activeBytes > 5 * 1024 ** 3 ? "medium" : "low",
      detail:
        activeFolderReliefBytes > 0
          ? `${formatBytesServer(activeFolderReliefBytes)} can leave active history without deleting conversations.`
          : "Active history is not the main slowdown right now.",
    },
    {
      id: "logs",
      label: "Logs",
      value: formatBytesServer(logBytes + logWalBytes),
      score: gb(logBytes) * 5 + gb(logWalBytes) * 24,
      tone: logWalBytes > 128 * 1024 ** 2 || logBytes > 1024 ** 3 ? "high" : "low",
      detail:
        logWalBytes > 0
          ? `${formatBytesServer(logWalBytes)} is waiting in WAL; pruning checkpoints it.`
          : "Log pressure is low.",
    },
    {
      id: "archived-data",
      label: "Archived Data",
      value: formatBytesServer(archivedDeleteBytes),
      score: gb(archivedDeleteBytes) * 0.18 + gb(generatedImageBytes) * 0.08,
      tone: archivedDeleteBytes > 1024 ** 3 ? "danger" : "low",
      detail:
        archivedDeleteBytes > 0
          ? `${formatBytesServer(archivedDeleteBytes)} can be removed only after you allow deletes.`
          : "No old archived-history delete is selected.",
    },
    {
      id: "caches",
      label: "Caches",
      value: formatBytesServer(cacheBytes + crashBytes),
      score: mb(cacheBytes) / 40 + mb(crashBytes) / 20,
      tone: cacheBytes + crashBytes > 256 * 1024 ** 2 ? "medium" : "low",
      detail: "Crash dumps and rebuildable browser caches are disposable.",
    },
  ].sort((a, b) => b.score - a.score);

  const primary = signals[0];
  const confidence = primary.score >= 30 ? "High" : primary.score >= 12 ? "Medium" : "Low";
  const nextAction = nonDestructiveSteps[0]?.label
    || (destructiveSteps[0] ? `Allow deletes for ${destructiveSteps[0].label}` : "Run Speed Check");
  const severity = primary.score >= 45 ? "Heavy" : primary.score >= 20 ? "Loaded" : "Light";

  return {
    primaryCause: primary.score < 4 ? "No Major Drag" : primary.label,
    confidence,
    severity,
    nextAction,
    archiveDays: archiveChoice?.days || null,
    archiveLabel: archiveChoice?.label || null,
    archiveReason: archiveChoice?.reason || null,
    detail: primary.score < 4 ? "No obvious local slowdown is showing." : primary.detail,
    signals: signals.slice(0, 3).map(({ label, value, tone, detail, score }) => ({
      label,
      value,
      tone,
      detail,
      score: Math.round(score),
    })),
  };
}

function buildSmartPlan(scan, options = {}) {
  const days = normalizeDays(options.days, 5, { min: 1, max: 90 });
  const archiveChoice = options.archiveChoice || scan.archiveChoice || {
    mode: wantsAutoArchiveDays(options.days) ? "auto" : "manual",
    days,
    label: `${wantsAutoArchiveDays(options.days) ? "Auto" : "Manual"} ${days}d`,
    reason: `Using a ${days}-day stale-thread cutoff.`,
  };
  const logDays = normalizeDays(options.logDays, 7, { min: 1, max: 365 });
  const requestedPolicy = normalizePolicy(options.policy);
  const staleThreads = Number(scan.state?.threads?.activeStale ?? scan.state?.threads?.activeOlder7d ?? 0);
  const staleActiveBytes = scan.categories.activeStaleSessions?.bytes || 0;
  const archivedActiveFiles = scan.categories.archivedSessionsInActiveTree?.fileCount || 0;
  const archivedActiveMissing = scan.categories.archivedSessionsInActiveTree?.missingFileCount || 0;
  const archivedDeleteRows = scan.categories.archivedDeleteCandidates?.dbRowCount || 0;
  const archivedDeleteFiles = scan.categories.archivedDeleteCandidates?.fileCount || 0;
  const archivedDeleteMissing = scan.categories.archivedDeleteCandidates?.missingFileCount || 0;
  const archivedDeleteBytes = scan.categories.archivedDeleteCandidates?.bytes || 0;
  const maintenanceBytes = scan.categories.maintenanceArchive?.bytes || 0;
  const generatedImageBytes = scan.categories.generatedImages?.bytes || 0;
  let suggestedPolicy = "safe";
  let suggestedReason = "Safe mode has useful cleanup and is the right default.";
  if (maintenanceBytes > 5 * 1024 ** 3 || archivedDeleteBytes > 256 * 1024 ** 2 || archivedDeleteRows > 25) {
    suggestedPolicy = "reclaim";
    suggestedReason = "Recover Space can free a lot of disk, but delete actions stay locked until you allow them.";
  }
  if (generatedImageBytes > 20 * 1024 ** 3) {
    suggestedPolicy = "max";
    suggestedReason = "Full Pass can move a very large generated-image cache without deleting those files.";
  }
  const effectivePolicy = requestedPolicy === "auto" ? suggestedPolicy : requestedPolicy;
  const deleteDaysFallback = effectivePolicy === "max" ? 14 : 30;
  const deleteDays = normalizeDays(options.deleteDays, deleteDaysFallback, { min: 1, max: 3650 });
  const steps = [];
  const order = {
    archiveStaleThreads: 10,
    migrateArchivedSessions: 20,
    deleteArchivedTranscripts: 30,
    archivedHistoryTooNew: 31,
    pruneLogs: 40,
    deleteMaintenanceArchives: 50,
    archiveGeneratedImages: 60,
    deleteCrashDumps: 70,
    cleanBrowserCaches: 80,
    vacuumState: 90,
    speedCheck: 100,
  };
  const addStep = (id, label, reason, impact = "medium", extra = {}) => {
    if (!steps.some((step) => step.id === id)) steps.push({ id, label, reason, impact, ...extra });
  };

  if (staleThreads > 0) {
    addStep(
      "archiveStaleThreads",
      "Archive stale active threads",
      `${staleThreads.toLocaleString()} active thread${staleThreads === 1 ? "" : "s"} are older than ${days} days (${formatBytesServer(staleActiveBytes)}).`,
      "high",
    );
    addStep(
      "migrateArchivedSessions",
      "Move archived transcripts",
      "Archived transcripts leave the active sessions folder after stale threads are archived.",
      "high",
    );
    addStep(
      "vacuumState",
      "Compact state database",
      "Compacts thread state after archive metadata changes.",
      "medium",
    );
  }

  if (archivedActiveFiles > 0) {
    addStep(
      "migrateArchivedSessions",
      "Move archived transcripts",
      `${archivedActiveFiles.toLocaleString()} archived transcript file${archivedActiveFiles === 1 ? "" : "s"} still sit in active sessions.`,
      "high",
    );
    addStep(
      "vacuumState",
      "Compact state database",
      "Compacts thread state after transcript paths change.",
      "medium",
    );
  }

  const activeBytes = scan.categories.activeSessions?.bytes || 0;
  const oversizedActive = scan.categories.activeSessions?.oversized50mb || 0;
  if ((activeBytes > 5 * 1024 ** 3 || oversizedActive > 20) && archivedActiveFiles > 0) {
    addStep(
      "migrateArchivedSessions",
      "Move archived transcripts",
      "Moving old archived transcripts out of active sessions reduces folder weight without deleting conversations.",
      "high",
    );
  }

  const logBytes = scan.logs?.bytes || 0;
  const logWalBytes = scan.logs?.walBytes || 0;
  if (logWalBytes > 128 * 1024 ** 2 || logBytes > 1024 ** 3) {
    addStep(
      "pruneLogs",
      "Prune and compact logs",
      `${formatBytesServer(logBytes)} log core with ${formatBytesServer(logWalBytes)} in WAL. Keeps the last ${logDays} days.`,
      "high",
      { logDays },
    );
  }

  const crashBytes = scan.categories.crashDumps?.bytes || 0;
  if ((scan.categories.crashDumps?.fileCount || 0) > 0 || crashBytes > 0) {
    addStep(
      "deleteCrashDumps",
      "Clear crash reports",
      `${formatBytesServer(crashBytes)} disposable crash report data.`,
      "medium",
    );
  }

  const cacheBytes = scan.categories.browserCaches?.bytes || 0;
  if (cacheBytes > 50 * 1024 ** 2) {
    addStep(
      "cleanBrowserCaches",
      "Clean rebuildable caches",
      `${formatBytesServer(cacheBytes)} cache data Codex can rebuild.`,
      "medium",
    );
  }

  if (effectivePolicy !== "safe") {
    if (archivedDeleteRows > 0) {
      addStep(
        "deleteArchivedTranscripts",
        "Delete old archived history",
        `Can remove ${archivedDeleteRows.toLocaleString()} archived record${archivedDeleteRows === 1 ? "" : "s"} older than ${deleteDays} days (${formatBytesServer(archivedDeleteBytes)} across ${archivedDeleteFiles.toLocaleString()} file${archivedDeleteFiles === 1 ? "" : "s"}, plus ${archivedDeleteMissing.toLocaleString()} stale pointer${archivedDeleteMissing === 1 ? "" : "s"}).`,
        "danger",
        { confirmRequired: true, deleteDays },
      );
    } else if (archivedActiveMissing > 0 || (scan.state?.threads?.archived || 0) > 0) {
      addStep(
        "archivedHistoryTooNew",
        "Archived history too new",
        `No archived records are older than ${deleteDays} days yet. Lower the archived age only if that history can go away sooner.`,
        "low",
        { disabled: true, deleteDays },
      );
    }

    if (maintenanceBytes > 250 * 1024 ** 2 || (effectivePolicy === "max" && maintenanceBytes > 0)) {
      addStep(
        "deleteMaintenanceArchives",
        "Delete old Refit backups",
        `${formatBytesServer(maintenanceBytes)} in old backup bundles.`,
        "danger",
        { confirmRequired: true, deleteDays: effectivePolicy === "max" ? 0 : 14 },
      );
    }
  }

  if (effectivePolicy === "max") {
    if (generatedImageBytes > 1024 ** 3) {
      addStep(
        "archiveGeneratedImages",
        "Move old generated images",
        `${formatBytesServer(generatedImageBytes)} in generated images. Keeps recent items in place and moves older batches to archived_generated_images.`,
        "medium",
        { days: Math.max(deleteDays, 14) },
      );
    }
  }

  steps.sort((a, b) => (order[a.id] || 999) - (order[b.id] || 999));

  if (!steps.length) {
    addStep("speedCheck", "Run speed check", "No obvious action is waiting; benchmark to confirm.", "low");
  }

  const executableSteps = steps.filter((step) => step.id !== "speedCheck" && !step.disabled);
  const destructiveSteps = executableSteps.filter((step) => step.confirmRequired);
  const nonDestructiveSteps = executableSteps.filter((step) => !step.confirmRequired);
  const activeFolderReliefBytes = staleActiveBytes + (scan.categories.archivedSessionsInActiveTree?.bytes || 0);
  const deletePreviewBytes =
    archivedDeleteBytes +
    (effectivePolicy !== "safe" && destructiveSteps.some((step) => step.id === "deleteMaintenanceArchives")
      ? maintenanceBytes
      : 0);
  const headline =
    activeFolderReliefBytes > 0
      ? `Move ${formatBytesServer(activeFolderReliefBytes)} out of active history`
      : logBytes > 1024 ** 3
        ? `Compact ${formatBytesServer(logBytes)} of logs`
        : destructiveSteps.length
          ? `Recover ${formatBytesServer(deletePreviewBytes)} from old archived data`
          : "No urgent local slowdown detected";
  const decision = {
    suggestedPolicy,
    suggestedReason,
    headline,
    selectedPolicy: requestedPolicy,
    effectivePolicy,
    nonDestructiveSteps: nonDestructiveSteps.length,
    destructiveSteps: destructiveSteps.length,
    destructiveStepLabels: destructiveSteps.map((step) => step.label),
    deletePreviewBytes,
    deleteRequiresArm: destructiveSteps.length > 0,
    archiveChoice,
    impacts: [
      {
        label: "Active Folder",
        value: formatBytesServer(activeFolderReliefBytes),
        detail:
          activeFolderReliefBytes > 0
            ? `${staleThreads.toLocaleString()} stale active thread${staleThreads === 1 ? "" : "s"} can move out first.`
            : "No active-folder move needed right now.",
        tone: activeFolderReliefBytes > 0 ? "high" : "low",
      },
      {
        label: "Logs",
        value: formatBytesServer(logBytes),
        detail:
          logWalBytes > 0 || logBytes > 1024 ** 3
            ? `Prune safely, keep the last ${logDays} days, then checkpoint WAL.`
            : "Log database pressure is low.",
        tone: logWalBytes > 128 * 1024 ** 2 || logBytes > 1024 ** 3 ? "high" : "low",
      },
      {
        label: "Locked Deletes",
        value: effectivePolicy === "safe" ? "Locked" : formatBytesServer(deletePreviewBytes),
        detail:
          effectivePolicy === "safe"
            ? "Safe mode does not delete archived history or old Refit backups."
            : destructiveSteps.length
              ? `${destructiveSteps.length.toLocaleString()} delete action${destructiveSteps.length === 1 ? "" : "s"} stay locked until you allow deletes.`
              : "No delete action is selected.",
        tone: destructiveSteps.length ? "danger" : "low",
      },
      {
        label: "Images",
        value: formatBytesServer(generatedImageBytes),
        detail:
          generatedImageBytes > 0
            ? "Generated images are move-only. Codex Refit never deletes them."
            : "No generated-image cache found.",
        tone: generatedImageBytes > 1024 ** 3 ? "medium" : "low",
      },
    ],
  };
  const diagnosis = buildSlowdownDiagnosis(scan, {
    activeFolderReliefBytes,
    deletePreviewBytes,
    nonDestructiveSteps,
    destructiveSteps,
    archiveChoice,
  });
  decision.diagnosis = diagnosis;
  return {
    days,
    archiveChoice,
    logDays,
    deleteDays,
    policy: requestedPolicy,
    effectivePolicy,
    destructive: steps.some((step) => step.confirmRequired),
    title:
      executableSteps.length > 0
        ? `${executableSteps.length} smart step${executableSteps.length === 1 ? "" : "s"} ready`
        : "Nothing urgent",
    summary:
      executableSteps.length === 0
        ? "No obvious action is waiting."
        : (nonDestructiveSteps.length ? nonDestructiveSteps : executableSteps)
            .slice(0, 3)
            .map((step) =>
              step.id === "archiveStaleThreads" && archiveChoice?.mode === "auto"
                ? `${step.label} (${archiveChoice.label})`
                : step.label,
            )
            .join(" • "),
    decision,
    diagnosis,
    steps,
  };
}

async function timedValue(fn) {
  const start = performance.now();
  const value = await fn();
  return { value, ms: Math.round(performance.now() - start) };
}

async function readLastJsonl(filePath) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    const lines = text.trim().split("\n").filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        return JSON.parse(lines[index]);
      } catch {
        continue;
      }
    }
  } catch {
    return null;
  }
  return null;
}

async function readJsonlEntries(filePath, limit = 10) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    const rows = [];
    for (const line of text.trim().split("\n").filter(Boolean).reverse()) {
      try {
        rows.push(JSON.parse(line));
        if (rows.length >= limit) break;
      } catch {
        continue;
      }
    }
    return rows;
  } catch {
    return [];
  }
}

function backupKindFromName(name) {
  if (name.includes("logs-before")) return "logs";
  if (name.includes("state-before")) return "state";
  return "bundle";
}

async function listBackupBundles(limit = 8) {
  if (!(await exists(paths.backupRoot))) return [];
  let entries = [];
  try {
    entries = await fs.readdir(paths.backupRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const bundles = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const bundlePath = assertAllowed(path.join(paths.backupRoot, entry.name));
    const stats = await statOrNull(bundlePath);
    if (!stats) continue;
    let files = [];
    try {
      files = await fs.readdir(bundlePath);
    } catch {
      files = [];
    }
    bundles.push({
      name: entry.name,
      path: bundlePath,
      kind: backupKindFromName(entry.name),
      bytes: await duBytes(bundlePath),
      fileCount: files.length,
      createdAt: stats.birthtime.toISOString(),
      modifiedAt: stats.mtime.toISOString(),
    });
  }

  bundles.sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime());
  return bundles.slice(0, limit);
}

export async function recoveryStatus() {
  const [backups, history] = await Promise.all([listBackupBundles(10), readJsonlEntries(paths.historyLog, 8)]);
  const backupBytes = backups.reduce((total, backup) => total + backup.bytes, 0);
  const stateBackups = backups.filter((backup) => backup.kind === "state").length;
  const logBackups = backups.filter((backup) => backup.kind === "logs").length;
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    backupRoot: paths.backupRoot,
    backupCount: backups.length,
    backupBytes,
    stateBackups,
    logBackups,
    latestBackup: backups[0] || null,
    backups,
    history,
  };
}

function benchmarkDeltas(current, previous) {
  if (!previous?.metrics) return null;
  if (previous.metrics.scoreModel !== current.scoreModel) return null;
  const keys = [
    "score",
    "liveScore",
    "scanMs",
    "stateQueryMs",
    "logQueryMs",
    "activeSessionBytes",
    "logBytes",
    "logWalBytes",
    "safeReclaimBytes",
    "staleActiveBytes",
    "oversizedActiveFiles",
    "staleThreads",
    "archivedFilesInSessions",
  ];
  return Object.fromEntries(keys.map((key) => [key, current[key] - (previous.metrics[key] || 0)]));
}

export async function runBenchmark() {
  const previous = await readLastJsonl(paths.benchmarkLog);
  const scanTimed = await timedValue(scanCodex);
  const stateTimed = await timedValue(getStateStats);
  const logTimed = await timedValue(async () => {
    try {
      const rows = await sqliteJson(paths.logsDb, "select count(*) as rows from logs;", 45000);
      return Number(rows[0]?.rows || 0);
    } catch {
      return null;
    }
  });
  const scan = scanTimed.value;
  const totalStateBytes =
    (scan.categories.codexHome?.bytes || 0) +
    (scan.categories.codexChromium?.bytes || 0) +
    (scan.categories.codexDesktop?.bytes || 0);
  const safeReclaimBytes =
    (scan.categories.activeStaleSessions?.bytes || 0) +
    (scan.categories.crashDumps?.bytes || 0) +
    (scan.categories.browserCaches?.bytes || 0) +
    (scan.categories.archivedSessionsInActiveTree?.bytes || 0);

  const metrics = {
    scoreModel: "local-state-v2",
    generatedAt: new Date().toISOString(),
    scanMs: scanTimed.ms,
    stateQueryMs: stateTimed.ms,
    logQueryMs: logTimed.ms,
    logRows: logTimed.value,
    totalStateBytes,
    activeSessionBytes: scan.categories.activeSessions?.bytes || 0,
    logBytes: scan.logs?.bytes || 0,
    logWalBytes: scan.logs?.walBytes || 0,
    safeReclaimBytes,
    staleActiveBytes: scan.categories.activeStaleSessions?.bytes || 0,
    oversizedActiveFiles: scan.categories.activeSessions?.oversized50mb || 0,
    staleThreads: scan.state?.threads?.activeStale ?? scan.state?.threads?.activeOlder7d ?? 0,
    archivedStillInSessions: scan.state?.threads?.archivedStillInSessions || 0,
    archivedFilesInSessions: scan.categories.archivedSessionsInActiveTree?.fileCount || 0,
    staleArchivedPointers: scan.categories.archivedSessionsInActiveTree?.missingFileCount || 0,
    archivedDeleteRows: scan.categories.archivedDeleteCandidates?.dbRowCount || 0,
    archivedDeleteBytes: scan.categories.archivedDeleteCandidates?.bytes || 0,
    archivedDeleteDays: scan.categories.archivedDeleteCandidates?.days || 30,
  };
  metrics.score = benchmarkScore(metrics);
  metrics.liveScore = benchmarkLiveScore(metrics);
  metrics.timingPenalty = Math.max(0, metrics.score - metrics.liveScore);

  const entry = {
    ok: true,
    generatedAt: metrics.generatedAt,
    rating: benchmarkRating(metrics.score),
    liveRating: benchmarkRating(metrics.liveScore),
    meaning:
      metrics.timingPenalty >= 8
        ? `${benchmarkMeaning(metrics.score)} Live timing was noisy, so this score focuses on local state.`
        : benchmarkMeaning(metrics.score),
    metrics,
    previous: previous
      ? {
          generatedAt: previous.generatedAt,
          rating: previous.rating,
          metrics: previous.metrics,
        }
      : null,
    deltas: benchmarkDeltas(metrics, previous),
    guidance: benchmarkGuidance(metrics),
  };

  await fs.mkdir(path.dirname(paths.benchmarkLog), { recursive: true });
  await fs.appendFile(paths.benchmarkLog, `${JSON.stringify(entry)}\n`, "utf8");
  return entry;
}

async function archiveStaleThreads(options = {}) {
  const days = normalizeDays(options.days, 5, { min: 1, max: 365 });
  const backup = await backupSqlite(paths.stateDb, `state-before-archive-stale-${days}d`);
  const sql = `
    PRAGMA busy_timeout = 10000;
    update threads
    set archived = 1,
        archived_at = coalesce(archived_at, strftime('%s','now'))
    where archived = 0
      and updated_at < strftime('%s','now','-${days} days');
    select changes();
  `;
  const sqliteResult = await runSqliteScript(paths.stateDb, sql);
  const { stdout } = sqliteResult;
  const changed = Number(stdout.trim().split(/\s+/).pop() || 0);
  return {
    summary: `Archived ${changed.toLocaleString()} stale thread${changed === 1 ? "" : "s"} older than ${days} day${days === 1 ? "" : "s"}.`,
    details: [...retryDetail(sqliteResult), `State backup: ${backup.backupDir}`],
  };
}

async function migrateArchivedSessions() {
  const sessionsPrefix = `${paths.sessions}/%`;
  const rows = await sqliteJson(
    paths.stateDb,
    `select id, rollout_path from threads where archived = 1 and rollout_path like ${sqlString(sessionsPrefix)};`,
  );
  if (!rows.length) {
    return { summary: "No archived transcripts were left in the active session tree.", details: [] };
  }

  const backup = await backupSqlite(paths.stateDb, "state-before-migrate-archived-sessions");
  await fs.mkdir(paths.archivedSessions, { recursive: true });
  const moved = [];
  const skipped = [];
  let retriedWrites = 0;

  for (const row of rows) {
    const source = assertAllowed(row.rollout_path);
    const stats = await statOrNull(source);
    if (!stats?.isFile()) {
      skipped.push(path.basename(source));
      continue;
    }

    let destination = path.join(paths.archivedSessions, path.basename(source));
    destination = assertAllowed(destination);
    if (await exists(destination)) {
      const parsed = path.parse(destination);
      destination = path.join(parsed.dir, `${parsed.name}-${row.id.slice(0, 8)}${parsed.ext}`);
    }

    await fs.rename(source, destination);
    try {
      const sqliteResult = await runSqliteScript(
        paths.stateDb,
        `
          PRAGMA busy_timeout = 10000;
          update threads set rollout_path = ${sqlString(destination)} where id = ${sqlString(row.id)};
        `,
      );
      if (sqliteResult.attempts > 1) retriedWrites += 1;
      moved.push({ source, destination, bytes: stats.size });
    } catch (error) {
      await fs.rename(destination, source).catch(() => {});
      throw error;
    }
  }

  const bytes = moved.reduce((total, item) => total + item.bytes, 0);
  const details = [`State backup: ${backup.backupDir}`];
  if (retriedWrites) details.unshift(`SQLite busy; retried ${retriedWrites.toLocaleString()} path update${retriedWrites === 1 ? "" : "s"}.`);
  if (skipped.length) details.push(`Skipped ${skipped.length.toLocaleString()} missing transcript files.`);
  return {
    summary: `Moved ${moved.length.toLocaleString()} archived transcript${moved.length === 1 ? "" : "s"} out of active sessions (${formatBytesServer(bytes)}).`,
    details,
  };
}

async function deleteFilesOlderThan(root, days, predicate) {
  const files = [];
  const cutoff = cutoffMs(days);
  const summary = await summarizeDirectory(root, {
    filePredicate: (filePath, stats) => {
      if (days > 0 && stats.mtimeMs > cutoff) return false;
      if (predicate && !predicate(filePath, stats)) return false;
      files.push({ filePath, bytes: stats.size });
      return true;
    },
    largestLimit: 0,
  });

  let deleted = 0;
  let bytes = 0;
  for (const file of files) {
    assertAllowed(file.filePath);
    await fs.rm(file.filePath, { force: true });
    deleted += 1;
    bytes += file.bytes;
  }
  return { deleted, bytes, scanned: summary.fileCount };
}

async function deleteCrashDumps(options = {}) {
  const days = normalizeDays(options.days, 0, { min: 0, max: 365 });
  let deleted = 0;
  let bytes = 0;

  for (const dir of crashDirs()) {
    if (!(await exists(dir))) continue;
    const result = await deleteFilesOlderThan(dir, days, (filePath) => filePath.endsWith(".dmp"));
    deleted += result.deleted;
    bytes += result.bytes;
  }

  return {
    summary: `Deleted ${deleted.toLocaleString()} crash dump${deleted === 1 ? "" : "s"} (${formatBytesServer(bytes)}).`,
    details: days ? [`Only files older than ${days} days were removed.`] : ["Removed matching crash dumps regardless of age."],
  };
}

async function cleanBrowserCaches() {
  let cleaned = 0;
  let bytes = 0;
  const errors = [];

  for (const dir of cacheDirs()) {
    if (!(await exists(dir))) continue;
    assertAllowed(dir);
    const before = await duBytes(dir);
    let entries = [];
    try {
      entries = await fs.readdir(dir);
    } catch (error) {
      errors.push(`${dir}: ${error.message}`);
      continue;
    }

    for (const entry of entries) {
      const child = assertAllowed(path.join(dir, entry));
      try {
        await fs.rm(child, { recursive: true, force: true });
      } catch (error) {
        errors.push(`${child}: ${error.message}`);
      }
    }
    cleaned += 1;
    bytes += before;
  }

  const details = errors.length ? [`${errors.length.toLocaleString()} cache item error${errors.length === 1 ? "" : "s"}.`] : [];
  return {
    summary: `Cleared ${cleaned.toLocaleString()} browser cache director${cleaned === 1 ? "y" : "ies"} (${formatBytesServer(bytes)} before clearing).`,
    details,
  };
}

async function deleteOldChildren(root, days, confirmValue) {
  if (confirmValue !== "DELETE") throw new Error("Deletes are off. Allow deletes before running this action.");
  if (!(await exists(root))) return { deleted: 0, bytes: 0 };

  const cutoff = cutoffMs(days);
  const entries = await fs.readdir(root, { withFileTypes: true });
  let deleted = 0;
  let bytes = 0;

  for (const entry of entries) {
    const child = assertAllowed(path.join(root, entry.name));
    const stats = await statOrNull(child);
    if (!stats) continue;
    if (days > 0 && stats.mtimeMs > cutoff) continue;
    const before = await duBytes(child);
    await fs.rm(child, { recursive: true, force: true });
    deleted += 1;
    bytes += before;
  }

  return { deleted, bytes };
}

async function deleteMaintenanceArchives(options = {}) {
  const days = normalizeDays(options.days, 14, { min: 0, max: 3650 });
  const result = await deleteOldChildren(paths.maintenanceArchive, days, options.confirm);
  return {
    summary: `Deleted ${result.deleted.toLocaleString()} old Refit backup item${result.deleted === 1 ? "" : "s"} (${formatBytesServer(result.bytes)}).`,
    details: days ? [`Cutoff: older than ${days} days.`] : ["Cutoff: all old Refit backup items."],
  };
}

async function uniqueDestination(parentDir, name) {
  const parsed = path.parse(name);
  let destination = assertAllowed(path.join(parentDir, name));
  let counter = 1;
  while (await exists(destination)) {
    const suffix = `-${String(counter).padStart(2, "0")}`;
    destination = assertAllowed(path.join(parentDir, `${parsed.name}${suffix}${parsed.ext}`));
    counter += 1;
  }
  return destination;
}

async function archiveGeneratedImages(options = {}) {
  const days = normalizeDays(options.days, 14, { min: 1, max: 3650 });
  if (!(await exists(paths.generatedImages))) {
    return { summary: "No generated images folder was found.", details: [] };
  }

  await fs.mkdir(paths.generatedImagesArchive, { recursive: true });
  const cutoff = cutoffMs(days);
  const entries = await fs.readdir(paths.generatedImages, { withFileTypes: true });
  const moved = [];

  for (const entry of entries) {
    const source = assertAllowed(path.join(paths.generatedImages, entry.name));
    const stats = await statOrNull(source);
    if (!stats) continue;
    if (stats.mtimeMs > cutoff) continue;
    const bytes = await duBytes(source);
    const destination = await uniqueDestination(paths.generatedImagesArchive, entry.name);
    await fs.rename(source, destination);
    moved.push({ source, destination, bytes });
  }

  const bytes = moved.reduce((total, item) => total + item.bytes, 0);
  return {
    summary: `Moved ${moved.length.toLocaleString()} generated image item${moved.length === 1 ? "" : "s"} to archived_generated_images (${formatBytesServer(bytes)}).`,
    details: [
      `Cutoff: older than ${days} days.`,
      "Generated images are never deleted by Codex Refit.",
      moved.length ? `Moved-to folder: ${paths.generatedImagesArchive}` : "No generated image items were old enough to move.",
    ],
  };
}

async function deleteArchivedTranscripts(options = {}) {
  if (options.confirm !== "DELETE") throw new Error("Deletes are off. Allow deletes before running this action.");
  const days = normalizeDays(options.days, 30, { min: 1, max: 3650 });
  const cutoffSeconds = Math.floor(Date.now() / 1000) - days * 24 * 60 * 60;
  const rows = await sqliteJson(
    paths.stateDb,
    `
      select id, rollout_path
      from threads
      where archived = 1
        and coalesce(archived_at, updated_at) < ${cutoffSeconds}
        and (rollout_path like ${sqlString(`${paths.archivedSessions}/%`)}
          or rollout_path like ${sqlString(`${paths.sessions}/%`)});
    `,
  );

  if (!rows.length) {
    return { summary: `No transcripts archived longer than ${days} days matched.`, details: [] };
  }

  const backup = await backupSqlite(paths.stateDb, `state-before-delete-archived-${days}d`);
  let deletedFiles = 0;
  let bytes = 0;
  const ids = [];

  for (const row of rows) {
    ids.push(row.id);
    const filePath = row.rollout_path;
    if (!filePath) continue;
    const resolved = assertAllowed(filePath);
    const stats = await statOrNull(resolved);
    if (!stats?.isFile()) continue;
    await fs.rm(resolved, { force: true });
    deletedFiles += 1;
    bytes += stats.size;
  }

  const values = ids.map((id) => `(${sqlString(id)})`).join(",");
  const sqliteResult = await runSqliteScript(
    paths.stateDb,
    `
      PRAGMA busy_timeout = 10000;
      BEGIN;
      CREATE TEMP TABLE speed_dock_delete_threads(id TEXT PRIMARY KEY);
      INSERT INTO speed_dock_delete_threads(id) VALUES ${values};
      DELETE FROM thread_dynamic_tools WHERE thread_id IN (SELECT id FROM speed_dock_delete_threads);
      DELETE FROM thread_spawn_edges
        WHERE parent_thread_id IN (SELECT id FROM speed_dock_delete_threads)
           OR child_thread_id IN (SELECT id FROM speed_dock_delete_threads);
      DELETE FROM threads WHERE id IN (SELECT id FROM speed_dock_delete_threads) AND archived = 1;
      COMMIT;
    `,
  );

  return {
    summary: `Deleted ${deletedFiles.toLocaleString()} archived transcript file${deletedFiles === 1 ? "" : "s"} and ${ids.length.toLocaleString()} archived thread row${ids.length === 1 ? "" : "s"} archived longer than ${days} days (${formatBytesServer(bytes)}).`,
    details: [...retryDetail(sqliteResult), `Age basis: archived_at, falling back to updated_at.`, `State backup: ${backup.backupDir}`],
  };
}

async function pruneLogs(options = {}) {
  const days = normalizeDays(options.days, 7, { min: 1, max: 365 });
  const details = [];
  if (options.backup) {
    const backup = await backupSqlite(paths.logsDb, `logs-before-prune-${days}d`);
    details.push(`Log backup: ${backup.backupDir}`);
  } else {
    details.push("Log backup skipped.");
  }

  const cutoffSeconds = Math.floor(Date.now() / 1000) - days * 24 * 60 * 60;
  const before = await duBytes(paths.logsDb) + (await duBytes(`${paths.logsDb}-wal`));
  const sqliteResult = await runSqliteScript(
    paths.logsDb,
    `
      PRAGMA busy_timeout = 15000;
      DELETE FROM logs WHERE ts < ${cutoffSeconds};
      SELECT changes();
      PRAGMA wal_checkpoint(TRUNCATE);
      VACUUM;
      PRAGMA optimize;
    `,
    180000,
  );
  const { stdout } = sqliteResult;
  const changed = Number(stdout.trim().split(/\s+/)[0] || 0);
  const after = await duBytes(paths.logsDb) + (await duBytes(`${paths.logsDb}-wal`));

  return {
    summary: `Pruned ${changed.toLocaleString()} log row${changed === 1 ? "" : "s"} older than ${days} days. Size changed from ${formatBytesServer(before)} to ${formatBytesServer(after)}.`,
    details: [...retryDetail(sqliteResult), ...details],
  };
}

async function vacuumState() {
  const backup = await backupSqlite(paths.stateDb, "state-before-vacuum");
  const before = await duBytes(paths.stateDb) + (await duBytes(`${paths.stateDb}-wal`));
  const sqliteResult = await runSqliteScript(
    paths.stateDb,
    `
      PRAGMA busy_timeout = 10000;
      PRAGMA wal_checkpoint(TRUNCATE);
      VACUUM;
      PRAGMA optimize;
    `,
    120000,
  );
  const after = await duBytes(paths.stateDb) + (await duBytes(`${paths.stateDb}-wal`));
  return {
    summary: `Optimized state database. Size changed from ${formatBytesServer(before)} to ${formatBytesServer(after)}.`,
    details: [...retryDetail(sqliteResult), `State backup: ${backup.backupDir}`],
  };
}

async function safeSweep(options = {}) {
  const requestedDays = wantsAutoArchiveDays(options.days) ? "auto" : normalizeDays(options.days, 5, { min: 1, max: 90 });
  const logDays = normalizeDays(options.logDays, 7, { min: 1, max: 365 });
  const policy = normalizePolicy(options.policy);
  const deleteDays = normalizeDays(options.deleteDays, policy === "max" ? 14 : 30, { min: 1, max: 3650 });
  const beforeScan = await scanCodex({ policy, days: requestedDays, logDays, deleteDays });
  const plan = beforeScan.smartPlan || buildSmartPlan(beforeScan, { days: beforeScan.archiveChoice?.days || requestedDays, logDays, policy, deleteDays });
  const days = plan.days;
  const results = [];
  const skippedLocked = [];

  for (const step of plan.steps) {
    if (step.disabled) continue;
    if (step.id === "speedCheck") continue;
    if (step.confirmRequired && options.confirm !== "DELETE") {
      skippedLocked.push(step);
      continue;
    }
    if (step.id === "archiveStaleThreads") results.push(await archiveStaleThreads({ days }));
    if (step.id === "migrateArchivedSessions") results.push(await migrateArchivedSessions());
    if (step.id === "vacuumState") results.push(await vacuumState());
    if (step.id === "pruneLogs") results.push(await pruneLogs({ days: step.logDays || logDays, backup: true }));
    if (step.id === "deleteArchivedTranscripts") {
      results.push(await deleteArchivedTranscripts({ days: step.deleteDays || deleteDays, confirm: options.confirm }));
    }
    if (step.id === "deleteMaintenanceArchives") {
      results.push(await deleteMaintenanceArchives({ days: step.deleteDays ?? 14, confirm: options.confirm }));
    }
    if (step.id === "archiveGeneratedImages") results.push(await archiveGeneratedImages({ days: step.days || Math.max(deleteDays, 14) }));
    if (step.id === "deleteCrashDumps") results.push(await deleteCrashDumps({ days: 0 }));
    if (step.id === "cleanBrowserCaches") results.push(await cleanBrowserCaches());
  }

  if (!results.length) {
    return {
      summary: skippedLocked.length
        ? "Smart Optimize only found locked delete actions. Allow deletes only if those old archived items can be removed."
        : "Smart Optimize found no safe actions to run.",
      details: skippedLocked.length
        ? skippedLocked.map((step) => `Kept locked delete action off: ${step.label}. ${step.reason}`)
        : ["Run Speed Check to verify the current readiness score."],
      plan,
    };
  }

  const afterScan = await scanCodex({ policy, days: requestedDays, logDays, deleteDays });
  const outcome = buildRefitOutcome(beforeScan, afterScan, { results, skippedLocked });
  return {
    summary: `Smart Optimize ran ${results.length.toLocaleString()} action${results.length === 1 ? "" : "s"}${skippedLocked.length ? ` and skipped ${skippedLocked.length.toLocaleString()} locked delete action${skippedLocked.length === 1 ? "" : "s"}` : ""}: ${results.map((result) => result.summary).join(" ")}`,
    details: [
      ...plan.steps
        .filter((step) => step.id !== "speedCheck")
        .map((step) => `Chose ${step.label}: ${step.reason}`),
      plan.archiveChoice?.reason ? `Archive cutoff: ${plan.archiveChoice.reason}` : null,
      ...skippedLocked.map((step) => `Kept locked delete action off: ${step.label}. Allow deletes to run it.`),
      ...results.flatMap((result) => result.details || []),
    ].filter(Boolean),
    plan,
    outcome,
  };
}

export async function runAction(action, options) {
  if (actionInProgress) throw new Error("Codex Refit is already running an action.");
  const actions = {
    archiveStaleThreads,
    migrateArchivedSessions,
    deleteArchivedTranscripts,
    pruneLogs,
    vacuumState,
    deleteCrashDumps,
    cleanBrowserCaches,
    deleteMaintenanceArchives,
    archiveGeneratedImages,
    safeSweep,
  };

  if (!actions[action]) throw new Error(`Unknown action: ${action}`);
  actionInProgress = true;
  try {
    const result = await actions[action](options || {});
    await appendHistory(action, result);
    return { ok: true, ...result };
  } finally {
    actionInProgress = false;
  }
}

async function readJsonBody(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1024 * 1024) throw new Error("Request body too large.");
  }
  return body ? JSON.parse(body) : {};
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function serveStatic(req, res, url) {
  const requested = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  const relative = requested.replace(/^\/+/, "");
  const filePath = path.resolve(path.join(rootDir, relative));
  if (filePath !== rootDir && !filePath.startsWith(`${rootDir}${path.sep}`)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  const stats = await statOrNull(filePath);
  if (!stats?.isFile()) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const data = await fs.readFile(filePath);
  res.writeHead(200, {
    "Content-Type": contentTypes[ext] || "application/octet-stream",
    "Content-Length": data.length,
  });
  res.end(data);
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);

  try {
    if (req.method === "GET" && url.pathname === "/api/health") {
      sendJson(res, 200, { ok: true, paths });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/scan") {
      sendJson(
        res,
        200,
        await scanCodex({
          policy: url.searchParams.get("policy"),
          days: url.searchParams.get("days"),
          logDays: url.searchParams.get("logDays"),
          deleteDays: url.searchParams.get("deleteDays"),
        }),
      );
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/benchmark") {
      sendJson(res, 200, await runBenchmark());
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/recovery") {
      sendJson(res, 200, await recoveryStatus());
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/action") {
      const body = await readJsonBody(req);
      sendJson(res, 200, await runAction(body.action, body.options || {}));
      return;
    }

    if (req.method === "GET" || req.method === "HEAD") {
      await serveStatic(req, res, url);
      return;
    }

    sendJson(res, 405, { ok: false, error: "Method not allowed" });
  } catch (error) {
    sendJson(res, 500, { ok: false, error: error.message });
  }
}

export function createAppServer() {
  return createServer(handleRequest);
}

export async function startServer({ port = Number(process.env.PORT || 5173), host = "127.0.0.1" } = {}) {
  for (let nextPort = port; nextPort < port + 40; nextPort += 1) {
    const server = createAppServer();
    try {
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };

        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(nextPort, host);
      });

      return {
        server,
        host,
        port: nextPort,
        url: `http://${host}:${nextPort}`,
      };
    } catch (error) {
      if (error.code !== "EADDRINUSE") throw error;
    }
  }

  throw new Error(`No available port found starting at ${port}.`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  try {
    const { url } = await startServer();
    console.log(`Codex Refit running at ${url}`);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}
