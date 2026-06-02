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
const codexAppCli = "/Applications/Codex.app/Contents/Resources/codex";

const paths = {
  codexHome,
  sessions: path.join(codexHome, "sessions"),
  archivedSessions: path.join(codexHome, "archived_sessions"),
  maintenanceArchive: path.join(codexHome, "maintenance-archive"),
  generatedImages: path.join(codexHome, "generated_images"),
  generatedImagesArchive: path.join(codexHome, "archived_generated_images"),
  configToml: path.join(codexHome, "config.toml"),
  authJson: path.join(codexHome, "auth.json"),
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

function configNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
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

function unquoteTomlTablePath(value) {
  return String(value || "").replaceAll('\\"', '"').replaceAll("\\\\", "\\");
}

function extractTrustedProjectPaths(sections, values) {
  return sections
    .map((section) => {
      const match = section.match(/^projects\."(.+)"$/);
      if (!match || values[`${section}.trust_level`] !== "trusted") return null;
      return unquoteTomlTablePath(match[1]);
    })
    .filter(Boolean);
}

async function getCodexProfileSummaries() {
  const empty = {
    profileCount: 0,
    profileSummaries: [],
    hasFastTaskProfile: false,
    fastTaskProfileNames: [],
    hasSparkProfile: false,
    sparkProfileNames: [],
    hasMiniProfile: false,
    miniProfileNames: [],
    hasDeepWorkProfile: false,
    deepWorkProfileNames: [],
  };

  try {
    const dirents = await fs.readdir(paths.codexHome, { withFileTypes: true });
    const profileFiles = dirents
      .filter((dirent) => dirent.isFile() && /^[A-Za-z0-9_-]+\.config\.toml$/.test(dirent.name))
      .map((dirent) => dirent.name)
      .sort((a, b) => a.localeCompare(b));

    const profileSummaries = (
      await Promise.all(
        profileFiles.map(async (fileName) => {
          const profilePath = path.join(paths.codexHome, fileName);
          const name = fileName.slice(0, -".config.toml".length);

          try {
            const text = await fs.readFile(profilePath, "utf8");
            const { values } = parseTomlSummary(text);
            const model = values.model ? String(values.model) : null;
            const reasoningEffort = values.model_reasoning_effort || values.reasoning_effort || null;
            const serviceTier = values.service_tier || null;
            const verbosity = values.model_verbosity || null;
            const normalizedName = name.toLowerCase();
            const normalizedModel = String(model || "").toLowerCase();
            const normalizedEffort = String(reasoningEffort || "").toLowerCase().replaceAll("_", "-");
            const isHighEffort = ["high", "xhigh", "extra-high"].includes(normalizedEffort);
            const isLowEffort = ["low", "minimal", "none"].includes(normalizedEffort);
            const nameLooksFast = /fast|speed|quick|small|mini|spark|light|lite/.test(normalizedName);
            const nameLooksDeep = /deep|review|xhigh|heavy/.test(normalizedName);
            const mini = normalizedModel.includes("mini");
            const spark = normalizedModel.includes("spark");
            const fastMode = serviceTier === "fast" && values["features.fast_mode"] !== false;
            const fastTask = spark || mini || fastMode || (nameLooksFast && !isHighEffort) || (isLowEffort && !nameLooksDeep);
            const deepWork = nameLooksDeep || (normalizedModel === "gpt-5.5" && isHighEffort);

            return {
              name,
              path: profilePath,
              model,
              reasoningEffort,
              serviceTier,
              verbosity,
              fastTask,
              deepWork,
              spark,
              mini,
            };
          } catch (error) {
            return {
              name,
              path: profilePath,
              error: error.message,
              fastTask: false,
              deepWork: false,
              spark: false,
              mini: false,
            };
          }
        }),
      )
    ).filter(Boolean);

    return {
      profileCount: profileSummaries.length,
      profileSummaries,
      hasFastTaskProfile: profileSummaries.some((profile) => profile.fastTask),
      fastTaskProfileNames: profileSummaries.filter((profile) => profile.fastTask).map((profile) => profile.name),
      hasSparkProfile: profileSummaries.some((profile) => profile.spark),
      sparkProfileNames: profileSummaries.filter((profile) => profile.spark).map((profile) => profile.name),
      hasMiniProfile: profileSummaries.some((profile) => profile.mini),
      miniProfileNames: profileSummaries.filter((profile) => profile.mini).map((profile) => profile.name),
      hasDeepWorkProfile: profileSummaries.some((profile) => profile.deepWork),
      deepWorkProfileNames: profileSummaries.filter((profile) => profile.deepWork).map((profile) => profile.name),
    };
  } catch {
    return empty;
  }
}

function isTopLevelMcpSection(section) {
  if (!section.startsWith("mcp_servers.")) return false;
  const name = section.slice("mcp_servers.".length);
  return Boolean(name && !name.includes("."));
}

function readFirstLine(value) {
  return String(value || "").trim().split(/\r?\n/).find(Boolean) || null;
}

function normalizeCodexVersion(value) {
  const line = readFirstLine(value);
  const match = line?.match(/\b(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)\b/);
  return match?.[1] || line || null;
}

async function execVersion(command, args = []) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      timeout: 2500,
      maxBuffer: 128 * 1024,
    });
    return {
      ok: true,
      raw: readFirstLine(stdout) || readFirstLine(stderr),
      version: normalizeCodexVersion(stdout || stderr),
    };
  } catch (error) {
    return {
      ok: false,
      error: error.message,
      raw: readFirstLine(error.stdout) || readFirstLine(error.stderr),
      version: normalizeCodexVersion(error.stdout || error.stderr),
    };
  }
}

async function whichCommand(command) {
  try {
    const { stdout } = await execFileAsync("which", [command], {
      timeout: 1500,
      maxBuffer: 32 * 1024,
    });
    return readFirstLine(stdout);
  } catch {
    return null;
  }
}

async function getCodexRuntimeSummary() {
  const cliPath = await whichCommand("codex");
  const appCliExists = await exists(codexAppCli);
  const [cliResult, appResult] = await Promise.all([
    cliPath ? execVersion(cliPath, ["--version"]) : Promise.resolve(null),
    appCliExists ? execVersion(codexAppCli, ["--version"]) : Promise.resolve(null),
  ]);
  const cliVersion = cliResult?.version || null;
  const appVersion = appResult?.version || null;
  const versionMismatch = Boolean(cliVersion && appVersion && cliVersion !== appVersion);

  return {
    cliPath,
    cliVersion,
    cliRaw: cliResult?.raw || null,
    cliError: cliResult?.ok === false ? cliResult.error : null,
    appCliPath: appCliExists ? codexAppCli : null,
    appVersion,
    appRaw: appResult?.raw || null,
    appError: appResult?.ok === false ? appResult.error : null,
    versionMismatch,
    status: versionMismatch ? "mismatch" : cliVersion || appVersion ? "ready" : "missing",
  };
}

function parsePsElapsedSeconds(value) {
  const raw = String(value || "").trim();
  if (!raw) return 0;
  const [dayText, clockText] = raw.includes("-") ? raw.split("-", 2) : ["0", raw];
  const days = Number(dayText) || 0;
  const parts = clockText.split(":").map((part) => Number(part));
  if (parts.some((part) => !Number.isFinite(part))) return days * 86400;
  if (parts.length === 3) return days * 86400 + parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return days * 86400 + parts[0] * 60 + parts[1];
  if (parts.length === 1) return days * 86400 + parts[0];
  return days * 86400;
}

function formatAgeServer(seconds) {
  const safeSeconds = Math.max(0, Number(seconds) || 0);
  const days = Math.floor(safeSeconds / 86400);
  const hours = Math.floor((safeSeconds % 86400) / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m`;
  return `${Math.floor(safeSeconds)}s`;
}

function codexProcessKind(command) {
  const text = String(command || "");
  if (!text) return null;
  if (text.includes("Codex Refit.app") || text.includes("codex-refit")) return "refit";
  if (text.includes("crashpad_handler")) return "crashpad";
  if (text.includes("node_repl")) return "nodeRepl";
  if (text.includes("/kernel.js")) return "kernel";
  if (text.includes("app-server --analytics-default-enabled")) return "backgroundServer";
  if (text.includes("app-server --listen")) return "threadServer";
  if (text.includes("codex doctor")) return "doctor";
  if (text.includes("Codex (Renderer)")) return "renderer";
  if (text.includes("Codex (Service)")) return "service";
  if (text.includes("/Applications/Codex.app/Contents/MacOS/Codex")) return "app";
  if (text.includes("@openai/codex") || text.includes("/codex ") || /\bcodex\b/i.test(text)) return "cli";
  return null;
}

function codexProcessLabel(kind) {
  return {
    app: "Codex app",
    renderer: "Codex renderer",
    service: "Codex service",
    backgroundServer: "background app server",
    threadServer: "thread app server",
    nodeRepl: "Node REPL tool",
    kernel: "tool kernel",
    doctor: "Doctor check",
    cli: "Codex CLI",
    crashpad: "crash reporter",
    refit: "Codex Refit",
  }[kind] || "Codex helper";
}

function buildProcessLoadSnippet() {
  return [
    "# Read-only Codex load check. Counts processes and memory without printing auth contents.",
    "ps -axo rss=,command= | awk '/Codex.app|codex app-server|node_repl|@openai\\/codex/ && !/Codex Refit/ {count++; rss+=$1} END {printf \"%d Codex processes, %.1f MB RSS\\n\", count, rss/1024}'",
    "",
    "# Then finish or archive idle Codex threads, close extra terminals, and restart Codex after active runs are done.",
    "codex doctor --summary",
  ].join("\n");
}

async function getCodexProcessSummary() {
  try {
    const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,rss=,etime=,command="], {
      timeout: 3000,
      maxBuffer: 2 * 1024 * 1024,
    });
    const processes = String(stdout || "")
      .split(/\r?\n/)
      .map((line) => {
        const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
        if (!match) return null;
        const command = match[5];
        const kind = codexProcessKind(command);
        if (!kind) return null;
        return {
          pid: Number(match[1]),
          ppid: Number(match[2]),
          kind,
          label: codexProcessLabel(kind),
          rssBytes: (Number(match[3]) || 0) * 1024,
          ageSeconds: parsePsElapsedSeconds(match[4]),
        };
      })
      .filter(Boolean);

    const pressureProcesses = processes.filter((processInfo) => !["refit", "crashpad"].includes(processInfo.kind));
    const countByKind = pressureProcesses.reduce((counts, processInfo) => {
      counts[processInfo.kind] = (counts[processInfo.kind] || 0) + 1;
      return counts;
    }, {});
    const rssBytes = pressureProcesses.reduce((total, processInfo) => total + processInfo.rssBytes, 0);
    const helperCount =
      (countByKind.threadServer || 0) +
      (countByKind.nodeRepl || 0) +
      (countByKind.kernel || 0) +
      (countByKind.backgroundServer || 0);
    const appServerCount = (countByKind.threadServer || 0) + (countByKind.backgroundServer || 0);
    const longestAgeSeconds = pressureProcesses.reduce((max, processInfo) => Math.max(max, processInfo.ageSeconds || 0), 0);
    const largest = [...pressureProcesses]
      .sort((a, b) => b.rssBytes - a.rssBytes)
      .slice(0, 4)
      .map((processInfo) => ({
        kind: processInfo.kind,
        label: processInfo.label,
        rssBytes: processInfo.rssBytes,
        ageSeconds: processInfo.ageSeconds,
      }));

    const highLoad = pressureProcesses.length >= 24 || helperCount >= 18 || rssBytes >= 6 * 1024 ** 3;
    const mediumLoad = pressureProcesses.length >= 12 || helperCount >= 8 || rssBytes >= 2 * 1024 ** 3;
    const tone = highLoad ? "high" : mediumLoad ? "medium" : "low";
    const detail =
      pressureProcesses.length === 0
        ? "No live Codex app or CLI processes were found."
        : tone === "high"
          ? `Refit sees ${pressureProcesses.length.toLocaleString()} live Codex processes using ${formatBytesServer(rssBytes)}. Many helper processes usually means finished threads, terminals, or tool kernels are still open.`
          : tone === "medium"
            ? `Refit sees ${pressureProcesses.length.toLocaleString()} live Codex processes using ${formatBytesServer(rssBytes)}. Close idle work before judging database cleanup.`
            : `Refit sees ${pressureProcesses.length.toLocaleString()} live Codex process${pressureProcesses.length === 1 ? "" : "es"} using ${formatBytesServer(rssBytes)}. Live process load looks reasonable.`;

    return {
      status: "ready",
      tone,
      label: tone === "high" ? "Heavy" : tone === "medium" ? "Loaded" : "Steady",
      processCount: pressureProcesses.length,
      observedCount: processes.length,
      helperCount,
      appServerCount,
      nodeReplCount: countByKind.nodeRepl || 0,
      kernelCount: countByKind.kernel || 0,
      threadServerCount: countByKind.threadServer || 0,
      refitCount: processes.filter((processInfo) => processInfo.kind === "refit").length,
      rssBytes,
      longestAgeSeconds,
      longestAgeLabel: longestAgeSeconds ? formatAgeServer(longestAgeSeconds) : "None",
      detail,
      action: tone === "low" ? "Keep current" : tone === "medium" ? "Close idle threads" : "Restart after active work",
      largest,
      counts: countByKind,
    };
  } catch (error) {
    return {
      status: "unavailable",
      tone: "medium",
      label: "Unknown",
      processCount: 0,
      observedCount: 0,
      helperCount: 0,
      appServerCount: 0,
      nodeReplCount: 0,
      kernelCount: 0,
      threadServerCount: 0,
      refitCount: 0,
      rssBytes: 0,
      longestAgeSeconds: 0,
      longestAgeLabel: "Unknown",
      detail: `Refit could not read live process load: ${error.message}`,
      action: "Run ps manually",
      largest: [],
      counts: {},
    };
  }
}

function parseDoctorGeneratedAt(value) {
  if (!value) return null;
  const raw = String(value);
  const secondsMatch = raw.match(/^(\d+)s since unix epoch$/);
  if (secondsMatch) return new Date(Number(secondsMatch[1]) * 1000).toISOString();
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function doctorTone(status) {
  if (status === "fail" || status === "error") return "high";
  if (status === "warning" || status === "warn") return "medium";
  return "low";
}

function doctorStatusLabel(status) {
  return {
    ok: "OK",
    idle: "Idle",
    warning: "Warning",
    warn: "Warning",
    fail: "Fail",
    error: "Error",
  }[status] || String(status || "Unknown");
}

function parseDoctorRolloutDetails(value) {
  const text = String(value || "");
  const match = text.match(/(\d+)\s+files,\s+(\d+)\s+total bytes/i);
  if (!match) return null;
  return { files: Number(match[1]), bytes: Number(match[2]) };
}

function buildOfficialDoctorFixes(findings, report) {
  const byId = new Map((findings || []).map((finding) => [finding.id, finding]));
  const fixes = [];
  const addFix = (fix) => {
    if (!fix?.id || fixes.some((existing) => existing.id === fix.id)) return;
    fixes.push(fix);
  };

  if (byId.has("terminal.env")) {
    addFix({
      id: "official-terminal-env",
      label: "Terminal Env",
      value: "TERM",
      tone: "medium",
      action: "Copy shell check",
      detail: "Codex Doctor reports TERM=dumb. This shell-only check does not edit profile files.",
      snippet: [
        "# Check terminal settings without printing secrets.",
        'printf "TERM=%s\\nNO_COLOR=%s\\n" "${TERM:-unset}" "${NO_COLOR:-unset}"',
        "",
        "# For this terminal only:",
        "export TERM=xterm-256color",
        "unset NO_COLOR",
        "codex doctor --summary",
      ].join("\n"),
    });
  }

  if (byId.has("auth.mixed-mode")) {
    addFix({
      id: "official-auth-mode",
      label: "Auth Mode",
      value: "Mixed",
      tone: "medium",
      action: "Copy safe unset",
      detail: "Use either ChatGPT login or API-key mode intentionally. This snippet never prints the key.",
      snippet: [
        "# For ChatGPT login mode in this terminal only. Do not print OPENAI_API_KEY.",
        "unset OPENAI_API_KEY",
        "codex doctor --summary",
        "",
        "# If that fixes repeated prompts or reachability confusion, remove OPENAI_API_KEY",
        "# from the shell/profile/launcher that starts Codex, after confirming you do not need API-key mode.",
      ].join("\n"),
    });
  }

  if (byId.has("updates.available")) {
    const updateAction = report?.checks?.["updates.status"]?.details?.["update action"] || "npm install -g @openai/codex";
    addFix({
      id: "official-update-cli",
      label: "CLI Update",
      value: report?.checks?.["updates.status"]?.details?.["latest version"] || "Newer",
      tone: "medium",
      action: "Copy update",
      detail: "Aligning the CLI with the newer Codex build removes version drift from the speed investigation.",
      snippet: [
        "# Update terminal Codex, then compare both versions.",
        updateAction,
        "codex --version",
        "/Applications/Codex.app/Contents/Resources/codex --version",
        "codex doctor --summary",
      ].join("\n"),
    });
  }

  if (byId.has("mcp.config")) {
    addFix({
      id: "official-mcp-config",
      label: "MCP Config",
      value: "Inspect",
      tone: "medium",
      action: "Copy MCP check",
      detail: "Show only the redacted MCP Doctor fields, then disable or repair the affected optional server.",
      snippet: [
        "# Print only Codex Doctor's redacted MCP summary.",
        "codex doctor --json | node -e 'let s=\"\"; process.stdin.on(\"data\", d => s += d); process.stdin.on(\"end\", () => { const c = JSON.parse(s).checks[\"mcp.config\"]; console.log(c.summary); console.log(c.remediation || \"No remediation\"); console.log(Object.entries(c.details || {}).map(([k,v]) => `${k}: ${v}`).join(\"\\n\")); });'",
        "",
        "# Then edit ~/.codex/config.toml: set the missing env vars or disable that optional MCP server.",
      ].join("\n"),
    });
  }

  if (byId.has("state.active-rollouts")) {
    addFix({
      id: "official-active-rollouts",
      label: "Active Weight",
      value: "Refit",
      tone: "medium",
      action: "Run Smart Optimize",
      detail: "Use Codex Refit's non-delete cleanup first, then rerun Doctor and Speed Check.",
      snippet: [
        "# In Codex Refit, run Smart Optimize first.",
        "# Then prove the change:",
        "codex doctor --summary",
        "# Back in Codex Refit, run Speed Check.",
      ].join("\n"),
    });
  }

  return fixes.slice(0, 5);
}

function buildOfficialDoctorSummary(report, meta = {}) {
  const checks = Object.values(report?.checks || {});
  const counts = checks.reduce(
    (summary, check) => {
      const status = check.status || "unknown";
      summary.total += 1;
      summary[status] = (summary[status] || 0) + 1;
      return summary;
    },
    { total: 0, ok: 0, warning: 0, fail: 0, idle: 0, unknown: 0 },
  );

  const findings = checks
    .filter((check) => ["fail", "warning", "error"].includes(check.status))
    .map((check) => ({
      id: check.id,
      category: check.category || check.id,
      status: check.status,
      tone: doctorTone(check.status),
      label: check.category || check.id,
      value: doctorStatusLabel(check.status),
      summary: check.summary || "Codex Doctor found an issue.",
      remediation: check.remediation || null,
      durationMs: check.durationMs || 0,
      source: "official",
    }));

  const authDetails = report?.checks?.["auth.credentials"]?.details || {};
  const reachabilityDetails = report?.checks?.["network.provider_reachability"]?.details || {};
  if (
    String(authDetails["auth env vars present"] || "").includes("OPENAI_API_KEY") &&
    String(authDetails["stored ChatGPT tokens"] || "") === "true"
  ) {
    findings.push({
      id: "auth.mixed-mode",
      category: "auth",
      status: "warning",
      tone: "medium",
      label: "auth",
      value: "Mixed signals",
      summary: `ChatGPT login and OPENAI_API_KEY are both present; reachability is using ${reachabilityDetails["reachability mode"] || "the active provider mode"}.`,
      remediation: "Unset OPENAI_API_KEY for ChatGPT-token runs, or use API-key mode intentionally.",
      source: "derived",
    });
  }

  const updatesDetails = report?.checks?.["updates.status"]?.details || {};
  if (String(updatesDetails["latest version status"] || "").includes("newer")) {
    findings.push({
      id: "updates.available",
      category: "updates",
      status: "warning",
      tone: "medium",
      label: "updates",
      value: "Newer CLI",
      summary: `Codex ${updatesDetails["latest version"]} is available; current doctor version is ${report?.codexVersion || "unknown"}.`,
      remediation: updatesDetails["update action"] || "Update Codex with the documented installer for your setup.",
      source: "derived",
    });
  }

  const stateDetails = report?.checks?.["state.paths"]?.details || {};
  const activeRollouts = parseDoctorRolloutDetails(stateDetails["active rollout files"]);
  if (activeRollouts?.bytes > 5 * 1024 ** 3 || activeRollouts?.files > 50) {
    findings.push({
      id: "state.active-rollouts",
      category: "state",
      status: "warning",
      tone: "medium",
      label: "rollouts",
      value: formatBytesServer(activeRollouts.bytes),
      summary: `${activeRollouts.files.toLocaleString()} active rollout files are using ${formatBytesServer(activeRollouts.bytes)}.`,
      remediation: "Run Smart Optimize to move stale active sessions out of active history, then run Speed Check again.",
      source: "derived",
    });
  }

  const sortedFindings = findings
    .sort((a, b) => {
      const rank = { high: 3, medium: 2, low: 1 };
      return (rank[b.tone] || 0) - (rank[a.tone] || 0);
    })
    .slice(0, 8);
  const fixes = buildOfficialDoctorFixes(sortedFindings, report);

  return {
    status: report?.overallStatus || meta.status || "unknown",
    tone: doctorTone(report?.overallStatus || meta.status),
    codexVersion: report?.codexVersion || null,
    generatedAt: parseDoctorGeneratedAt(report?.generatedAt) || new Date().toISOString(),
    command: meta.command || "codex doctor --json",
    exitCode: meta.exitCode ?? null,
    durationMs: meta.durationMs || 0,
    counts,
    findings: sortedFindings,
    fixes,
    headline: sortedFindings.length
      ? `${sortedFindings.length.toLocaleString()} Doctor finding${sortedFindings.length === 1 ? "" : "s"} need attention.`
      : "Official Codex Doctor did not find blocking issues.",
  };
}

async function runOfficialDoctor() {
  const cliPath = (await whichCommand("codex")) || ((await exists(codexAppCli)) ? codexAppCli : null);
  if (!cliPath) throw new Error("No Codex CLI was found on PATH or in /Applications/Codex.app.");

  const startedAt = performance.now();
  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  try {
    const result = await execFileAsync(cliPath, ["doctor", "--json"], {
      cwd: rootDir,
      timeout: 45000,
      maxBuffer: 2 * 1024 * 1024,
      env: {
        ...process.env,
        NO_COLOR: "1",
      },
    });
    stdout = result.stdout || "";
    stderr = result.stderr || "";
  } catch (error) {
    stdout = error.stdout || "";
    stderr = error.stderr || "";
    exitCode = Number.isInteger(error.code) ? error.code : 1;
    if (!stdout.trim()) throw new Error(`Codex Doctor failed: ${readFirstLine(stderr) || error.message}`);
  }

  let report;
  try {
    report = JSON.parse(stdout);
  } catch {
    throw new Error(`Codex Doctor returned non-JSON output: ${readFirstLine(stdout || stderr) || "empty output"}`);
  }

  return buildOfficialDoctorSummary(report, {
    command: `${cliPath} doctor --json`,
    exitCode,
    durationMs: Math.round(performance.now() - startedAt),
  });
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

async function fileSize(targetPath) {
  const stats = await statOrNull(targetPath);
  return stats?.isFile() ? stats.size : 0;
}

async function statOrNull(targetPath) {
  try {
    return await fs.lstat(targetPath);
  } catch {
    return null;
  }
}

async function readJsonOrNull(targetPath) {
  try {
    return JSON.parse(await fs.readFile(targetPath, "utf8"));
  } catch {
    return null;
  }
}

async function listDirNames(targetPath) {
  try {
    return (await fs.readdir(targetPath, { withFileTypes: true })).map((dirent) => dirent.name);
  } catch {
    return [];
  }
}

function pathContains(parentPath, childPath) {
  const parent = path.resolve(parentPath || "");
  const child = path.resolve(childPath || "");
  return child === parent || child.startsWith(`${parent}${path.sep}`);
}

function scriptLooksUseful(value) {
  const script = String(value || "").trim();
  return Boolean(script && !/no test specified/i.test(script));
}

async function getProjectReadinessSummary(projectStatus) {
  const projectPath = projectStatus?.path;
  const existsOnDisk = Boolean(projectStatus?.exists);
  const summary = {
    path: projectPath,
    label: projectPath ? basenameLabel(projectPath) : "Project",
    exists: existsOnDisk,
    score: 0,
    ready: false,
    hasGit: false,
    hasAgents: false,
    hasAgentsFile: false,
    agentsBytes: 0,
    hasCodexDir: false,
    hasProjectConfig: false,
    hasLocalEnvironmentHint: false,
    codexFiles: [],
    hasPackageJson: false,
    hasDevScript: false,
    hasBuildScript: false,
    hasTestScript: false,
    scripts: {},
    gaps: existsOnDisk ? [] : ["Project path is missing"],
  };

  if (!projectPath || !existsOnDisk) return summary;

  const codexDir = path.join(projectPath, ".codex");
  const [agentsBytes, agentsOverrideBytes, packageJson, codexDirStats, projectConfigStats, gitStats] = await Promise.all([
    fileSize(path.join(projectPath, "AGENTS.md")),
    fileSize(path.join(projectPath, "AGENTS.override.md")),
    readJsonOrNull(path.join(projectPath, "package.json")),
    statOrNull(codexDir),
    statOrNull(path.join(codexDir, "config.toml")),
    statOrNull(path.join(projectPath, ".git")),
  ]);

  summary.agentsBytes = Math.max(agentsBytes, agentsOverrideBytes);
  summary.hasAgents = summary.agentsBytes > 0;
  summary.hasAgentsFile = agentsBytes > 0 || agentsOverrideBytes > 0;
  summary.hasGit = Boolean(gitStats);
  summary.hasCodexDir = Boolean(codexDirStats?.isDirectory());
  summary.hasProjectConfig = Boolean(projectConfigStats?.isFile());

  if (summary.hasCodexDir) {
    summary.codexFiles = (await listDirNames(codexDir)).slice(0, 12);
    summary.hasLocalEnvironmentHint = summary.codexFiles.some((name) => /action|environment|local|setup|worktree/i.test(name));
  }

  if (packageJson && typeof packageJson === "object") {
    const scripts = packageJson.scripts && typeof packageJson.scripts === "object" ? packageJson.scripts : {};
    summary.hasPackageJson = true;
    summary.scripts = Object.fromEntries(
      ["dev", "start", "build", "test", "lint", "typecheck", "package:mac"]
        .filter((name) => scripts[name])
        .map((name) => [name, scripts[name]]),
    );
    summary.hasDevScript = scriptLooksUseful(scripts.dev || scripts.start);
    summary.hasBuildScript = scriptLooksUseful(scripts.build);
    summary.hasTestScript = scriptLooksUseful(scripts.test || scripts.lint || scripts.typecheck);
  }

  if (!summary.hasAgents) {
    summary.gaps.push(summary.hasAgentsFile ? "Fill in AGENTS.md" : "Add AGENTS.md");
  }
  if (!summary.hasCodexDir) summary.gaps.push("Add .codex local setup/actions");
  if (summary.hasPackageJson && !summary.hasDevScript && !summary.hasBuildScript) summary.gaps.push("Document run/build command");
  if (summary.hasPackageJson && !summary.hasTestScript && !summary.hasBuildScript) {
    summary.gaps.push("Add or document verification command");
  }

  summary.score = Math.min(
    100,
    (summary.hasAgents ? 35 : 0) +
      (summary.hasProjectConfig ? 15 : summary.hasCodexDir ? 8 : 0) +
      (summary.hasLocalEnvironmentHint ? 10 : 0) +
      (summary.hasDevScript || summary.hasBuildScript ? 15 : 0) +
      (summary.hasTestScript ? 25 : 0) +
      (summary.hasGit ? 5 : 0),
  );
  summary.ready = summary.score >= 70 && summary.hasAgents;
  return summary;
}

function chooseCurrentProjectReadiness(projects) {
  const candidates = [process.cwd(), rootDir].map((candidate) => path.resolve(candidate));
  return (
    projects
      .filter((project) => project.exists)
      .sort((a, b) => {
        const aMatch = candidates.some((candidate) => pathContains(a.path, candidate)) ? 1 : 0;
        const bMatch = candidates.some((candidate) => pathContains(b.path, candidate)) ? 1 : 0;
        if (aMatch !== bMatch) return bMatch - aMatch;
        return String(b.path || "").length - String(a.path || "").length;
      })[0] || null
  );
}

async function getTrustedProjectReadiness(trustedProjectStatuses) {
  const projects = await Promise.all((trustedProjectStatuses || []).map((project) => getProjectReadinessSummary(project)));
  const existingProjects = projects.filter((project) => project.exists);
  const currentProject = chooseCurrentProjectReadiness(projects);

  return {
    projects,
    existingCount: existingProjects.length,
    readyCount: existingProjects.filter((project) => project.ready).length,
    missingGuidanceCount: existingProjects.filter((project) => !project.hasAgents).length,
    missingCodexDirCount: existingProjects.filter((project) => !project.hasCodexDir).length,
    missingVerificationCount: existingProjects.filter((project) => project.hasPackageJson && !project.hasTestScript && !project.hasBuildScript).length,
    averageScore: existingProjects.length
      ? Math.round(existingProjects.reduce((total, project) => total + project.score, 0) / existingProjects.length)
      : 0,
    currentProject,
    weakestProjects: existingProjects
      .filter((project) => !project.ready)
      .sort((a, b) => a.score - b.score)
      .slice(0, 5),
  };
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

async function getAuthCacheSummary(values = {}) {
  const authStats = await statOrNull(paths.authJson);
  const authFileExists = Boolean(authStats?.isFile());
  const authFileBytes = authFileExists ? authStats.size : 0;
  const authFileMode = authFileExists ? `0${(authStats.mode & 0o777).toString(8)}` : null;
  const authFileModifiedAt = authFileExists ? authStats.mtime.toISOString() : null;
  const configuredStore = values.cli_auth_credentials_store ? String(values.cli_auth_credentials_store) : null;
  const credentialStore = configuredStore || "file";
  const usesFileStore = credentialStore === "file";
  const usesKeyringStore = credentialStore === "keyring";
  const usesAutoStore = credentialStore === "auto";
  const hasUsableFileCache = authFileBytes > 128;
  const forcedLoginMethod = values.forced_login_method || null;
  const forcedWorkspace = values.forced_chatgpt_workspace_id || null;

  let status = "unknown";
  let label = "Unknown";
  let tone = "medium";
  let detail = "Credential storage was not configured and no file cache state could be confirmed.";

  if (usesKeyringStore) {
    status = "keyring";
    label = "Keyring";
    tone = "low";
    detail = "Codex is configured to use the operating system credential store. Codex Refit does not inspect keychain contents.";
  } else if (usesAutoStore) {
    status = hasUsableFileCache ? "file-cache" : "auto";
    label = hasUsableFileCache ? "Auto + file" : "Auto";
    tone = "low";
    detail = hasUsableFileCache
      ? "Auto credential storage has a local auth.json cache available."
      : "Auto credential storage may use the OS keychain first and fall back to auth.json.";
  } else if (usesFileStore && hasUsableFileCache) {
    status = "file-cache";
    label = "File cache";
    tone = authFileMode && authFileMode !== "0600" ? "medium" : "low";
    detail =
      authFileMode && authFileMode !== "0600"
        ? `auth.json exists but permissions are ${authFileMode}. Treat this file like a password.`
        : "auth.json exists, so CLI/app login caching should be available without repeated browser login.";
  } else if (usesFileStore) {
    status = authFileExists ? "empty-file" : "missing-file";
    label = authFileExists ? "Empty file" : "Missing file";
    tone = "medium";
    detail = authFileExists
      ? "auth.json exists but is too small to look like a useful login cache."
      : "File credential storage is selected, but auth.json was not found. Codex may need a fresh login.";
  }

  return {
    path: paths.authJson,
    credentialStore,
    configuredStore,
    status,
    label,
    tone,
    detail,
    authFileExists,
    authFileBytes,
    authFileMode,
    authFileModifiedAt,
    forcedLoginMethod,
    forcedWorkspaceConfigured: Boolean(forcedWorkspace),
    needsLoginCheck: ["missing-file", "empty-file", "unknown"].includes(status),
  };
}

async function getCodexConfigSummary() {
  const globalAgentsBytes = await fileSize(paths.globalAgents);
  const summary = {
    path: paths.configToml,
    exists: false,
    model: null,
    reasoningEffort: null,
    approvalPolicy: null,
    sandboxMode: null,
    serviceTier: null,
    desktopServiceTier: null,
    cliAuthCredentialsStore: null,
    forcedLoginMethod: null,
    forcedWorkspaceConfigured: false,
    authCache: await getAuthCacheSummary({}),
    fastMode: false,
    fastModeFeature: true,
    shellSnapshot: true,
    goalsFeature: false,
    webSearchMode: null,
    maxConcurrentThreadsPerSession: null,
    agentMaxThreads: null,
    agentMaxThreadsEffective: 6,
    agentMaxDepth: null,
    agentMaxDepthEffective: 1,
    agentJobMaxRuntimeSeconds: null,
    trustedProjectCount: 0,
    staleTrustedProjectCount: 0,
    trustedProjectPaths: [],
    trustedProjectStatuses: [],
    staleTrustedProjectPaths: [],
    projectReadiness: {
      projects: [],
      existingCount: 0,
      readyCount: 0,
      missingGuidanceCount: 0,
      missingCodexDirCount: 0,
      missingVerificationCount: 0,
      averageScore: 0,
      currentProject: null,
      weakestProjects: [],
    },
    enabledPluginCount: 0,
    enabledMcpCount: 0,
    disabledMcpCount: 0,
    requiredMcpCount: 0,
    profileCount: 0,
    profileSummaries: [],
    hasFastTaskProfile: false,
    fastTaskProfileNames: [],
    hasSparkProfile: false,
    sparkProfileNames: [],
    hasMiniProfile: false,
    miniProfileNames: [],
    hasDeepWorkProfile: false,
    deepWorkProfileNames: [],
    legacyProfileConfig: false,
    globalAgentsExists: globalAgentsBytes > 0,
    globalAgentsFileExists: await exists(paths.globalAgents),
    globalAgentsBytes,
  };

  Object.assign(summary, await getCodexProfileSummaries());

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
    summary.serviceTier = values.service_tier || null;
    summary.desktopServiceTier = values["desktop.default-service-tier"] || null;
    summary.cliAuthCredentialsStore = values.cli_auth_credentials_store || null;
    summary.forcedLoginMethod = values.forced_login_method || null;
    summary.forcedWorkspaceConfigured = Boolean(values.forced_chatgpt_workspace_id);
    summary.authCache = await getAuthCacheSummary(values);
    summary.fastModeFeature = values["features.fast_mode"] !== false;
    summary.fastMode = summary.fastModeFeature && summary.serviceTier === "fast";
    summary.shellSnapshot = values["features.shell_snapshot"] !== false;
    summary.goalsFeature = values["features.goals"] === true;
    summary.webSearchMode = values.web_search || null;
    summary.maxConcurrentThreadsPerSession = values.max_concurrent_threads_per_session || null;
    summary.agentMaxThreads = configNumber(values["agents.max_threads"]);
    summary.agentMaxThreadsEffective = summary.agentMaxThreads ?? 6;
    summary.agentMaxDepth = configNumber(values["agents.max_depth"]);
    summary.agentMaxDepthEffective = summary.agentMaxDepth ?? 1;
    summary.agentJobMaxRuntimeSeconds = configNumber(values["agents.job_max_runtime_seconds"]);
    summary.legacyProfileConfig = Boolean(values.profile || sections.some((section) => section.startsWith("profiles.")));
    summary.trustedProjectPaths = extractTrustedProjectPaths(sections, values);
    summary.trustedProjectCount = summary.trustedProjectPaths.length;
    const trustedProjectExists = await Promise.all(summary.trustedProjectPaths.map((projectPath) => exists(projectPath)));
    summary.trustedProjectStatuses = summary.trustedProjectPaths.map((projectPath, index) => ({
      path: projectPath,
      exists: trustedProjectExists[index],
    }));
    summary.staleTrustedProjectPaths = summary.trustedProjectStatuses.filter((project) => !project.exists).map((project) => project.path);
    summary.staleTrustedProjectCount = summary.staleTrustedProjectPaths.length;
    summary.projectReadiness = await getTrustedProjectReadiness(summary.trustedProjectStatuses);
    summary.enabledPluginCount = sections.filter((section) => section.startsWith('plugins."') && values[`${section}.enabled`] === true).length;
    const mcpSections = sections.filter(isTopLevelMcpSection);
    summary.enabledMcpCount = mcpSections.filter((section) => values[`${section}.enabled`] !== false).length;
    summary.disabledMcpCount = mcpSections.filter((section) => values[`${section}.enabled`] === false).length;
    summary.requiredMcpCount = mcpSections.filter((section) => values[`${section}.required`] === true && values[`${section}.enabled`] !== false).length;
  } catch (error) {
    summary.error = error.message;
  }

  return summary;
}

function projectTableForPath(projectPath) {
  return `[projects."${String(projectPath || "").replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"]`;
}

function projectCommandLine(project, candidates, fallback) {
  const scripts = project?.scripts || {};
  const scriptName = candidates.find((name) => scripts[name]);
  return scriptName ? `npm run ${scriptName}` : fallback;
}

function buildProjectPlaybookSnippet(project) {
  const projectPath = project?.path || "/path/to/project";
  const runCommand = projectCommandLine(project, ["dev", "start"], "Document the local run command.");
  const buildCommand = projectCommandLine(project, ["build", "package:mac"], "Document the build command.");
  const verifyCommand = projectCommandLine(project, ["test", "lint", "typecheck", "build"], "Document the smallest useful verification command.");
  const lines = [
    `# ${path.join(projectPath, "AGENTS.md")}`,
    "",
    "## Project Playbook",
    `- Run locally: \`${runCommand}\``,
    `- Build/package: \`${buildCommand}\``,
    `- Verify changes: \`${verifyCommand}\``,
    "- Keep changes scoped and preserve generated assets unless explicitly asked.",
    "- After UI changes, run the relevant build and check the packaged app when behavior depends on Electron.",
    "",
    "## Done When",
    "- The requested behavior is visible in the app or covered by the smallest relevant command.",
    "- The working tree only contains intentional changes.",
  ];

  if (!project?.hasCodexDir) {
    lines.push(
      "",
      "# Also configure Codex app Local Environments for this project:",
      "# - setup script for worktrees, such as npm install && npm run build",
      "# - actions for common commands, such as dev, build, and test",
    );
  }

  return lines.join("\n");
}

function buildAuthCacheSnippet(authCache = {}) {
  const lines = [
    "# Safe auth diagnostics. Do not paste auth.json contents anywhere.",
    "codex doctor --summary",
    "",
    "# Refresh local login cache if Codex keeps asking you to sign in:",
    "codex login",
    "",
    "# If browser login is unreliable or remote/headless:",
    "codex login --device-auth",
  ];

  if (authCache.credentialStore !== "keyring") {
    lines.push(
      "",
      "# Optional ~/.codex/config.toml on macOS:",
      'cli_auth_credentials_store = "keyring"',
      "# Use keyring for OS credential storage, or \"file\" if you intentionally want ~/.codex/auth.json.",
    );
  }

  return lines.join("\n");
}

function buildDoctorFixKit(scan, codexConfig, runtime, context = {}) {
  const fixes = [];
  const addFix = (fix) => {
    if (!fix?.id || fixes.some((existing) => existing.id === fix.id)) return;
    fixes.push(fix);
  };

  const activeReliefBytes = context.activeReliefBytes || 0;
  const logBytes = context.logBytes || 0;
  const logWalBytes = context.logWalBytes || 0;
  const staleProjectPaths = codexConfig?.staleTrustedProjectPaths || [];
  const highEffort = ["high", "xhigh", "extra-high", "extra_high"].includes(String(codexConfig?.reasoningEffort || "").toLowerCase());
  const hasGuidance = Boolean(codexConfig?.globalAgentsExists);
  const emptyGuidance = Boolean(codexConfig?.globalAgentsFileExists && !codexConfig?.globalAgentsExists);
  const fastMode = Boolean(codexConfig?.fastMode);
  const fastModeFeature = codexConfig?.fastModeFeature !== false;
  const hasFastTaskProfile = Boolean(codexConfig?.hasFastTaskProfile);
  const projectReadiness = codexConfig?.projectReadiness || {};
  const currentProject = projectReadiness.currentProject;
  const authCache = codexConfig?.authCache || {};
  const processSummary = context.processSummary || {};
  const agentMaxThreads = Number(codexConfig?.agentMaxThreadsEffective ?? 6);
  const agentMaxDepth = Number(codexConfig?.agentMaxDepthEffective ?? 1);
  const agentFanoutRisk = agentMaxDepth > 1 || agentMaxThreads >= 12;

  if (activeReliefBytes > 0 || logWalBytes > 128 * 1024 ** 2 || logBytes > 1024 ** 3) {
    addFix({
      id: "run-smart-optimize",
      label: "Run Refit First",
      value: activeReliefBytes > 0 ? formatBytesServer(activeReliefBytes) : formatBytesServer(logBytes + logWalBytes),
      tone: "high",
      action: "Smart Optimize, then Run Check",
      detail:
        "Best local win: move stale active history, prune logs, checkpoint WAL, and compact databases with backups. This does not delete generated images.",
    });
  }

  if (processSummary.status === "ready" && processSummary.tone !== "low") {
    addFix({
      id: "live-process-load",
      label: "Live Codex Load",
      value: `${Number(processSummary.processCount || 0).toLocaleString()} procs`,
      tone: processSummary.tone === "high" ? "high" : "medium",
      action: "Close idle work",
      detail:
        "Many live Codex helpers can make the app feel slow even after local cleanup. Finish or archive idle threads, close extra terminals, then restart Codex after active runs are done.",
      snippet: buildProcessLoadSnippet(),
    });
  }

  if (agentFanoutRisk) {
    addFix({
      id: "agent-fanout",
      label: "Agent Fan-out",
      value: `${agentMaxThreads.toLocaleString()} / depth ${agentMaxDepth.toLocaleString()}`,
      tone: agentMaxDepth > 2 || agentMaxThreads >= 24 ? "high" : "medium",
      action: "Cap subagents",
      detail:
        "The Codex manual says agents.max_threads defaults to 6 and agents.max_depth defaults to 1. Higher depth can create repeated fan-out that adds token use, latency, and local resource load.",
      snippet: [
        "# ~/.codex/config.toml",
        "# Conservative defaults for fast, predictable subagent work.",
        "[agents]",
        "max_threads = 6",
        "max_depth = 1",
        "",
        "# Raise these only for deliberately parallel tasks.",
      ].join("\n"),
    });
  }

  if (runtime?.versionMismatch) {
    addFix({
      id: "runtime-check",
      label: "Runtime Check",
      value: `${runtime.cliVersion} / ${runtime.appVersion}`,
      tone: "medium",
      action: "Compare versions",
      detail: "If the app and terminal feel different, confirm which Codex binary each surface is using before changing settings.",
      snippet: [
        "which codex",
        "codex --version",
        `${runtime.appCliPath || codexAppCli} --version`,
      ].join("\n"),
    });
  }

  if (authCache.needsLoginCheck) {
    addFix({
      id: "auth-cache-check",
      label: "Auth Cache",
      value: authCache.label || "Check",
      tone: "medium",
      action: "Run codex doctor",
      detail:
        "Codex caches login in auth.json or the OS keychain. If it keeps asking you to sign in, refresh the login cache and inspect the redacted doctor report.",
      snippet: buildAuthCacheSnippet(authCache),
    });
  }

  if (!hasFastTaskProfile) {
    addFix({
      id: "speed-profile-file",
      label: "Speed Profile",
      value: "Missing",
      tone: "medium",
      action: "Create speed.config.toml",
      detail:
        "Named profiles let you keep a fast small-task setup without changing your deep-work default. Use the profile only when the task is scoped and easy to verify.",
      snippet: [
        "# ~/.codex/speed.config.toml",
        'model = "gpt-5.4-mini"',
        'model_reasoning_effort = "low"',
        'model_verbosity = "low"',
        "",
        "# Optional after /fast status confirms access:",
        '# service_tier = "fast"',
        "#",
        "# [features]",
        "# fast_mode = true",
        "",
        "# Use it:",
        'codex --profile speed "small, scoped task"',
        "",
        "# If Codex-Spark is available for your account, test it in a separate profile:",
        '# model = "gpt-5.3-codex-spark"',
      ].join("\n"),
    });
  }

  if (
    currentProject &&
    (!currentProject.hasAgents || !currentProject.hasCodexDir || (!currentProject.hasTestScript && !currentProject.hasBuildScript))
  ) {
    addFix({
      id: "project-playbook",
      label: "Project Playbook",
      value: `${currentProject.score}/100`,
      tone: currentProject.score >= 70 ? "low" : "medium",
      action: currentProject.hasAgents ? "Add setup/actions" : "Add AGENTS.md",
      detail:
        "Project-level guidance and local environment actions help Codex start with run, build, and verification context instead of rediscovering it.",
      snippet: buildProjectPlaybookSnippet(currentProject),
    });
  }

  if (!hasGuidance) {
    addFix({
      id: "agents-guidance",
      label: "AGENTS Guidance",
      value: emptyGuidance ? "Empty" : "Missing",
      tone: "medium",
      action: "Add only repeated rules",
      detail:
        emptyGuidance
          ? "Codex skips empty AGENTS files. Add recurring preferences that save future correction loops."
          : "Durable guidance can keep repeated preferences out of every prompt.",
      snippet: [
        "# ~/.codex/AGENTS.md",
        "",
        "## Working Agreements",
        "- Keep changes scoped to the requested task.",
        "- Inspect the existing code style before editing.",
        "- Run the relevant build or test command after code changes.",
        "- Preserve user-created files and generated assets unless explicitly asked.",
      ].join("\n"),
    });
  }

  if (codexConfig?.legacyProfileConfig) {
    addFix({
      id: "legacy-profile-config",
      label: "Legacy Profiles",
      value: "Old syntax",
      tone: "medium",
      action: "Move to profile files",
      detail:
        "Codex 0.134.0 and later expects named profiles in ~/.codex/name.config.toml files, not profile = or [profiles.*] inside config.toml.",
      snippet: [
        `# ${paths.configToml}`,
        "# Remove legacy top-level profile selectors or [profiles.*] tables.",
        "",
        "# Then create named profile files, for example:",
        "# ~/.codex/speed.config.toml",
        'model = "gpt-5.4-mini"',
        'model_reasoning_effort = "low"',
      ].join("\n"),
    });
  }

  if (staleProjectPaths.length) {
    addFix({
      id: "stale-trust",
      label: "Stale Trust",
      value: `${staleProjectPaths.length}/${codexConfig?.trustedProjectCount || staleProjectPaths.length}`,
      tone: "medium",
      action: "Remove missing project tables",
      detail: "These trusted project paths no longer exist. Remove their tables from config.toml after confirming you do not need the entries.",
      snippet: [
        `# ${paths.configToml}`,
        ...staleProjectPaths.slice(0, 8).map(projectTableForPath),
        ...(staleProjectPaths.length > 8 ? [`# plus ${staleProjectPaths.length - 8} more missing project table${staleProjectPaths.length - 8 === 1 ? "" : "s"}`] : []),
      ].join("\n"),
    });
  }

  if (highEffort) {
    addFix({
      id: "small-task-profile",
      label: "Small Task Profile",
      value: codexConfig?.reasoningEffort || "High",
      tone: "medium",
      action: "Use mini or lower effort",
      detail: "For small, well-scoped tasks, use a lighter model or lower reasoning. Keep gpt-5.5 with high/xhigh for hard debugging.",
      snippet: [
        'codex --model gpt-5.4-mini "small, scoped task"',
        'codex --config model_reasoning_effort=\'"low"\' "small, scoped task"',
      ].join("\n"),
    });
  }

  if (!fastMode && fastModeFeature) {
    addFix({
      id: "fast-mode-check",
      label: "Fast Mode",
      value: codexConfig?.serviceTier || codexConfig?.desktopServiceTier || "standard",
      tone: "medium",
      action: "/fast status",
      detail: "Fast Mode can accelerate supported models at higher credit use. Check access before making it the default.",
      snippet: [
        "/fast status",
        "",
        "# Optional ~/.codex/config.toml default after confirming access:",
        'service_tier = "fast"',
        "",
        "[features]",
        "fast_mode = true",
      ].join("\n"),
    });
  }

  if (!codexConfig?.goalsFeature) {
    addFix({
      id: "goal-mode-config",
      label: "Long Work",
      value: "Goal Mode",
      tone: "low",
      action: "Use for persistent objectives",
      detail: "Goal mode helps long optimization and refactor work keep an explicit completion target across turns.",
      snippet: [
        "# Add under the existing [features] table in ~/.codex/config.toml",
        "goals = true",
      ].join("\n"),
    });
  }

  if (!fixes.length) {
    addFix({
      id: "speed-check",
      label: "Baseline",
      value: "Ready",
      tone: "low",
      action: "Run Check",
      detail: "No major actionable Doctor issue is showing. Refresh the local benchmark before changing config.",
    });
  }

  return fixes.sort((a, b) => {
    const weight = { high: 3, medium: 2, low: 1, danger: 4 };
    return (weight[b.tone] || 0) - (weight[a.tone] || 0);
  });
}

function buildCodexDoctor(scan, codexConfig, runtime = {}, processSummary = {}) {
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
  const desktopTier = codexConfig?.desktopServiceTier || null;
  const displayTier = codexConfig?.serviceTier || desktopTier || "standard";
  const isHighEffort = ["high", "xhigh", "extra-high", "extra_high"].includes(String(effort).toLowerCase());
  const hasFastTaskProfile = Boolean(codexConfig?.hasFastTaskProfile);
  const fastTaskProfileNames = codexConfig?.fastTaskProfileNames || [];
  const hasSparkProfile = Boolean(codexConfig?.hasSparkProfile);
  const hasMiniProfile = Boolean(codexConfig?.hasMiniProfile);
  const projectReadiness = codexConfig?.projectReadiness || {};
  const currentProject = projectReadiness.currentProject || null;
  const existingProjectCount = Number(projectReadiness.existingCount || 0);
  const projectReadyCount = Number(projectReadiness.readyCount || 0);
  const projectGapCount = Number(projectReadiness.missingGuidanceCount || 0) + Number(projectReadiness.missingCodexDirCount || 0);
  const authCache = codexConfig?.authCache || {};
  const globalGuidanceReady = Boolean(codexConfig?.globalAgentsExists);
  const emptyGlobalGuidance = Boolean(codexConfig?.globalAgentsFileExists && !codexConfig?.globalAgentsExists);
  const staleTrustedProjectCount = Number(codexConfig?.staleTrustedProjectCount || 0);
  const webSearchMode = codexConfig?.webSearchMode || "cached default";
  const docsSource = "Official Codex manual: Speed, Models, Config, AGENTS, MCP, Troubleshooting";
  const processReady = processSummary?.status === "ready";
  const processLoaded = processReady && processSummary.tone !== "low";
  const processCount = Number(processSummary?.processCount || 0);
  const processRssBytes = Number(processSummary?.rssBytes || 0);

  const localDetail =
    activeReliefBytes > 0 || logWalBytes > 128 * 1024 ** 2
      ? `Move ${formatBytesServer(activeReliefBytes)} out of active sessions and compact ${formatBytesServer(logBytes + logWalBytes)} of logs.`
      : "Local sessions and logs are not showing major pressure right now.";

  const modelDetail =
    effort === "xhigh" || effort === "high"
      ? `Default is ${model} with ${effort} reasoning. Great for hard work; lower effort, gpt-5.4-mini, or Codex-Spark when available can feel faster on light coding.`
      : `Default is ${model} with ${effort} reasoning. Match effort and model to task size for speed.`;

  const speedDetail = fastMode
    ? `Fast Mode is configured; service tier is ${tier}.`
    : `Fast Mode is not configured here. The Codex manual says /fast can speed supported models when it is available.`;

  const workflowDetail = globalGuidanceReady
    ? `Global AGENTS guidance is active (${formatBytesServer(codexConfig.globalAgentsBytes)}).`
    : emptyGlobalGuidance
      ? "Global AGENTS.md exists but is empty, so Codex skips it."
      : "No global AGENTS guidance found; adding durable guidance can reduce repeated correction loops.";

  const projectDetail = currentProject
    ? currentProject.ready
      ? `${currentProject.label} has a useful project playbook score (${currentProject.score}/100).`
      : `${currentProject.label} is missing ${currentProject.gaps.slice(0, 3).join(", ")}. Add project guidance or local environment actions so Codex does not rediscover setup every run.`
    : existingProjectCount
      ? `${projectReadyCount}/${existingProjectCount} trusted projects look Codex-ready. Add AGENTS.md and local setup/actions to the projects you use most.`
      : "No existing trusted projects were found to inspect.";

  const runtimeDetail = runtime?.versionMismatch
    ? `Terminal Codex is ${runtime.cliVersion}; the bundled app binary is ${runtime.appVersion}. The manual notes app and CLI versions can differ.`
    : runtime?.cliVersion || runtime?.appVersion
      ? `Terminal Codex ${runtime.cliVersion || "not found"}; app binary ${runtime.appVersion || "not found"}.`
      : "Codex CLI was not found on PATH and the app binary was not detected.";

  const processDetail =
    processReady
      ? `${processSummary.detail} Oldest live Codex process: ${processSummary.longestAgeLabel || "unknown"}.`
      : processSummary?.detail || "Live Codex process load was not available for this scan.";

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
      value: globalGuidanceReady ? "Guided" : emptyGlobalGuidance ? "Empty" : "Needs Guidance",
      tone: globalGuidanceReady ? "low" : "medium",
      detail: `${workflowDetail} Keep prompts scoped with goal, context, constraints, and done-when checks.`,
      next: globalGuidanceReady ? "Keep prompts scoped" : "Add useful guidance",
    },
    {
      id: runtime?.versionMismatch ? "runtime-drift" : "generated-images",
      label: runtime?.versionMismatch ? "Runtime Drift" : "Image Output",
      value: runtime?.versionMismatch ? `${runtime.cliVersion} / ${runtime.appVersion}` : formatBytesServer(generatedImageBytes),
      tone: runtime?.versionMismatch || generatedImageBytes > 10 * 1024 ** 3 ? "medium" : "low",
      detail: runtime?.versionMismatch
        ? runtimeDetail
        : "Generated images are move-only in Codex Refit. They can leave the active cache without being deleted.",
      next: runtime?.versionMismatch ? "Align versions" : generatedImageBytes > 1024 ** 3 ? "Move old images" : "Leave images alone",
    },
  ];

  const profiles = [
    {
      id: "fast-lane-profile",
      label: "Fast Lane",
      value: hasFastTaskProfile ? fastTaskProfileNames.slice(0, 2).join(", ") : "Missing",
      tone: hasFastTaskProfile ? "low" : "medium",
      action: hasFastTaskProfile ? "Use --profile" : "Create speed profile",
      detail: hasFastTaskProfile
        ? `Named fast profile${fastTaskProfileNames.length === 1 ? "" : "s"} found: ${fastTaskProfileNames.join(", ")}. Use one for small, well-scoped tasks.`
        : "Create ~/.codex/speed.config.toml with gpt-5.4-mini and low reasoning so quick tasks do not inherit the deep-work default.",
    },
    {
      id: "small-task-speed",
      label: "Small Tasks",
      value: hasSparkProfile ? "Spark ready" : hasMiniProfile ? "Mini ready" : isHighEffort ? "Tune down" : "Current fit",
      tone: hasSparkProfile || hasMiniProfile || !isHighEffort ? "low" : "medium",
      action: hasSparkProfile ? "Use Spark when apt" : hasMiniProfile ? "Use mini profile" : isHighEffort ? "Mini or lower effort" : "Keep prompts tight",
      detail:
        hasSparkProfile
          ? "A Codex-Spark profile exists. The manual describes Spark as a near-instant iteration model for lighter real-time coding when available."
          : "The Codex manual recommends gpt-5.4-mini for lighter coding and low reasoning for faster, well-scoped tasks. Codex-Spark is another near-instant option when your account has it.",
    },
    {
      id: "deep-work",
      label: "Deep Work",
      value: model === "gpt-5.5" ? "Best model" : "Use gpt-5.5",
      tone: model === "gpt-5.5" && isHighEffort ? "low" : "medium",
      action: globalGuidanceReady ? "Plan, test, review" : "Add AGENTS.md",
      detail:
        "The manual recommends gpt-5.5 for complex coding, computer use, research, and knowledge work. For long work, pair high reasoning with plan mode, tests, review, and durable AGENTS guidance.",
    },
  ];

  const configAdvice = [
    {
      id: "auth-cache",
      label: "Auth Cache",
      value: authCache.label || "Unknown",
      tone: authCache.tone || "medium",
      action: authCache.needsLoginCheck ? "Run codex doctor" : "Keep cached",
      priority: authCache.needsLoginCheck ? 86 : 36,
      detail:
        authCache.detail ||
        "Codex Refit checks only credential-cache metadata. It does not inspect auth token contents.",
    },
    {
      id: "permission-flow",
      label: "Permission Flow",
      value: codexConfig?.approvalPolicy || "Default",
      tone: codexConfig?.approvalPolicy === "never" ? "low" : "medium",
      action: codexConfig?.approvalPolicy === "never" ? "Fast, high-trust" : "Review prompts",
      priority: codexConfig?.approvalPolicy === "never" ? 30 : 72,
      detail:
        codexConfig?.approvalPolicy === "never"
          ? "Approval prompts are not expected from Codex itself. Use this only for trusted work because it reduces safety stops."
          : "Approval prompts can interrupt fast runs. Use /permissions or config only when the trust/safety tradeoff is right.",
    },
    {
      id: "shell-snapshot",
      label: "Shell Snapshot",
      value: shellSnapshot ? "On" : "Off",
      tone: shellSnapshot ? "low" : "medium",
      action: shellSnapshot ? "Keep enabled" : "Enable shell snapshot",
      priority: shellSnapshot ? 32 : 84,
      detail: shellSnapshot
        ? "Codex can snapshot the shell environment to speed up repeated commands."
        : "Set features.shell_snapshot = true so repeated command setup can be faster.",
    },
    {
      id: "fast-default",
      label: "Fast Default",
      value: fastMode ? "Fast" : fastModeFeature ? displayTier : "Feature off",
      tone: fastMode ? "low" : "medium",
      action: fastMode ? "Watch credits" : "/fast status",
      priority: fastMode ? 34 : 80,
      detail: fastMode
        ? "Fast Mode is the configured default. It is faster on supported models and uses more credits."
        : fastModeFeature
          ? `Fast Mode selection is available, but this config is not set to the documented service_tier = "fast" default. Desktop tier is ${desktopTier || "not set"}.`
          : "features.fast_mode is disabled, so the persistent fast service-tier path is not available.",
    },
    {
      id: "web-search",
      label: "Web Search",
      value: webSearchMode,
      tone: codexConfig?.webSearchMode === "live" ? "medium" : "low",
      action: codexConfig?.webSearchMode === "live" ? "Use cached/local" : "Keep scoped",
      priority: codexConfig?.webSearchMode === "live" ? 70 : 24,
      detail:
        codexConfig?.webSearchMode === "live"
          ? "Live web search is useful for current facts, but cached or disabled search can make local coding runs more predictable."
          : "Cached/default web search is a good baseline. Disable it only for fully local tasks that should never look outward.",
    },
    {
      id: "goal-mode",
      label: "Goal Mode",
      value: goalsFeature ? "On" : "Optional",
      tone: goalsFeature ? "low" : "medium",
      action: goalsFeature ? "Use for long work" : "Enable for long work",
      priority: goalsFeature ? 20 : 52,
      detail: goalsFeature
        ? "Goal mode is enabled for persistent, multi-step objectives."
        : "For long speed/refactor work, enable features.goals = true so Codex can keep a clear completion target.",
    },
    {
      id: "guidance",
      label: "Reusable Guidance",
      value: globalGuidanceReady ? "Global ready" : emptyGlobalGuidance ? "Empty file" : "Missing",
      tone: globalGuidanceReady ? "low" : "medium",
      action: globalGuidanceReady ? "Keep concise" : "Add useful guidance",
      priority: globalGuidanceReady ? 28 : 76,
      detail: globalGuidanceReady
        ? "Global AGENTS guidance is present. Keep it short, practical, and based on repeated friction."
        : emptyGlobalGuidance
          ? "The file exists but is empty, so Codex skips it. Add only repeated working preferences that save future prompting."
          : "Add ~/.codex/AGENTS.md so recurring preferences do not need to be repeated in every prompt.",
    },
  ].sort((a, b) => b.priority - a.priority);

  const threadLimit = Number(codexConfig?.maxConcurrentThreadsPerSession || 0);
  const agentMaxThreads = Number(codexConfig?.agentMaxThreadsEffective ?? 6);
  const agentMaxDepth = Number(codexConfig?.agentMaxDepthEffective ?? 1);
  const agentThreadsConfigured = codexConfig?.agentMaxThreads !== null && codexConfig?.agentMaxThreads !== undefined;
  const agentDepthConfigured = codexConfig?.agentMaxDepth !== null && codexConfig?.agentMaxDepth !== undefined;
  const agentFanoutRisk = agentMaxDepth > 1 || agentMaxThreads >= 12;
  const agentFanoutHeavy = agentMaxDepth > 2 || agentMaxThreads >= 24;
  const agentFanoutDetail =
    agentFanoutRisk
      ? `Subagent cap is ${agentMaxThreads.toLocaleString()} open thread${agentMaxThreads === 1 ? "" : "s"} with depth ${agentMaxDepth.toLocaleString()}. The Codex manual says depth defaults to 1 and raising it can increase token use, latency, and local resource consumption.`
      : agentThreadsConfigured || agentDepthConfigured
        ? `Subagent settings are configured conservatively: ${agentMaxThreads.toLocaleString()} open thread${agentMaxThreads === 1 ? "" : "s"} with depth ${agentMaxDepth.toLocaleString()}.`
        : "Subagent fan-out is using Codex defaults: 6 open agent threads and depth 1.";
  const trustedProjectCount = Number(codexConfig?.trustedProjectCount || 0);
  const enabledPluginCount = Number(codexConfig?.enabledPluginCount || 0);
  const enabledMcpCount = Number(codexConfig?.enabledMcpCount || 0);
  const requiredMcpCount = Number(codexConfig?.requiredMcpCount || 0);
  const workflowAdvice = [
    {
      id: "live-process-load",
      label: "Live Codex Load",
      value: processReady ? `${processCount.toLocaleString()} procs` : "Unknown",
      tone: processSummary?.tone || "medium",
      action: processReady ? processSummary.action || "Review load" : "Run local ps",
      priority: processLoaded ? (processSummary.tone === "high" ? 94 : 78) : 24,
      detail: processDetail,
    },
    {
      id: "agent-fanout",
      label: "Agent Fan-out",
      value: `${agentMaxThreads.toLocaleString()} / depth ${agentMaxDepth.toLocaleString()}`,
      tone: agentFanoutRisk ? (agentFanoutHeavy ? "high" : "medium") : "low",
      action: agentFanoutRisk ? "Cap subagents" : "Keep scoped",
      priority: agentFanoutHeavy ? 92 : agentFanoutRisk ? 76 : 26,
      detail: agentFanoutDetail,
    },
    {
      id: "project-playbooks",
      label: "Project Playbooks",
      value: existingProjectCount ? `${projectReadyCount}/${existingProjectCount}` : "None",
      tone: projectGapCount || currentProject?.ready === false ? "medium" : "low",
      action: currentProject?.ready === false ? "Add repo guidance" : projectGapCount ? "Improve top projects" : "Keep current",
      priority: currentProject?.ready === false ? 86 : projectGapCount ? 66 : 22,
      detail: projectDetail,
    },
    {
      id: "runtime-version",
      label: "Codex Runtime",
      value: runtime?.versionMismatch ? "Mismatch" : runtime?.cliVersion || runtime?.appVersion || "Missing",
      tone: runtime?.versionMismatch || runtime?.status === "missing" ? "medium" : "low",
      action: runtime?.versionMismatch ? "Align versions" : "Keep current",
      priority: runtime?.versionMismatch ? 88 : runtime?.status === "missing" ? 62 : 20,
      detail: runtimeDetail,
    },
    {
      id: "thread-ceiling",
      label: "Thread Ceiling",
      value: threadLimit ? threadLimit.toLocaleString() : "Default",
      tone: threadLimit >= 128 ? "medium" : "low",
      action: threadLimit >= 128 ? "Avoid same-file overlap" : "Keep work scoped",
      priority: threadLimit >= 128 ? 70 : 18,
      detail:
        threadLimit >= 128
          ? "Your per-session thread ceiling is very high. The Codex manual allows parallel threads, but warns against two threads modifying the same files."
          : "Parallel threads are useful when they stay scoped and avoid editing the same files.",
    },
    {
      id: "trusted-projects",
      label: "Trusted Projects",
      value: staleTrustedProjectCount ? `${staleTrustedProjectCount}/${trustedProjectCount}` : trustedProjectCount ? trustedProjectCount.toLocaleString() : "None",
      tone: staleTrustedProjectCount || trustedProjectCount >= 20 ? "medium" : "low",
      action: staleTrustedProjectCount ? "Remove missing paths" : trustedProjectCount >= 20 ? "Review stale trust" : "Trust intentionally",
      priority: staleTrustedProjectCount ? 74 : trustedProjectCount >= 20 ? 56 : 16,
      detail:
        staleTrustedProjectCount
          ? `${staleTrustedProjectCount.toLocaleString()} trusted project path${staleTrustedProjectCount === 1 ? "" : "s"} no longer exist. Trusted project entries decide whether project .codex layers can load.`
          : trustedProjectCount >= 20
          ? "Many trusted project entries are configured. Trusted projects can load project .codex layers, so stale trust entries make behavior harder to reason about."
          : "Trusted project scope looks tidy.",
    },
    {
      id: "tool-surface",
      label: "Tool Surface",
      value: `${enabledPluginCount} / ${enabledMcpCount}`,
      tone: enabledPluginCount + enabledMcpCount > 10 ? "medium" : "low",
      action: enabledPluginCount + enabledMcpCount > 10 ? "Disable unused" : "Keep intentional",
      priority: enabledPluginCount + enabledMcpCount > 10 ? 48 : 14,
      detail: `${enabledPluginCount.toLocaleString()} plugin${enabledPluginCount === 1 ? "" : "s"} and ${enabledMcpCount.toLocaleString()} MCP server${enabledMcpCount === 1 ? "" : "s"} are enabled. Keep only useful surfaces active for clearer runs.`,
    },
    {
      id: "required-mcp",
      label: "Required MCP",
      value: requiredMcpCount ? requiredMcpCount.toLocaleString() : "None",
      tone: requiredMcpCount ? "medium" : "low",
      action: requiredMcpCount ? "Reserve for critical" : "No startup blockers",
      priority: requiredMcpCount ? 44 : 12,
      detail:
        requiredMcpCount > 0
          ? "Required MCP servers can block startup if they fail. Use required only for tools every run truly needs."
          : "No enabled MCP server is marked required, so MCP startup should be less brittle.",
    },
  ].sort((a, b) => b.priority - a.priority);

  const recommendations = [];
  const addRecommendation = (item) => {
    if (!item?.id || recommendations.some((existing) => existing.id === item.id)) return;
    recommendations.push(item);
  };

  if (runtime?.versionMismatch) {
    addRecommendation({
      id: "runtime-version-drift",
      label: "Runtime Drift",
      value: `${runtime.cliVersion} / ${runtime.appVersion}`,
      action: "Align CLI and app",
      tone: "medium",
      priority: 96,
      detail: "Your terminal Codex and bundled Codex app binary are different versions. Align them before chasing phantom slowness or missing features.",
    });
  }

  if (authCache.needsLoginCheck) {
    addRecommendation({
      id: "auth-cache-check",
      label: "Auth Cache",
      value: authCache.label || "Check",
      action: "Run codex doctor",
      tone: "medium",
      priority: 92,
      detail:
        "Codex should reuse cached login details. If the cache is missing or empty, repeated sign-in prompts can make every run feel slower.",
    });
  }

  if (processLoaded) {
    addRecommendation({
      id: "live-process-load",
      label: "Live Codex Load",
      value: `${processCount.toLocaleString()} procs`,
      action: processSummary.action || "Close idle work",
      tone: processSummary.tone === "high" ? "high" : "medium",
      priority: processSummary.tone === "high" ? 98 : 84,
      detail:
        processSummary.tone === "high"
          ? `Codex currently has ${processCount.toLocaleString()} live processes using ${formatBytesServer(processRssBytes)}. Finish/archive idle threads and restart Codex after active work before judging deeper cleanup.`
          : `Codex currently has ${processCount.toLocaleString()} live processes using ${formatBytesServer(processRssBytes)}. Close idle threads or extra terminals if the app feels slow.`,
    });
  }

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
      action: "Mini or lower effort",
      tone: "medium",
      priority: 82,
      detail: "For quick, well-scoped work, use lower reasoning or gpt-5.4-mini. Keep gpt-5.5 with high/xhigh for hard debugging and long agentic tasks.",
    });
  }

  if (!hasFastTaskProfile && isHighEffort) {
    addRecommendation({
      id: "speed-profile-missing",
      label: "Fast Lane",
      value: "No profile",
      action: "Create speed profile",
      tone: "medium",
      priority: 76,
      detail: "Your default is tuned for deep work. Add a named speed profile so small tasks can start with mini/low settings on purpose.",
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

  if (agentFanoutRisk) {
    addRecommendation({
      id: "agent-fanout",
      label: "Agent Fan-out",
      value: `${agentMaxThreads.toLocaleString()} / depth ${agentMaxDepth.toLocaleString()}`,
      action: "Cap subagents",
      tone: agentFanoutHeavy ? "high" : "medium",
      priority: agentFanoutHeavy ? 86 : 70,
      detail: agentFanoutDetail,
    });
  }

  if (currentProject && !currentProject.ready) {
    addRecommendation({
      id: "project-playbook",
      label: "Project Playbook",
      value: `${currentProject.score}/100`,
      action: currentProject.hasAgents ? "Add setup/actions" : "Add AGENTS.md",
      tone: "medium",
      priority: 72,
      detail: projectDetail,
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

  if (staleTrustedProjectCount > 0) {
    addRecommendation({
      id: "stale-trusted-projects",
      label: "Trust Map",
      value: staleTrustedProjectCount.toLocaleString(),
      action: "Remove missing paths",
      tone: "medium",
      priority: 64,
      detail: "Trusted project paths that no longer exist make Codex configuration harder to reason about. Clean stale entries from config.toml.",
    });
  }

  if (!globalGuidanceReady) {
    addRecommendation({
      id: "codex-guidance",
      label: "Guidance",
      value: emptyGlobalGuidance ? "Empty" : "Missing",
      action: "Add useful AGENTS.md",
      tone: "medium",
      priority: 60,
      detail: emptyGlobalGuidance
        ? "AGENTS.md exists but is empty, so Codex skips it. Add repeated preferences and verification rules that save future turns."
        : "Add concise global or project AGENTS guidance so recurring preferences do not need to be repeated.",
    });
  }

  if (codexConfig?.webSearchMode === "live") {
    addRecommendation({
      id: "web-search-live",
      label: "Web Search",
      value: "Live",
      action: "Use cached/local",
      tone: "medium",
      priority: 50,
      detail: "Live web search is useful for current facts, but cached or disabled search can make local-only coding runs steadier.",
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
  const fixKit = buildDoctorFixKit(scan, codexConfig, runtime, {
    activeReliefBytes,
    logBytes,
    logWalBytes,
    processSummary,
  });

  const headline =
    processSummary?.tone === "high"
      ? `Codex has ${processCount.toLocaleString()} live helper processes using ${formatBytesServer(processRssBytes)}.`
      : runtime?.versionMismatch
      ? `Codex versions differ: CLI ${runtime.cliVersion}, app ${runtime.appVersion}.`
      : activeReliefBytes > 1024 ** 3
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
    desktopServiceTier: desktopTier,
    displayServiceTier: displayTier,
    fastModeFeature,
    shellSnapshot,
    goalsFeature,
    webSearchMode,
    maxConcurrentThreadsPerSession: codexConfig?.maxConcurrentThreadsPerSession || null,
    agentMaxThreads: codexConfig?.agentMaxThreads ?? null,
    agentMaxThreadsEffective: agentMaxThreads,
    agentMaxDepth: codexConfig?.agentMaxDepth ?? null,
    agentMaxDepthEffective: agentMaxDepth,
    agentJobMaxRuntimeSeconds: codexConfig?.agentJobMaxRuntimeSeconds ?? null,
    authCache,
    projectReadiness,
    profileCount: codexConfig?.profileCount || 0,
    hasFastTaskProfile,
    fastTaskProfileNames,
    hasSparkProfile,
    hasMiniProfile,
    trustedProjectCount: codexConfig?.trustedProjectCount || 0,
    staleTrustedProjectCount,
    enabledPluginCount,
    enabledMcpCount,
    requiredMcpCount,
    runtime,
    processSummary,
    cards,
    profiles,
    configAdvice,
    workflowAdvice,
    recommendations,
    fixKit,
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
    runtime,
    processSummary,
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
    getCodexRuntimeSummary(),
    getCodexProcessSummary(),
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
    runtime,
    processes: processSummary,
    categories,
    largestSessionFiles,
  };

  addHotspots(scan);
  scan.smartPlan = buildSmartPlan(scan, { ...options, days: archiveChoice.days, archiveChoice });
  scan.codexDoctor = buildCodexDoctor(scan, codexConfig, runtime, processSummary);
  return scan;
}

function clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function localScoreBreakdown(metrics) {
  const gb = (bytes) => (Number(bytes) || 0) / 1024 ** 3;
  const components = [
    {
      id: "active-sessions",
      label: "Active Sessions",
      points: Math.min(28, gb(metrics.activeSessionBytes) * 1.2),
      value: formatBytesServer(metrics.activeSessionBytes),
      detail: "Active transcript weight inside ~/.codex/sessions.",
    },
    {
      id: "logs",
      label: "Logs",
      points: Math.min(22, gb(metrics.logBytes) * 2.5),
      value: formatBytesServer(metrics.logBytes),
      detail: "Local log database size.",
    },
    {
      id: "log-wal",
      label: "Log WAL",
      points: Math.min(18, gb(metrics.logWalBytes) * 12),
      value: formatBytesServer(metrics.logWalBytes),
      detail: "SQLite write-ahead log waiting to be checkpointed.",
    },
    {
      id: "large-files",
      label: "Large Files",
      points: Math.min(18, Number(metrics.oversizedActiveFiles || 0) * 0.25),
      value: `${Number(metrics.oversizedActiveFiles || 0).toLocaleString()} files`,
      detail: "Active transcript files over 50 MB.",
    },
    {
      id: "archived-active",
      label: "Archived In Active",
      points: Math.min(10, Number(metrics.archivedFilesInSessions || 0) * 0.2),
      value: `${Number(metrics.archivedFilesInSessions || 0).toLocaleString()} files`,
      detail: "Archived transcripts still stored under active sessions.",
    },
    {
      id: "stale-threads",
      label: "Stale Threads",
      points: Math.min(10, Number(metrics.staleThreads || 0) * 0.08),
      value: `${Number(metrics.staleThreads || 0).toLocaleString()} threads`,
      detail: "Unarchived threads older than the active cutoff.",
    },
  ].map((component) => ({
    ...component,
    points: Number(component.points.toFixed(1)),
  }));
  const totalPenalty = components.reduce((total, component) => total + component.points, 0);
  const score = Math.round(clampNumber(100 - totalPenalty, 0, 100));
  return {
    score,
    totalPenalty: Number(totalPenalty.toFixed(1)),
    components: components.sort((a, b) => b.points - a.points),
  };
}

function benchmarkScore(metrics) {
  return localScoreBreakdown(metrics).score;
}

function benchmarkLiveScore(metrics) {
  let score = benchmarkScore(metrics);
  score -= Math.min(14, metrics.scanMs / 900);
  score -= Math.min(12, metrics.stateQueryMs / 40);
  score -= Math.min(12, metrics.logQueryMs / 80);
  score -= Math.min(14, Math.max(0, Number(metrics.processCount || 0) - 10) * 0.3);
  score -= Math.min(8, ((Number(metrics.processRssBytes || 0) / 1024 ** 3) || 0) * 1.2);
  score -= Math.min(8, Math.max(0, Number(metrics.agentMaxDepth || 1) - 1) * 4);
  score -= Math.min(6, Math.max(0, Number(metrics.agentMaxThreads || 6) - 12) * 0.45);
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
  if (metrics.processCount >= 24) {
    guidance.push(
      `Close idle Codex work: ${Number(metrics.processCount).toLocaleString()} live Codex process${metrics.processCount === 1 ? "" : "es"} are using ${formatBytesServer(metrics.processRssBytes)}.`,
    );
  } else if (metrics.processCount >= 12) {
    guidance.push(`Codex has ${Number(metrics.processCount).toLocaleString()} live processes; close idle threads before judging cleanup.`);
  }
  if (metrics.agentMaxDepth > 1) {
    guidance.push(
      `Cap subagent depth back toward 1 unless you deliberately need recursive delegation; depth ${Number(metrics.agentMaxDepth).toLocaleString()} can add latency and resource load.`,
    );
  } else if (metrics.agentMaxThreads >= 12) {
    guidance.push(`Keep subagent fan-out scoped; agents.max_threads is ${Number(metrics.agentMaxThreads).toLocaleString()}.`);
  }
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

function scoreMetricsFromScan(scan) {
  const categories = scan?.categories || {};
  return {
    scoreModel: "local-state-v2",
    activeSessionBytes: categories.activeSessions?.bytes || 0,
    logBytes: scan?.logs?.bytes || 0,
    logWalBytes: scan?.logs?.walBytes || 0,
    oversizedActiveFiles: categories.activeSessions?.oversized50mb || 0,
    archivedFilesInSessions: categories.archivedSessionsInActiveTree?.fileCount || 0,
    staleThreads: Number(scan?.state?.threads?.activeStale ?? scan?.state?.threads?.activeOlder7d ?? 0),
  };
}

function buildScoreProjection(scan, { steps = [], logBytes = 0, logWalBytes = 0 } = {}) {
  const hasStep = (id) => steps.some((step) => step.id === id && !step.disabled && !step.confirmRequired);
  const categories = scan?.categories || {};
  const currentMetrics = scoreMetricsFromScan(scan);
  const projectedMetrics = { ...currentMetrics };

  if (hasStep("archiveStaleThreads")) {
    projectedMetrics.activeSessionBytes = Math.max(0, projectedMetrics.activeSessionBytes - (categories.activeStaleSessions?.bytes || 0));
    projectedMetrics.oversizedActiveFiles = Math.max(0, projectedMetrics.oversizedActiveFiles - (categories.activeStaleSessions?.oversized50mb || 0));
    projectedMetrics.staleThreads = 0;
  }

  if (hasStep("migrateArchivedSessions")) {
    projectedMetrics.activeSessionBytes = Math.max(0, projectedMetrics.activeSessionBytes - (categories.archivedSessionsInActiveTree?.bytes || 0));
    projectedMetrics.archivedFilesInSessions = 0;
  }

  if (hasStep("pruneLogs")) {
    projectedMetrics.logWalBytes = 0;
    projectedMetrics.logBytes = logBytes > 0 ? Math.min(logBytes, projectedMetrics.logBytes) : projectedMetrics.logBytes;
  }

  const current = localScoreBreakdown(currentMetrics);
  const projected = localScoreBreakdown(projectedMetrics);
  return {
    confidence: "Estimate",
    currentScore: current.score,
    projectedScore: projected.score,
    delta: projected.score - current.score,
    current,
    projected,
    assumptions: [
      hasStep("archiveStaleThreads") ? "Stale active sessions leave active history." : null,
      hasStep("migrateArchivedSessions") ? "Archived transcripts leave active sessions." : null,
      hasStep("pruneLogs") ? "Log WAL checkpoints to zero; retained log size is estimated conservatively." : null,
    ].filter(Boolean),
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
  let headline = "No urgent local slowdown detected";
  if (activeFolderReliefBytes > 0) {
    headline = `Move ${formatBytesServer(activeFolderReliefBytes)} out of active history`;
  } else if (logBytes > 1024 ** 3) {
    headline = `Compact ${formatBytesServer(logBytes)} of logs`;
  } else if (destructiveSteps.length) {
    headline = `Recover ${formatBytesServer(deletePreviewBytes)} from old archived data`;
  }
  const scoreProjection = buildScoreProjection(scan, { steps, logBytes, logWalBytes });
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
    scoreProjection,
    impacts: [
      {
        label: "Projected Score",
        value:
          scoreProjection.delta > 0
            ? `${scoreProjection.currentScore} -> ${scoreProjection.projectedScore}`
            : `${scoreProjection.currentScore}`,
        detail:
          scoreProjection.delta > 0
            ? `Estimated +${scoreProjection.delta} local readiness point${scoreProjection.delta === 1 ? "" : "s"} after non-delete cleanup.`
            : "No score lift is projected from the currently visible non-delete cleanup steps.",
        tone: scoreProjection.delta > 0 ? "high" : "low",
      },
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
    "processCount",
    "processRssBytes",
    "processHelperCount",
    "agentMaxThreads",
    "agentMaxDepth",
  ];
  return Object.fromEntries(keys.map((key) => [key, current[key] - (previous.metrics[key] || 0)]));
}

function summarizeBenchmarkEntry(entry) {
  if (!entry?.metrics) return null;
  return {
    generatedAt: entry.generatedAt || entry.metrics.generatedAt,
    rating: entry.rating || benchmarkRating(entry.metrics.score),
    liveRating: entry.liveRating || benchmarkRating(entry.metrics.liveScore),
    score: entry.metrics.score,
    liveScore: entry.metrics.liveScore,
    scanMs: entry.metrics.scanMs,
    stateQueryMs: entry.metrics.stateQueryMs,
    logQueryMs: entry.metrics.logQueryMs,
    activeSessionBytes: entry.metrics.activeSessionBytes,
    logBytes: entry.metrics.logBytes,
    logWalBytes: entry.metrics.logWalBytes,
    staleThreads: entry.metrics.staleThreads,
    oversizedActiveFiles: entry.metrics.oversizedActiveFiles,
    processCount: entry.metrics.processCount || 0,
    processHelperCount: entry.metrics.processHelperCount || 0,
    processRssBytes: entry.metrics.processRssBytes || 0,
    agentMaxThreads: entry.metrics.agentMaxThreads ?? 6,
    agentMaxDepth: entry.metrics.agentMaxDepth ?? 1,
    scoreModel: entry.metrics.scoreModel,
    scoreBreakdown: entry.metrics.scoreBreakdown || localScoreBreakdown(entry.metrics),
  };
}

export async function benchmarkHistory(limit = 12) {
  const rawEntries = await readJsonlEntries(paths.benchmarkLog, normalizeDays(limit, 12, { min: 1, max: 50 }));
  const entries = rawEntries.map(summarizeBenchmarkEntry).filter(Boolean);
  const latest = entries[0] || null;
  const comparable = latest ? entries.filter((entry) => entry.scoreModel === latest.scoreModel) : entries;
  const oldest = comparable[comparable.length - 1] || null;
  const previous = comparable[1] || null;
  const best = comparable.reduce((winner, entry) => (!winner || entry.score > winner.score ? entry : winner), null);
  const deltas = latest && oldest && latest !== oldest
    ? {
        score: latest.score - oldest.score,
        liveScore: latest.liveScore - oldest.liveScore,
        scanMs: latest.scanMs - oldest.scanMs,
        stateQueryMs: latest.stateQueryMs - oldest.stateQueryMs,
        logQueryMs: latest.logQueryMs - oldest.logQueryMs,
        activeSessionBytes: latest.activeSessionBytes - oldest.activeSessionBytes,
        logBytes: latest.logBytes - oldest.logBytes,
        logWalBytes: latest.logWalBytes - oldest.logWalBytes,
        staleThreads: latest.staleThreads - oldest.staleThreads,
        processCount: latest.processCount - oldest.processCount,
        processRssBytes: latest.processRssBytes - oldest.processRssBytes,
      }
    : null;
  const previousDeltas = latest && previous
    ? {
        score: latest.score - previous.score,
        liveScore: latest.liveScore - previous.liveScore,
        scanMs: latest.scanMs - previous.scanMs,
        stateQueryMs: latest.stateQueryMs - previous.stateQueryMs,
        logQueryMs: latest.logQueryMs - previous.logQueryMs,
        processCount: latest.processCount - previous.processCount,
      }
    : null;
  const trend =
    !deltas ? "baseline" : deltas.score > 0 ? "improved" : deltas.score < 0 ? "declined" : "flat";
  const summary =
    !latest
      ? "No speed checks have been saved yet."
      : !deltas
        ? `Baseline saved at ${latest.score}/100. Run another check after cleanup to prove the change.`
        : trend === "improved"
          ? `Score improved by ${deltas.score} point${deltas.score === 1 ? "" : "s"} since the first comparable check.`
          : trend === "declined"
            ? `Score is ${Math.abs(deltas.score)} point${Math.abs(deltas.score) === 1 ? "" : "s"} lower than the first comparable check.`
            : "Score is flat against the first comparable check; compare timings and state weight below.";

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    count: entries.length,
    comparableCount: comparable.length,
    trend,
    summary,
    latest,
    previous,
    oldest,
    best,
    deltas,
    previousDeltas,
    entries,
  };
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
    processCount: scan.processes?.processCount || 0,
    processHelperCount: scan.processes?.helperCount || 0,
    processRssBytes: scan.processes?.rssBytes || 0,
    agentMaxThreads: scan.codexConfig?.agentMaxThreadsEffective ?? 6,
    agentMaxDepth: scan.codexConfig?.agentMaxDepthEffective ?? 1,
  };
  metrics.scoreBreakdown = localScoreBreakdown(metrics);
  metrics.score = metrics.scoreBreakdown.score;
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
  entry.history = await benchmarkHistory(12);
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

    if (req.method === "POST" && url.pathname === "/api/official-doctor") {
      sendJson(res, 200, await runOfficialDoctor());
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/benchmark-history") {
      sendJson(res, 200, await benchmarkHistory(Number(url.searchParams.get("limit") || 12)));
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
