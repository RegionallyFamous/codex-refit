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
const adminConfigRoot = path.resolve(process.env.CODEX_REFIT_ADMIN_CONFIG_DIR || "/etc/codex");
const hookEvents = [
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PreCompact",
  "PostCompact",
  "UserPromptSubmit",
  "SubagentStop",
  "Stop",
  "SessionStart",
  "SubagentStart",
];
const turnScopedHookEvents = new Set([
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PreCompact",
  "PostCompact",
  "UserPromptSubmit",
  "SubagentStop",
  "Stop",
]);
const skillCatalogBudgetChars = 8000;
const longSkillDescriptionChars = 600;
const largeSkillFileBytes = 24 * 1024;
const maxSkillCatalogFiles = 600;
const maxSkillCatalogDirs = 4000;
const maxSkillCatalogDepth = 10;
const defaultProjectDocMaxBytes = 32 * 1024;
const largeInstructionFileBytes = 12 * 1024;
const builtInAgentNames = new Set(["default", "worker", "explorer"]);

const paths = {
  codexHome,
  sessions: path.join(codexHome, "sessions"),
  archivedSessions: path.join(codexHome, "archived_sessions"),
  maintenanceArchive: path.join(codexHome, "maintenance-archive"),
  generatedImages: path.join(codexHome, "generated_images"),
  generatedImagesArchive: path.join(codexHome, "archived_generated_images"),
  memories: path.join(codexHome, "memories"),
  memoriesExtensions: path.join(codexHome, "memories_extensions"),
  customPrompts: path.join(codexHome, "prompts"),
  customAgents: path.join(codexHome, "agents"),
  userRules: path.join(codexHome, "rules"),
  codexSkills: path.join(codexHome, "skills"),
  codexSystemSkills: path.join(codexHome, "skills", ".system"),
  userAgentSkills: path.join(homeDir, ".agents", "skills"),
  adminConfigRoot,
  adminSkills: path.join(adminConfigRoot, "skills"),
  adminRules: path.join(adminConfigRoot, "rules"),
  managedConfigToml: path.join(adminConfigRoot, "managed_config.toml"),
  requirementsToml: path.join(adminConfigRoot, "requirements.toml"),
  pluginCache: path.join(codexHome, "plugins", "cache"),
  configToml: path.join(codexHome, "config.toml"),
  authJson: path.join(codexHome, "auth.json"),
  globalAgentsOverride: path.join(codexHome, "AGENTS.override.md"),
  globalAgents: path.join(codexHome, "AGENTS.md"),
  globalHooks: path.join(codexHome, "hooks.json"),
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

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
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

function normalizeConfigKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replaceAll("-", "_");
}

function buildApprovalFlowSummary(values = {}) {
  const approvalPolicy = values.approval_policy ?? null;
  const approvalReviewer = values.approvals_reviewer || "user";
  const policyText = String(approvalPolicy || "default");
  const normalizedPolicy = normalizeConfigKey(policyText);
  const normalizedReviewer = normalizeConfigKey(approvalReviewer);
  const granularPolicy = /\bgranular\b/i.test(policyText);
  const neverPolicy = normalizedPolicy === "never";
  const interactiveApprovals = !neverPolicy;
  const autoReviewApplies = interactiveApprovals && normalizedReviewer === "auto_review";
  const label = autoReviewApplies
    ? "Auto review"
    : neverPolicy
      ? "No prompts"
      : granularPolicy
        ? "Granular"
        : approvalPolicy || "Default";
  const tone = autoReviewApplies || interactiveApprovals ? "medium" : "low";
  const action = autoReviewApplies ? "Check latency" : neverPolicy ? "Fast, high-trust" : "Review prompts";
  const priority = autoReviewApplies ? 82 : neverPolicy ? 30 : granularPolicy ? 66 : 72;
  const detail = autoReviewApplies
    ? "Automatic approval review can reduce manual interruptions, but the Codex manual says it uses extra model calls for eligible interactive approval requests."
    : neverPolicy
      ? "Approval prompts are not expected from Codex itself. Use this only for trusted work because it reduces safety stops."
      : granularPolicy
        ? "Granular approval policy can keep some prompt categories interactive while rejecting others automatically. Tune it for trust and speed together."
        : "Approval prompts can interrupt fast runs. Use /permissions or config only when the trust/safety tradeoff is right.";

  return {
    approvalPolicy,
    approvalReviewer,
    granularPolicy,
    neverPolicy,
    interactiveApprovals,
    autoReviewApplies,
    label,
    tone,
    action,
    priority,
    detail,
  };
}

function effectiveWebSearchMode(values = {}) {
  const configured = normalizeConfigKey(values.web_search || "");
  if (["live", "cached", "disabled"].includes(configured)) return configured;
  if (values.web_search === false) return "disabled";
  if (values.web_search_request === true) return "live";
  if (values.web_search_cached === true || values.web_search === true) return "cached";
  const sandboxMode = normalizeConfigKey(values.sandbox_mode || "workspace-write");
  const fullAccess = sandboxMode === "danger_full_access" || sandboxMode === "dangerously_bypass_approvals_and_sandbox";
  return fullAccess ? "live" : "cached";
}

function legacyWebSearchKeys(values = {}) {
  return [
    typeof values.web_search === "boolean" ? "web_search" : null,
    values.web_search_cached !== undefined ? "web_search_cached" : null,
    values.web_search_request !== undefined ? "web_search_request" : null,
  ].filter(Boolean);
}

function webSearchModeLabel(mode, configured = false) {
  const normalized = normalizeConfigKey(mode || "cached");
  const label = normalized === "live" ? "Live" : normalized === "disabled" ? "Disabled" : "Cached";
  return configured ? label : `${label} default`;
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
    const sectionMatch = line.match(/^\[\[?([^\]]+)\]?\]$/);
    if (sectionMatch) {
      section = sectionMatch[1];
      sections.push(section);
      continue;
    }
    const valueMatch = line.match(/^("[^"]+"|'[^']+'|[A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (!valueMatch) continue;
    const keyName = unquoteTomlTablePath(valueMatch[1].replace(/^["']|["']$/g, ""));
    const key = section ? `${section}.${keyName}` : keyName;
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

function mcpServerDescriptors(sections) {
  const descriptors = [];
  const seen = new Set();
  const pushDescriptor = (descriptor) => {
    if (seen.has(descriptor.section)) return;
    seen.add(descriptor.section);
    descriptors.push(descriptor);
  };

  for (const section of sections) {
    if (isTopLevelMcpSection(section)) {
      pushDescriptor({
        section,
        scope: "user",
        name: section.slice("mcp_servers.".length),
        pluginSection: null,
      });
      continue;
    }

    const pluginMatch = section.match(/^plugins\."([^"]+)"\.mcp_servers\.([A-Za-z0-9_-]+)$/);
    if (pluginMatch) {
      pushDescriptor({
        section,
        scope: "plugin",
        name: pluginMatch[2],
        pluginSection: `plugins."${pluginMatch[1]}"`,
      });
    }
  }

  return descriptors;
}

function tomlArrayStringNames(value) {
  if (value === undefined || value === null) return [];
  const text = String(value);
  const objectNames = [...text.matchAll(/\bname\s*=\s*["']([^"']+)["']/g)].map((match) => match[1]);
  const withoutObjects = text.replace(/\{[^}]*\}/g, "");
  const stringNames = [...withoutObjects.matchAll(/["']([^"']+)["']/g)].map((match) => match[1]);
  return [...new Set([...stringNames, ...objectNames].filter(Boolean))];
}

function tomlInlineTableValues(value) {
  if (value === undefined || value === null) return [];
  return [...String(value).matchAll(/=\s*["']([^"']+)["']/g)].map((match) => match[1]).filter(Boolean);
}

function tomlInlineTableKeys(value) {
  if (value === undefined || value === null) return [];
  return [...String(value).matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*=/g)].map((match) => match[1]).filter(Boolean);
}

const managedSpeedKeys = new Set([
  "model",
  "model_reasoning_effort",
  "reasoning_effort",
  "model_verbosity",
  "service_tier",
  "desktop.default-service-tier",
  "approval_policy",
  "approvals_reviewer",
  "sandbox_mode",
  "web_search",
  "web_search_cached",
  "web_search_request",
  "model_context_window",
  "model_auto_compact_token_limit",
  "tool_output_token_limit",
  "project_doc_max_bytes",
  "max_concurrent_threads_per_session",
  "agents.max_threads",
  "agents.max_depth",
  "agents.job_max_runtime_seconds",
  "features.fast_mode",
  "features.shell_snapshot",
  "features.hooks",
  "features.codex_hooks",
  "features.memories",
  "features.in_app_browser",
  "features.browser_use",
  "features.computer_use",
]);

const requirementControlKeys = new Set([
  "allowed_approval_policies",
  "allowed_approvals_reviewers",
  "allowed_sandbox_modes",
  "allowed_web_search_modes",
  "guardian_policy_config",
  "enforce_residency",
  "plugin_sharing",
  "allow_managed_hooks_only",
]);

function emptyManagedConfigSummary() {
  return {
    status: "ready",
    tone: "low",
    label: "None",
    action: "No override",
    detail:
      "No file-based Codex managed requirements or managed defaults were found in the documented local system paths. Cloud-managed and MDM settings are not decoded by Refit.",
    active: false,
    managedDefaultExists: false,
    requirementsExists: false,
    managedKeyCount: 0,
    requirementKeyCount: 0,
    managedSpeedKeyCount: 0,
    requirementSpeedKeyCount: 0,
    conflictCount: 0,
    managedDefaultConflictCount: 0,
    requirementConflictCount: 0,
    managedMcpCount: 0,
    managedMcpBlockedCount: 0,
    managedHookCount: 0,
    featurePinCount: 0,
    legacyRequirementKeyCount: 0,
    impactedKeys: [],
    conflictKeys: [],
    blockedMcpNames: [],
    sources: [],
  };
}

function isManagedSpeedKey(key) {
  const normalized = String(key || "");
  return (
    managedSpeedKeys.has(normalized) ||
    requirementControlKeys.has(normalized) ||
    normalized.startsWith("shell_environment_policy.") ||
    normalized.startsWith("mcp_servers.") ||
    normalized.startsWith("hooks.") ||
    normalized.startsWith("features.") ||
    normalized.startsWith("auto_review.") ||
    normalized.startsWith("experimental_network.") ||
    normalized.startsWith("permissions.filesystem.") ||
    normalized.startsWith("rules.")
  );
}

function sameConfigValue(left, right) {
  return String(left ?? "").trim() === String(right ?? "").trim();
}

function sanitizeConfigKeys(keys, limit = 10) {
  return [...new Set(keys.filter(Boolean).map(String))]
    .sort((a, b) => a.localeCompare(b))
    .slice(0, limit);
}

async function readManagedTomlSource(filePath, kind, label) {
  const source = {
    kind,
    label,
    path: displayPath(filePath),
    exists: false,
    readable: false,
    bytes: 0,
    modifiedAt: null,
    keyCount: 0,
    sectionCount: 0,
    speedKeyCount: 0,
    mcpServerCount: 0,
    hookCount: 0,
    featurePinCount: 0,
    error: null,
    values: {},
    sections: [],
  };

  const stats = await statOrNull(filePath);
  if (!stats?.isFile()) return source;

  source.exists = true;
  source.bytes = stats.size || 0;
  source.modifiedAt = stats.mtime?.toISOString?.() || null;

  try {
    const parsed = parseTomlSummary(await fs.readFile(filePath, "utf8"));
    const keys = Object.keys(parsed.values);
    source.readable = true;
    source.keyCount = keys.length;
    source.sectionCount = parsed.sections.length;
    source.speedKeyCount = keys.filter(isManagedSpeedKey).length;
    source.mcpServerCount = mcpServerDescriptors(parsed.sections).length;
    source.hookCount =
      keys.filter((key) => key.startsWith("hooks.")).length +
      parsed.sections.filter((section) => section.startsWith("hooks.")).length;
    source.featurePinCount = keys.filter((key) => key.startsWith("features.")).length;
    source.values = parsed.values;
    source.sections = parsed.sections;
  } catch (error) {
    source.error = error.message;
  }

  return source;
}

function allowedValueConflict(values, requirementKey, userKey, userValues) {
  if (userValues[userKey] === undefined || values[requirementKey] === undefined) return false;
  const allowed = tomlArrayStringNames(values[requirementKey]).map((value) => normalizeConfigKey(value));
  const configured = normalizeConfigKey(userValues[userKey]);
  if (requirementKey === "allowed_web_search_modes" && configured === "disabled") return false;
  if (!allowed.length) return Boolean(configured);
  return Boolean(configured && !allowed.includes(configured));
}

function allowedWebSearchModeConflict(requirementValues = {}, userValues = {}) {
  if (requirementValues.allowed_web_search_modes === undefined) return false;
  const configuredByAnyKey =
    userValues.web_search !== undefined ||
    userValues.web_search_cached !== undefined ||
    userValues.web_search_request !== undefined;
  if (!configuredByAnyKey) return false;
  const configured = effectiveWebSearchMode(userValues);
  if (configured === "disabled") return false;
  const allowed = tomlArrayStringNames(requirementValues.allowed_web_search_modes).map((value) => normalizeConfigKey(value));
  if (!allowed.length) return true;
  return !allowed.includes(configured);
}

function managedMcpBlockedNames(requirementSections, userSections) {
  const requirementDescriptors = mcpServerDescriptors(requirementSections);
  const mcpAllowlistPresent = requirementSections.some((section) => section.startsWith("mcp_servers."));
  if (!mcpAllowlistPresent) return [];

  const allowedNames = new Set(requirementDescriptors.map((descriptor) => descriptor.name));
  const userNames = mcpServerDescriptors(userSections)
    .filter((descriptor) => descriptor.scope === "user")
    .map((descriptor) => descriptor.name);
  return sanitizeConfigKeys(userNames.filter((name) => !allowedNames.has(name)), 8);
}

async function getManagedConfigSummary({ userValues = {}, userSections = [] } = {}) {
  const [managedSource, requirementsSource] = await Promise.all([
    readManagedTomlSource(paths.managedConfigToml, "managed-defaults", "Managed defaults"),
    readManagedTomlSource(paths.requirementsToml, "requirements", "Requirements"),
  ]);
  const managedValues = managedSource.values || {};
  const requirementValues = requirementsSource.values || {};
  const managedKeys = Object.keys(managedValues);
  const requirementKeys = Object.keys(requirementValues);
  const managedDefaultConflictKeys = managedKeys.filter(
    (key) => userValues[key] !== undefined && !sameConfigValue(managedValues[key], userValues[key]),
  );
  const requirementConflictKeys = new Set(
    requirementKeys.filter((key) => userValues[key] !== undefined && !sameConfigValue(requirementValues[key], userValues[key])),
  );

  if (allowedValueConflict(requirementValues, "allowed_approval_policies", "approval_policy", userValues)) {
    requirementConflictKeys.add("approval_policy");
  }
  if (allowedValueConflict(requirementValues, "allowed_approvals_reviewers", "approvals_reviewer", userValues)) {
    requirementConflictKeys.add("approvals_reviewer");
  }
  if (allowedValueConflict(requirementValues, "allowed_sandbox_modes", "sandbox_mode", userValues)) {
    requirementConflictKeys.add("sandbox_mode");
  }
  if (
    allowedValueConflict(requirementValues, "allowed_web_search_modes", "web_search", userValues) ||
    allowedWebSearchModeConflict(requirementValues, userValues)
  ) {
    requirementConflictKeys.add("web_search");
  }

  const legacyRequirementKeys = ["approval_policy", "sandbox_mode"].filter((key) => managedValues[key] !== undefined);
  for (const key of legacyRequirementKeys) {
    if (userValues[key] !== undefined && !sameConfigValue(managedValues[key], userValues[key])) requirementConflictKeys.add(key);
  }

  const blockedMcpNames = managedMcpBlockedNames(requirementsSource.sections || [], userSections || []);
  if (blockedMcpNames.length) requirementConflictKeys.add("mcp_servers");

  const managedSpeedKeyCount = managedKeys.filter(isManagedSpeedKey).length;
  const requirementSpeedKeyCount = requirementKeys.filter(isManagedSpeedKey).length;
  const managedMcpCount = mcpServerDescriptors(requirementsSource.sections || []).length;
  const managedHookCount =
    Number(requirementsSource.hookCount || 0) +
    Number(managedSource.hookCount || 0) +
    (requirementValues.allow_managed_hooks_only === true ? 1 : 0);
  const featurePinCount = Number(requirementsSource.featurePinCount || 0);
  const conflictKeys = sanitizeConfigKeys([...managedDefaultConflictKeys, ...requirementConflictKeys], 12);
  const impactedKeys = sanitizeConfigKeys(
    [...managedKeys, ...requirementKeys, ...legacyRequirementKeys, ...conflictKeys].filter(isManagedSpeedKey),
    14,
  );
  const conflictCount = managedDefaultConflictKeys.length + requirementConflictKeys.size;
  const active = managedSource.exists || requirementsSource.exists;
  const highLoad = conflictCount > 0 || blockedMcpNames.length > 0 || managedHookCount >= 3;
  const mediumLoad =
    highLoad ||
    active ||
    managedSpeedKeyCount + requirementSpeedKeyCount > 0 ||
    managedMcpCount > 0 ||
    featurePinCount > 0 ||
    legacyRequirementKeys.length > 0;
  const tone = highLoad ? "high" : mediumLoad ? "medium" : "low";
  const label = !active
    ? "None"
    : requirementsSource.exists && managedSource.exists
      ? "Defaults + rules"
      : requirementsSource.exists
        ? "Requirements"
        : "Managed defaults";
  const action =
    tone === "low"
      ? "No override"
      : conflictCount
        ? "Check admin settings"
        : managedHookCount
          ? "Review managed hooks"
          : "Know the layer";
  const detail =
    tone === "low"
      ? emptyManagedConfigSummary().detail
      : [
          "Codex can apply organization or device-managed settings before your local config takes effect.",
          managedSource.exists
            ? `Managed defaults are present at ${displayPath(paths.managedConfigToml)} with ${managedKeys.length.toLocaleString()} key${managedKeys.length === 1 ? "" : "s"}.`
            : null,
          requirementsSource.exists
            ? `Requirements are present at ${displayPath(paths.requirementsToml)} with ${requirementKeys.length.toLocaleString()} key${requirementKeys.length === 1 ? "" : "s"}.`
            : null,
          conflictCount
            ? `${conflictCount.toLocaleString()} local setting${conflictCount === 1 ? "" : "s"} appear to disagree with managed defaults or requirements.`
            : "No local conflicts were found from the file-based managed layer.",
          blockedMcpNames.length
            ? `${blockedMcpNames.length.toLocaleString()} configured MCP server${blockedMcpNames.length === 1 ? "" : "s"} may be outside the managed allowlist.`
            : null,
          managedHookCount
            ? `${managedHookCount.toLocaleString()} managed hook signal${managedHookCount === 1 ? "" : "s"} found; hooks can add latency around frequent actions.`
            : null,
          "Refit reports key names and counts only; it does not expose managed TOML values.",
        ]
          .filter(Boolean)
          .join(" ");

  return {
    status: "ready",
    tone,
    label,
    action,
    detail,
    active,
    managedDefaultExists: managedSource.exists,
    requirementsExists: requirementsSource.exists,
    managedKeyCount: managedKeys.length,
    requirementKeyCount: requirementKeys.length,
    managedSpeedKeyCount,
    requirementSpeedKeyCount,
    conflictCount,
    managedDefaultConflictCount: managedDefaultConflictKeys.length,
    requirementConflictCount: requirementConflictKeys.size,
    managedMcpCount,
    managedMcpBlockedCount: blockedMcpNames.length,
    managedHookCount,
    featurePinCount,
    legacyRequirementKeyCount: legacyRequirementKeys.length,
    impactedKeys,
    conflictKeys,
    blockedMcpNames,
    sources: [managedSource, requirementsSource].map((source) => ({
      kind: source.kind,
      label: source.label,
      path: source.path,
      exists: source.exists,
      readable: source.readable,
      bytes: source.bytes,
      modifiedAt: source.modifiedAt,
      keyCount: source.keyCount,
      sectionCount: source.sectionCount,
      speedKeyCount: source.speedKeyCount,
      mcpServerCount: source.mcpServerCount,
      hookCount: source.hookCount,
      featurePinCount: source.featurePinCount,
      error: source.error,
    })),
  };
}

const broadCommandRuleTokens = new Set([
  "bash",
  "sh",
  "zsh",
  "python",
  "python3",
  "node",
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "deno",
  "curl",
  "wget",
  "git",
  "gh",
  "make",
  "cargo",
  "go",
  "ruby",
  "perl",
  "php",
  "docker",
  "kubectl",
]);
const largeCommandRuleFileBytes = 24 * 1024;

function emptyCommandRuleSummary(rulesFeature = true) {
  return {
    status: "ready",
    tone: "low",
    label: rulesFeature ? "None" : "Disabled",
    action: rulesFeature ? "No rules" : "Feature off",
    detail: rulesFeature
      ? "No active Codex command rule files were found in user, team, or current trusted project layers."
      : "Codex command rules are disabled by features.rules = false.",
    rulesFeature,
    sourceCount: 0,
    activeSourceCount: 0,
    fileCount: 0,
    ruleCount: 0,
    promptCount: 0,
    forbiddenCount: 0,
    allowCount: 0,
    broadRuleCount: 0,
    broadPromptRuleCount: 0,
    missingJustificationCount: 0,
    testedRuleCount: 0,
    parseWarningCount: 0,
    largeFileCount: 0,
    totalBytes: 0,
    ruleFiles: [],
    broadRules: [],
    sources: [],
  };
}

function scanExpressionUntilComma(text, startIndex = 0) {
  let depth = 0;
  let quote = null;
  let escaping = false;
  let lineComment = false;
  for (let index = startIndex; index < text.length; index += 1) {
    const char = text[index];
    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (quote) {
      if (quote.length === 3) {
        if (text.startsWith(quote, index)) {
          index += 2;
          quote = null;
        }
        continue;
      }
      if (escaping) {
        escaping = false;
        continue;
      }
      if (char === "\\") {
        escaping = true;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }
    if (char === "#") {
      lineComment = true;
      continue;
    }
    if (text.startsWith('"""', index) || text.startsWith("'''", index)) {
      quote = text.slice(index, index + 3);
      index += 2;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "[" || char === "{" || char === "(") depth += 1;
    if (char === "]" || char === "}" || char === ")") depth = Math.max(0, depth - 1);
    if (char === "," && depth === 0) return index;
  }
  return text.length;
}

function extractNamedArgument(callText, name) {
  const match = new RegExp(`\\b${escapeRegExp(name)}\\s*=`).exec(callText);
  if (!match) return null;
  let start = match.index + match[0].length;
  while (start < callText.length && /\s/.test(callText[start])) start += 1;
  const end = scanExpressionUntilComma(callText, start);
  return callText.slice(start, end).trim();
}

function unquoteStarlarkString(value) {
  const text = String(value || "").trim();
  const triple = text.match(/^(["']{3})([\s\S]*)\1$/);
  if (triple) return triple[2];
  const quoted = text.match(/^["']([\s\S]*)["']$/);
  return quoted ? quoted[1] : text;
}

function starlarkStringLiterals(value) {
  const text = String(value || "");
  const tokens = [];
  const pattern = /("""|'''|"|')([\s\S]*?)\1/g;
  let match;
  while ((match = pattern.exec(text))) {
    tokens.push(match[2]);
  }
  return tokens.filter(Boolean);
}

function extractStarlarkCallBodies(text, functionName) {
  const source = String(text || "");
  const bodies = [];
  const finder = new RegExp(`\\b${escapeRegExp(functionName)}\\s*\\(`, "g");
  let match;
  while ((match = finder.exec(source))) {
    const openIndex = source.indexOf("(", match.index);
    let depth = 0;
    let quote = null;
    let escaping = false;
    let lineComment = false;
    for (let index = openIndex; index < source.length; index += 1) {
      const char = source[index];
      if (lineComment) {
        if (char === "\n") lineComment = false;
        continue;
      }
      if (quote) {
        if (quote.length === 3) {
          if (source.startsWith(quote, index)) {
            index += 2;
            quote = null;
          }
          continue;
        }
        if (escaping) {
          escaping = false;
          continue;
        }
        if (char === "\\") {
          escaping = true;
          continue;
        }
        if (char === quote) quote = null;
        continue;
      }
      if (char === "#") {
        lineComment = true;
        continue;
      }
      if (source.startsWith('"""', index) || source.startsWith("'''", index)) {
        quote = source.slice(index, index + 3);
        index += 2;
        continue;
      }
      if (char === '"' || char === "'") {
        quote = char;
        continue;
      }
      if (char === "(") depth += 1;
      if (char === ")") {
        depth -= 1;
        if (depth === 0) {
          bodies.push(source.slice(openIndex + 1, index));
          finder.lastIndex = index + 1;
          break;
        }
      }
    }
  }
  return bodies;
}

function parseCommandRulesText(text, sourcePath) {
  const ruleBodies = extractStarlarkCallBodies(text, "prefix_rule");
  const rules = ruleBodies.map((body, index) => {
    const patternExpression = extractNamedArgument(body, "pattern");
    const patternTokens = starlarkStringLiterals(patternExpression);
    const decisionExpression = extractNamedArgument(body, "decision");
    const decision = normalizeConfigKey(decisionExpression ? unquoteStarlarkString(decisionExpression) : "allow");
    const normalizedDecision = ["allow", "prompt", "forbidden"].includes(decision) ? decision : "unknown";
    const justification = extractNamedArgument(body, "justification");
    const hasJustification = Boolean(unquoteStarlarkString(justification || "").trim());
    const hasMatchExamples = extractNamedArgument(body, "match") !== null || extractNamedArgument(body, "not_match") !== null;
    const firstToken = normalizeConfigKey(patternTokens[0] || "");
    const broad = patternTokens.length <= 1 || broadCommandRuleTokens.has(firstToken);
    const broadPrompt = broad && normalizedDecision === "prompt";
    return {
      index: index + 1,
      sourcePath: displayPath(sourcePath),
      decision: normalizedDecision,
      patternTokens,
      patternLabel: patternTokens.length ? patternTokens.join(" ") : "unknown",
      broad,
      broadPrompt,
      missingJustification: ["prompt", "forbidden"].includes(normalizedDecision) && !hasJustification,
      tested: hasMatchExamples,
      parseWarning: !patternExpression || !patternTokens.length || normalizedDecision === "unknown",
    };
  });
  return rules;
}

async function summarizeCommandRuleFile(filePath, { scope, active = true } = {}) {
  const stats = await statOrNull(filePath);
  const source = {
    scope,
    path: displayPath(filePath),
    active,
    exists: Boolean(stats?.isFile()),
    bytes: stats?.isFile() ? stats.size : 0,
    modifiedAt: stats?.isFile() ? stats.mtime.toISOString() : null,
    ruleCount: 0,
    promptCount: 0,
    forbiddenCount: 0,
    allowCount: 0,
    broadRuleCount: 0,
    broadPromptRuleCount: 0,
    missingJustificationCount: 0,
    testedRuleCount: 0,
    parseWarningCount: 0,
    large: Boolean(stats?.isFile() && stats.size >= largeCommandRuleFileBytes),
    rules: [],
    error: null,
  };
  if (!stats?.isFile()) return source;
  try {
    const text = await fs.readFile(filePath, "utf8");
    const rules = parseCommandRulesText(text, filePath);
    source.rules = rules;
    source.ruleCount = rules.length;
    source.promptCount = rules.filter((rule) => rule.decision === "prompt").length;
    source.forbiddenCount = rules.filter((rule) => rule.decision === "forbidden").length;
    source.allowCount = rules.filter((rule) => rule.decision === "allow").length;
    source.broadRuleCount = rules.filter((rule) => rule.broad).length;
    source.broadPromptRuleCount = rules.filter((rule) => rule.broadPrompt).length;
    source.missingJustificationCount = rules.filter((rule) => rule.missingJustification).length;
    source.testedRuleCount = rules.filter((rule) => rule.tested).length;
    source.parseWarningCount = rules.filter((rule) => rule.parseWarning).length;
  } catch (error) {
    source.error = error.message;
    source.parseWarningCount = 1;
  }
  return source;
}

async function summarizeCommandRuleRoot(root, { scope, active = true } = {}) {
  const existsOnDisk = await exists(root);
  const summary = {
    scope,
    root: displayPath(root),
    active,
    exists: existsOnDisk,
    fileCount: 0,
    ruleCount: 0,
    promptCount: 0,
    forbiddenCount: 0,
    allowCount: 0,
    broadRuleCount: 0,
    broadPromptRuleCount: 0,
    missingJustificationCount: 0,
    testedRuleCount: 0,
    parseWarningCount: 0,
    largeFileCount: 0,
    bytes: 0,
    files: [],
    error: null,
  };
  if (!existsOnDisk) return summary;

  let entries = [];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    return { ...summary, error: error.message };
  }

  const ruleFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".rules"))
    .map((entry) => path.join(root, entry.name))
    .sort((a, b) => a.localeCompare(b));
  const files = await Promise.all(ruleFiles.map((filePath) => summarizeCommandRuleFile(filePath, { scope, active })));
  summary.files = files;
  summary.fileCount = files.length;
  summary.ruleCount = files.reduce((total, file) => total + file.ruleCount, 0);
  summary.promptCount = files.reduce((total, file) => total + file.promptCount, 0);
  summary.forbiddenCount = files.reduce((total, file) => total + file.forbiddenCount, 0);
  summary.allowCount = files.reduce((total, file) => total + file.allowCount, 0);
  summary.broadRuleCount = files.reduce((total, file) => total + file.broadRuleCount, 0);
  summary.broadPromptRuleCount = files.reduce((total, file) => total + file.broadPromptRuleCount, 0);
  summary.missingJustificationCount = files.reduce((total, file) => total + file.missingJustificationCount, 0);
  summary.testedRuleCount = files.reduce((total, file) => total + file.testedRuleCount, 0);
  summary.parseWarningCount = files.reduce((total, file) => total + file.parseWarningCount, 0);
  summary.largeFileCount = files.filter((file) => file.large).length;
  summary.bytes = files.reduce((total, file) => total + file.bytes, 0);
  return summary;
}

async function commandRuleRoots(currentProject = null) {
  const roots = [
    { scope: "user", root: paths.userRules, active: true },
    { scope: "team", root: paths.adminRules, active: true },
  ];

  if (currentProject?.path && currentProject.exists) {
    roots.push({
      scope: "current project",
      root: path.join(currentProject.path, ".codex", "rules"),
      active: true,
    });
  }

  return roots;
}

function mergeCommandRuleSources(sources, rulesFeature = true) {
  const activeSources = sources.filter((source) => source.active && source.exists);
  const ruleFiles = activeSources.flatMap((source) => source.files || []);
  const allRules = ruleFiles.flatMap((file) => file.rules || []);
  const ruleCount = allRules.length;
  const fileCount = ruleFiles.length;
  const promptCount = allRules.filter((rule) => rule.decision === "prompt").length;
  const forbiddenCount = allRules.filter((rule) => rule.decision === "forbidden").length;
  const allowCount = allRules.filter((rule) => rule.decision === "allow").length;
  const broadRuleCount = allRules.filter((rule) => rule.broad).length;
  const broadPromptRuleCount = allRules.filter((rule) => rule.broadPrompt).length;
  const missingJustificationCount = allRules.filter((rule) => rule.missingJustification).length;
  const testedRuleCount = allRules.filter((rule) => rule.tested).length;
  const parseWarningCount =
    allRules.filter((rule) => rule.parseWarning).length + activeSources.filter((source) => source.error).length + ruleFiles.filter((file) => file.error).length;
  const largeFileCount = ruleFiles.filter((file) => file.large).length;
  const totalBytes = ruleFiles.reduce((total, file) => total + file.bytes, 0);
  const broadRules = allRules
    .filter((rule) => rule.broad)
    .slice(0, 8)
    .map((rule) => ({
      decision: rule.decision,
      pattern: rule.patternLabel,
      sourcePath: rule.sourcePath,
    }));
  const highLoad = rulesFeature && (broadPromptRuleCount >= 2 || promptCount >= 20 || parseWarningCount > 0 || largeFileCount >= 2);
  const mediumLoad = rulesFeature && (highLoad || broadRuleCount >= 1 || promptCount >= 5 || forbiddenCount >= 5 || fileCount >= 6);
  const tone = !rulesFeature ? "low" : highLoad ? "high" : mediumLoad ? "medium" : "low";
  const label = !rulesFeature ? "Disabled" : ruleCount ? `${ruleCount.toLocaleString()} rule${ruleCount === 1 ? "" : "s"}` : "None";
  const action =
    !rulesFeature
      ? "Feature off"
      : tone === "low"
        ? ruleCount
          ? "Keep narrow"
          : "No rules"
        : parseWarningCount
          ? "Test rules"
          : broadRuleCount
            ? "Narrow broad rules"
            : "Review execpolicy";
  const detail =
    !rulesFeature
      ? "Codex command rules are disabled by features.rules = false."
      : ruleCount
        ? [
            "Codex scans .rules files at startup and uses prefix_rule entries to allow, prompt, or block commands outside the sandbox.",
            `Refit found ${ruleCount.toLocaleString()} active command rule${ruleCount === 1 ? "" : "s"} in ${fileCount.toLocaleString()} file${fileCount === 1 ? "" : "s"}: ${promptCount.toLocaleString()} prompt, ${forbiddenCount.toLocaleString()} forbidden, ${allowCount.toLocaleString()} allow.`,
            broadRuleCount ? `${broadRuleCount.toLocaleString()} rule${broadRuleCount === 1 ? "" : "s"} match a broad command prefix; broad prompt rules can add approval churn.` : null,
            missingJustificationCount ? `${missingJustificationCount.toLocaleString()} prompt/forbidden rule${missingJustificationCount === 1 ? "" : "s"} lack a justification.` : null,
            parseWarningCount ? `${parseWarningCount.toLocaleString()} rule file or rule${parseWarningCount === 1 ? " needs" : "s need"} testing with codex execpolicy check.` : null,
          ]
            .filter(Boolean)
            .join(" ")
        : "No active Codex command rule files were found in user, team, or current trusted project layers.";

  return {
    status: "ready",
    tone,
    label,
    action,
    detail,
    rulesFeature,
    sourceCount: sources.length,
    activeSourceCount: activeSources.length,
    fileCount,
    ruleCount,
    promptCount,
    forbiddenCount,
    allowCount,
    broadRuleCount,
    broadPromptRuleCount,
    missingJustificationCount,
    testedRuleCount,
    parseWarningCount,
    largeFileCount,
    totalBytes,
    ruleFiles: ruleFiles.map((file) => ({
      scope: file.scope,
      path: file.path,
      active: file.active,
      exists: file.exists,
      bytes: file.bytes,
      modifiedAt: file.modifiedAt,
      ruleCount: file.ruleCount,
      promptCount: file.promptCount,
      forbiddenCount: file.forbiddenCount,
      allowCount: file.allowCount,
      broadRuleCount: file.broadRuleCount,
      broadPromptRuleCount: file.broadPromptRuleCount,
      missingJustificationCount: file.missingJustificationCount,
      testedRuleCount: file.testedRuleCount,
      parseWarningCount: file.parseWarningCount,
      large: file.large,
      error: file.error,
    })),
    broadRules,
    sources: sources.map((source) => ({
      scope: source.scope,
      root: source.root,
      active: source.active,
      exists: source.exists,
      fileCount: source.fileCount,
      ruleCount: source.ruleCount,
      promptCount: source.promptCount,
      forbiddenCount: source.forbiddenCount,
      allowCount: source.allowCount,
      broadRuleCount: source.broadRuleCount,
      broadPromptRuleCount: source.broadPromptRuleCount,
      missingJustificationCount: source.missingJustificationCount,
      testedRuleCount: source.testedRuleCount,
      parseWarningCount: source.parseWarningCount,
      largeFileCount: source.largeFileCount,
      bytes: source.bytes,
      error: source.error,
    })),
  };
}

async function getCommandRuleSummary({ rulesFeature = true, currentProject = null } = {}) {
  const roots = await commandRuleRoots(currentProject);
  const sources = await Promise.all(roots.map((entry) => summarizeCommandRuleRoot(entry.root, entry)));
  return mergeCommandRuleSources(sources, rulesFeature);
}

function emptyNetworkSandboxSummary() {
  return {
    status: "ready",
    tone: "low",
    label: "Network off",
    action: "Enable per task",
    detail:
      "Workspace-write command network access is off by default. Enable it only for tasks that need installs, fetches, or external APIs.",
    sandboxMode: "workspace-write",
    commandNetworkAccess: false,
    commandNetworkConfigured: false,
    networkProxyEnabled: false,
    networkProxyConfigured: false,
    networkProxyNoEffect: false,
    unrestrictedDirectNetwork: false,
    permissionsNetworkEnabled: false,
    permissionsProfile: null,
    domainRuleCount: 0,
    domainAllowCount: 0,
    domainDenyCount: 0,
    globalAllow: false,
    localBindingAllowed: false,
    dangerousNetworkSettingCount: 0,
    writableRootCount: 0,
    tmpdirExcluded: false,
    slashTmpExcluded: false,
    webSearchMode: null,
  };
}

function tomlInlineTableEntries(value) {
  if (value === undefined || value === null) return [];
  const entries = [];
  const pattern = /(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_*.:/-]+))\s*=\s*(?:"([^"]*)"|'([^']*)'|([^,}]+))/g;
  let match;
  while ((match = pattern.exec(String(value)))) {
    const key = match[1] || match[2] || match[3];
    const rawValue = match[4] || match[5] || match[6] || "";
    entries.push({
      key,
      value: String(rawValue).trim(),
    });
  }
  return entries;
}

function sectionTableEntries(values = {}, prefix) {
  return Object.entries(values)
    .filter(([key]) => key.startsWith(`${prefix}.`))
    .map(([key, value]) => ({
      key: key.slice(prefix.length + 1),
      value,
    }));
}

function networkDomainEntries(values = {}, prefix) {
  return [
    ...tomlInlineTableEntries(values[prefix]),
    ...sectionTableEntries(values, prefix),
  ].map((entry) => ({
    key: String(entry.key || ""),
    value: normalizeConfigKey(entry.value),
  }));
}

function networkBoolean(values = {}, keys = []) {
  for (const key of keys) {
    if (values[key] !== undefined) return values[key] === true;
  }
  return false;
}

function buildNetworkSandboxSummary(values = {}, sections = []) {
  const rawSandboxMode = values.sandbox_mode || "workspace-write";
  const sandboxMode = normalizeConfigKey(rawSandboxMode);
  const workspaceWrite = sandboxMode === "workspace_write" || sandboxMode === "workspace";
  const readOnly = sandboxMode === "read_only";
  const fullAccess = sandboxMode === "danger_full_access" || sandboxMode === "dangerously_bypass_approvals_and_sandbox";
  const commandNetworkConfigured = values["sandbox_workspace_write.network_access"] !== undefined;
  const workspaceNetworkAccess = values["sandbox_workspace_write.network_access"] === true;
  const commandNetworkAccess = fullAccess || (workspaceWrite && workspaceNetworkAccess);
  const networkProxyEnabled = networkBoolean(values, ["features.network_proxy", "features.network_proxy.enabled"]);
  const networkProxyConfigured =
    values["features.network_proxy"] !== undefined ||
    Object.keys(values).some((key) => key.startsWith("features.network_proxy."));
  const defaultPermissions = values.default_permissions ? String(values.default_permissions) : null;
  const permissionProfileNames = [
    ...new Set(
      Object.keys(values)
        .map((key) => key.match(/^permissions\.([^.]+)\.network(?:\.|$)/)?.[1])
        .filter(Boolean),
    ),
  ];
  const enabledPermissionProfiles = permissionProfileNames.filter((name) => values[`permissions.${name}.network.enabled`] === true);
  const preferredPermissionProfile =
    (defaultPermissions && enabledPermissionProfiles.includes(defaultPermissions) ? defaultPermissions : null) ||
    enabledPermissionProfiles[0] ||
    null;
  const permissionsPrefix = preferredPermissionProfile ? `permissions.${preferredPermissionProfile}.network` : null;
  const permissionsNetworkEnabled = Boolean(preferredPermissionProfile);
  const permissionsNetworkMode = permissionsPrefix ? values[`${permissionsPrefix}.mode`] || "limited" : null;
  const proxyDomainEntries = networkDomainEntries(values, "features.network_proxy.domains");
  const permissionDomainEntries = permissionsPrefix ? networkDomainEntries(values, `${permissionsPrefix}.domains`) : [];
  const domainEntries = [...proxyDomainEntries, ...permissionDomainEntries];
  const domainRuleCount = domainEntries.length;
  const domainAllowCount = domainEntries.filter((entry) => entry.value === "allow" || entry.value === "true").length;
  const domainDenyCount = domainEntries.filter((entry) => entry.value === "deny" || entry.value === "false").length;
  const globalAllow = domainEntries.some((entry) => entry.key === "*" && (entry.value === "allow" || entry.value === "true"));
  const localBindingAllowed =
    values["features.network_proxy.allow_local_binding"] === true ||
    (permissionsPrefix ? values[`${permissionsPrefix}.allow_local_binding`] === true : false);
  const dangerousFlags = [
    "features.network_proxy.dangerously_allow_non_loopback_proxy",
    "features.network_proxy.dangerously_allow_all_unix_sockets",
    permissionsPrefix ? `${permissionsPrefix}.dangerously_allow_non_loopback_proxy` : null,
    permissionsPrefix ? `${permissionsPrefix}.dangerously_allow_non_loopback_admin` : null,
    permissionsPrefix ? `${permissionsPrefix}.dangerously_allow_all_unix_sockets` : null,
  ].filter(Boolean);
  const dangerousNetworkSettingCount = dangerousFlags.filter((key) => values[key] === true).length;
  const writableRootCount = tomlArrayStringNames(values["sandbox_workspace_write.writable_roots"]).length;
  const tmpdirExcluded = values["sandbox_workspace_write.exclude_tmpdir_env_var"] === true;
  const slashTmpExcluded = values["sandbox_workspace_write.exclude_slash_tmp"] === true;
  const webSearchMode = values.web_search || null;
  const networkProxyNoEffect = networkProxyEnabled && !commandNetworkAccess && !permissionsNetworkEnabled;
  const unrestrictedDirectNetwork = commandNetworkAccess && !networkProxyEnabled && !permissionsNetworkEnabled;
  const scopedNetwork = (commandNetworkAccess && networkProxyEnabled) || permissionsNetworkEnabled;
  const highLoad =
    dangerousNetworkSettingCount > 0 ||
    globalAllow ||
    (fullAccess && values.approval_policy === "never") ||
    networkProxyNoEffect;
  const mediumLoad =
    highLoad ||
    unrestrictedDirectNetwork ||
    readOnly ||
    (!commandNetworkAccess && !permissionsNetworkEnabled) ||
    localBindingAllowed ||
    writableRootCount >= 4 ||
    tmpdirExcluded ||
    slashTmpExcluded;
  const tone = highLoad ? "high" : mediumLoad ? "medium" : "low";
  const label = networkProxyNoEffect
    ? "Proxy idle"
    : fullAccess
      ? "Full access"
      : readOnly
        ? "Read only"
        : scopedNetwork
          ? domainRuleCount
            ? "Network scoped"
            : "Network limited"
          : commandNetworkAccess
            ? "Network on"
            : "Network off";
  const action =
    networkProxyNoEffect
      ? "Turn on network"
      : globalAllow || dangerousNetworkSettingCount
        ? "Narrow policy"
        : unrestrictedDirectNetwork
          ? "Add proxy rules"
          : readOnly
            ? "Use workspace mode"
            : !commandNetworkAccess && !permissionsNetworkEnabled
              ? "Enable per task"
              : localBindingAllowed
                ? "Check local reach"
                : "Keep scoped";
  const detail =
    tone === "low"
      ? scopedNetwork
        ? `Command network access is available through a scoped policy with ${domainRuleCount.toLocaleString()} domain rule${domainRuleCount === 1 ? "" : "s"}.`
        : "Workspace-write command network access is off by default. Enable it only for tasks that need installs, fetches, or external APIs."
      : [
          readOnly
            ? "Read-only sandbox keeps commands from changing files or using the network; great for planning, but slow for agentic setup work."
            : null,
          networkProxyNoEffect
            ? "network_proxy is enabled, but command network access is off, so the proxy policy does not grant network access by itself."
            : null,
          unrestrictedDirectNetwork
            ? "Command network access is on without network_proxy or a permissions network profile, so outbound command traffic is unrestricted by Codex policy."
            : null,
          scopedNetwork
            ? `Network access is constrained by ${permissionsNetworkEnabled ? `permissions profile ${preferredPermissionProfile}` : "network_proxy"} with ${domainRuleCount.toLocaleString()} domain rule${domainRuleCount === 1 ? "" : "s"}.`
            : null,
          globalAllow ? "A global '*' allow rule is broad network access; prefer exact hosts or scoped wildcards." : null,
          localBindingAllowed ? "Local/private destination access is broadly allowed; use exact localhost/IP rules when possible." : null,
          dangerousNetworkSettingCount
            ? `${dangerousNetworkSettingCount.toLocaleString()} dangerous network setting${dangerousNetworkSettingCount === 1 ? "" : "s"} ${pluralVerb(dangerousNetworkSettingCount)} enabled.`
            : null,
          writableRootCount >= 4
            ? `${writableRootCount.toLocaleString()} extra writable root${writableRootCount === 1 ? "" : "s"} can widen where setup commands write.`
            : null,
          tmpdirExcluded || slashTmpExcluded ? "Temporary directories are excluded from workspace-write roots, which can break tools that expect writable temp space." : null,
        ]
          .filter(Boolean)
          .join(" ");

  return {
    status: "ready",
    tone,
    label,
    action,
    detail,
    sandboxMode: String(rawSandboxMode || "workspace-write"),
    commandNetworkAccess,
    commandNetworkConfigured,
    networkProxyEnabled,
    networkProxyConfigured,
    networkProxyNoEffect,
    unrestrictedDirectNetwork,
    permissionsNetworkEnabled,
    permissionsProfile: preferredPermissionProfile,
    permissionsNetworkMode,
    permissionNetworkProfileCount: enabledPermissionProfiles.length,
    domainRuleCount,
    domainAllowCount,
    domainDenyCount,
    globalAllow,
    localBindingAllowed,
    dangerousNetworkSettingCount,
    writableRootCount,
    tmpdirExcluded,
    slashTmpExcluded,
    webSearchMode,
    sectionsWithNetwork: sections.filter((section) => /(^|\.)(network|network_proxy|sandbox_workspace_write)(\.|$)/.test(section)).slice(0, 12),
  };
}

function shellEnvSecretNameCount() {
  return Object.keys(process.env).filter((name) => /key|secret|token|password|passwd|credential|cookie|session|private|auth/i.test(name)).length;
}

function buildShellEnvironmentSummary(values = {}) {
  const inherit = values["shell_environment_policy.inherit"] || "all";
  const includeOnly = tomlArrayStringNames(values["shell_environment_policy.include_only"]);
  const exclude = tomlArrayStringNames(values["shell_environment_policy.exclude"]);
  const inlineSetKeys = tomlInlineTableKeys(values["shell_environment_policy.set"]);
  const setPrefix = "shell_environment_policy.set.";
  const tableSetKeys = Object.keys(values)
    .filter((key) => key.startsWith(setPrefix))
    .map((key) => key.slice(setPrefix.length));
  const setKeys = [...new Set([...inlineSetKeys, ...tableSetKeys])];
  const configPresent = Object.keys(values).some((key) => key.startsWith("shell_environment_policy."));
  const envVarCount = Object.keys(process.env).length;
  const secretLikeNameCount = shellEnvSecretNameCount();
  const ignoreDefaultExcludes = values["shell_environment_policy.ignore_default_excludes"] === true;
  const inheritMode = String(inherit || "all").toLowerCase();
  const hasIncludeOnly = includeOnly.length > 0;
  const hasTrimmedBase = inheritMode === "core" || inheritMode === "none";
  const tightPolicy = hasTrimmedBase || hasIncludeOnly;
  const normalizedInclude = includeOnly.map((name) => name.toUpperCase());
  const normalizedSet = setKeys.map((name) => name.toUpperCase());
  const pathAvailable = (!hasIncludeOnly && inheritMode !== "none") || normalizedInclude.includes("PATH") || normalizedSet.includes("PATH");
  const homeAvailable = (!hasIncludeOnly && inheritMode !== "none") || normalizedInclude.includes("HOME") || normalizedSet.includes("HOME");
  const highLoad = (!tightPolicy && envVarCount >= 180 && secretLikeNameCount > 0) || (ignoreDefaultExcludes && secretLikeNameCount > 0) || !pathAvailable;
  const mediumLoad =
    highLoad ||
    (!tightPolicy && (envVarCount >= 80 || secretLikeNameCount > 0)) ||
    !homeAvailable ||
    exclude.length >= 6 ||
    setKeys.length >= 8;
  const tone = highLoad ? "high" : mediumLoad ? "medium" : "low";
  const label = tightPolicy ? (hasIncludeOnly ? "Allowlist" : inheritMode === "none" ? "Clean start" : "Core env") : "All env";
  const action = tone === "low" ? "Keep scoped" : tightPolicy ? "Review policy" : "Trim env";
  const detail = tightPolicy
    ? `Shell env policy starts from ${inheritMode} with ${includeOnly.length.toLocaleString()} allowlist pattern${includeOnly.length === 1 ? "" : "s"} and ${setKeys.length.toLocaleString()} explicit override${setKeys.length === 1 ? "" : "s"}.`
    : `Shell env policy inherits all visible variables. Refit sees ${envVarCount.toLocaleString()} env var${envVarCount === 1 ? "" : "s"} in this process, including ${secretLikeNameCount.toLocaleString()} secret-looking name${secretLikeNameCount === 1 ? "" : "s"}.`;

  return {
    status: "ready",
    configPresent,
    inherit: inheritMode,
    label,
    tone,
    action,
    detail:
      ignoreDefaultExcludes && secretLikeNameCount > 0
        ? `${detail} Default KEY/SECRET/TOKEN excludes are disabled, so review this before running broad shell commands.`
        : !pathAvailable
          ? `${detail} PATH is not clearly available to spawned commands; that can make normal tooling fail.`
          : detail,
    envVarCount,
    secretLikeNameCount,
    includeOnlyCount: includeOnly.length,
    excludeCount: exclude.length,
    setCount: setKeys.length,
    ignoreDefaultExcludes,
    tightPolicy,
    pathAvailable,
    homeAvailable,
  };
}

function buildContextBudgetSummary(values = {}) {
  const contextWindow = configNumber(values.model_context_window);
  const autoCompactTokenLimit = configNumber(values.model_auto_compact_token_limit);
  const toolOutputTokenLimit = configNumber(values.tool_output_token_limit);
  const compactPromptConfigured = Boolean(values.compact_prompt || values.experimental_compact_prompt_file);
  const modelCatalogConfigured = Boolean(values.model_catalog_json);
  const contextWindowConfigured = contextWindow !== null;
  const autoCompactConfigured = autoCompactTokenLimit !== null;
  const toolOutputConfigured = toolOutputTokenLimit !== null;
  const anyConfigured =
    contextWindowConfigured || autoCompactConfigured || toolOutputConfigured || compactPromptConfigured || modelCatalogConfigured;
  const toolOutputHeavy = toolOutputTokenLimit !== null && toolOutputTokenLimit > 24000;
  const toolOutputWide = toolOutputTokenLimit !== null && toolOutputTokenLimit > 12000;
  const compactRatio = contextWindow && autoCompactTokenLimit ? autoCompactTokenLimit / contextWindow : null;
  const compactTooLate = compactRatio !== null && compactRatio >= 0.9;
  const compactLate = compactRatio !== null && compactRatio >= 0.75;
  const compactEarly = compactRatio !== null && compactRatio <= 0.25;
  const smallWindow = contextWindow !== null && contextWindow < 64000;
  const highLoad = toolOutputHeavy || compactTooLate;
  const mediumLoad = highLoad || toolOutputWide || compactLate || compactEarly || smallWindow || compactPromptConfigured || modelCatalogConfigured;
  const tone = highLoad ? "high" : mediumLoad ? "medium" : "low";
  const label = toolOutputTokenLimit
    ? `${toolOutputTokenLimit.toLocaleString()} tool tokens`
    : autoCompactTokenLimit
      ? `${autoCompactTokenLimit.toLocaleString()} compact`
      : contextWindow
        ? `${contextWindow.toLocaleString()} context`
        : "Model defaults";
  const action =
    tone === "low"
      ? "Use defaults"
      : toolOutputWide
        ? "Lower tool output"
        : compactTooLate || compactLate || compactEarly
          ? "Review compact"
          : "Review context";
  const detail =
    tone === "low"
      ? anyConfigured
        ? "Context budget settings are explicit and within the normal range Refit checks."
        : "Context window, auto-compact threshold, and per-tool output storage are using Codex model defaults."
      : [
          toolOutputWide
            ? `Per-tool output storage is set to ${toolOutputTokenLimit.toLocaleString()} tokens; large command output can crowd the thread context.`
            : null,
          compactRatio !== null
            ? `Auto-compact starts around ${Math.round(compactRatio * 100)}% of the configured context window.`
            : autoCompactConfigured
              ? `Auto-compact limit is set to ${autoCompactTokenLimit.toLocaleString()} tokens.`
              : null,
          smallWindow ? `Configured context window is ${contextWindow.toLocaleString()} tokens, so long runs may compact sooner.` : null,
          compactPromptConfigured ? "A custom compact prompt is configured; review it if compaction quality feels off." : null,
          modelCatalogConfigured ? "A custom model catalog is configured at startup; keep it current when debugging model defaults." : null,
        ]
          .filter(Boolean)
          .join(" ");

  return {
    status: "ready",
    tone,
    label,
    action,
    detail,
    contextWindow,
    autoCompactTokenLimit,
    toolOutputTokenLimit,
    contextWindowConfigured,
    autoCompactConfigured,
    toolOutputConfigured,
    compactPromptConfigured,
    modelCatalogConfigured,
    anyConfigured,
    compactRatio,
    toolOutputWide,
    toolOutputHeavy,
    compactLate,
    compactTooLate,
    compactEarly,
    smallWindow,
  };
}

function buildResponseShapeSummary(values = {}) {
  const verbosity = values.model_verbosity ? normalizeConfigKey(values.model_verbosity) : null;
  const reasoningSummary = values.model_reasoning_summary ? normalizeConfigKey(values.model_reasoning_summary) : null;
  const summariesForced = values.model_supports_reasoning_summaries === true;
  const summariesDisabled = values.model_supports_reasoning_summaries === false;
  const rawReasoning = values.show_raw_agent_reasoning === true;
  const hiddenReasoningEvents = values.hide_agent_reasoning === true;
  const highVerbosity = verbosity === "high";
  const lowVerbosity = verbosity === "low";
  const detailedSummary = reasoningSummary === "detailed";
  const conciseSummary = reasoningSummary === "concise";
  const noSummary = reasoningSummary === "none" || summariesDisabled;
  const configuredCount = [
    values.model_verbosity !== undefined,
    values.model_reasoning_summary !== undefined,
    values.model_supports_reasoning_summaries !== undefined,
    values.show_raw_agent_reasoning !== undefined,
    values.hide_agent_reasoning !== undefined,
  ].filter(Boolean).length;
  const highLoad = rawReasoning || (highVerbosity && detailedSummary);
  const mediumLoad = highLoad || highVerbosity || detailedSummary || summariesForced;
  const tone = highLoad ? "high" : mediumLoad ? "medium" : "low";
  const label = highVerbosity
    ? "High verbosity"
    : lowVerbosity
      ? "Low verbosity"
      : detailedSummary
        ? "Detailed summary"
        : conciseSummary
          ? "Concise summary"
          : noSummary
            ? "Summary off"
            : configuredCount
              ? "Configured"
              : "Defaults";
  const action =
    tone === "low"
      ? lowVerbosity || noSummary
        ? "Keep lean"
        : "Use defaults"
      : highVerbosity
        ? "Lower verbosity"
        : detailedSummary || summariesForced
          ? "Shorten summaries"
          : "Hide raw reasoning";
  const detail =
    tone === "low"
      ? configuredCount
        ? "Response shape is explicit and not adding obvious output weight. model_verbosity only affects Responses API providers."
        : "Response verbosity and reasoning-summary settings are using Codex defaults."
      : [
          highVerbosity ? 'model_verbosity is "high"; the manual notes model_verbosity can shorten responses when set to low.' : null,
          detailedSummary ? 'model_reasoning_summary is "detailed"; use concise or none for small local tasks.' : null,
          summariesForced ? "Reasoning summaries are forced on for the current model; leave this unset unless you need it." : null,
          rawReasoning ? "show_raw_agent_reasoning is enabled, which can add noisy output when raw reasoning is available." : null,
        ]
          .filter(Boolean)
          .join(" ");

  return {
    status: "ready",
    tone,
    label,
    action,
    detail,
    verbosity: verbosity || null,
    reasoningSummary: reasoningSummary || null,
    summariesForced,
    summariesDisabled,
    rawReasoning,
    hiddenReasoningEvents,
    highVerbosity,
    lowVerbosity,
    detailedSummary,
    conciseSummary,
    noSummary,
    configuredCount,
  };
}

function displayPath(filePath) {
  const resolved = path.resolve(filePath || "");
  return resolved === homeDir ? "~" : resolved.startsWith(`${homeDir}${path.sep}`) ? `~${resolved.slice(homeDir.length)}` : resolved;
}

function repoSkillRootsFrom(startPath) {
  const roots = [];
  let current = path.resolve(startPath || rootDir);
  const home = path.resolve(homeDir);

  while (current && current !== path.dirname(current)) {
    if (current === home) break;
    roots.push(path.join(current, ".agents", "skills"));
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return roots;
}

function skillCatalogRoots() {
  const roots = [
    {
      scope: "codex-home",
      label: "Codex Home Skills",
      path: paths.codexSkills,
      skipDirs: [paths.codexSystemSkills],
    },
    {
      scope: "system",
      label: "System Skills",
      path: paths.codexSystemSkills,
    },
    {
      scope: "user",
      label: "User Skills",
      path: paths.userAgentSkills,
    },
    {
      scope: "admin",
      label: "Admin Skills",
      path: paths.adminSkills,
    },
    {
      scope: "plugin",
      label: "Plugin Skills",
      path: paths.pluginCache,
    },
    ...repoSkillRootsFrom(process.cwd()).map((repoPath) => ({
      scope: "repo",
      label: "Current Repo Skills",
      path: repoPath,
    })),
    ...repoSkillRootsFrom(rootDir).map((repoPath) => ({
      scope: "repo",
      label: "App Repo Skills",
      path: repoPath,
    })),
  ];

  const seen = new Set();
  return roots
    .map((root) => ({ ...root, path: path.resolve(root.path), skipDirs: (root.skipDirs || []).map((skip) => path.resolve(skip)) }))
    .filter((root) => {
      const key = root.path;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function shouldSkipSkillDir(dirPath, skipDirs = []) {
  const base = path.basename(dirPath);
  if ([".git", "node_modules", "dist", "release", "tmp", ".next", ".cache"].includes(base)) return true;
  return skipDirs.some((skipPath) => pathContains(skipPath, dirPath));
}

async function findSkillFiles(root) {
  const result = {
    root: root.path,
    label: root.label,
    scope: root.scope,
    exists: false,
    fileCount: 0,
    dirCount: 0,
    truncated: false,
    files: [],
  };

  const rootStats = await statOrNull(root.path);
  if (!rootStats) return result;
  result.exists = true;

  const stack = [{ dir: root.path, depth: 0 }];
  const seenDirs = new Set();

  while (stack.length) {
    if (result.files.length >= maxSkillCatalogFiles || result.dirCount >= maxSkillCatalogDirs) {
      result.truncated = true;
      break;
    }

    const { dir, depth } = stack.pop();
    if (shouldSkipSkillDir(dir, root.skipDirs)) continue;

    let realDir = dir;
    try {
      realDir = await fs.realpath(dir);
    } catch {
      // Keep scanning by visible path when realpath is unavailable.
    }
    if (seenDirs.has(realDir)) continue;
    seenDirs.add(realDir);
    result.dirCount += 1;

    let entries = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const stats = await statOrNull(fullPath);
      if (!stats) continue;

      if (entry.name === "SKILL.md" && stats.isFile()) {
        result.files.push(fullPath);
        if (result.files.length >= maxSkillCatalogFiles) {
          result.truncated = true;
          break;
        }
        continue;
      }

      if (depth >= maxSkillCatalogDepth) continue;
      if (stats.isDirectory() || stats.isSymbolicLink()) {
        const targetStats = stats.isSymbolicLink() ? await fs.stat(fullPath).catch(() => null) : stats;
        if (targetStats?.isDirectory() && !shouldSkipSkillDir(fullPath, root.skipDirs)) {
          stack.push({ dir: fullPath, depth: depth + 1 });
        }
      }
    }
  }

  result.fileCount = result.files.length;
  return result;
}

function unquoteSkillValue(value) {
  const trimmed = String(value || "").trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function yamlLikeField(text, fieldName) {
  const lines = String(text || "").split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = line.match(new RegExp(`^${fieldName}\\s*:\\s*(.*)$`));
    if (!match) continue;

    const raw = match[1].trim();
    if (raw === "|" || raw === ">") {
      const parts = [];
      for (let next = index + 1; next < lines.length; next += 1) {
        const nextLine = lines[next];
        if (/^\S[^:]*:\s*/.test(nextLine)) break;
        if (nextLine.trim()) parts.push(nextLine.trim());
      }
      return parts.join(raw === ">" ? " " : "\n").trim();
    }

    return unquoteSkillValue(raw);
  }

  return "";
}

async function readSkillMetadata(filePath, root) {
  const stats = await statOrNull(filePath);
  const fileBytes = stats?.isFile() ? stats.size : 0;
  let text = "";
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch {
    text = "";
  }

  const frontMatter = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  const metadataText = frontMatter ? frontMatter[1] : text.slice(0, 4096);
  const name = yamlLikeField(metadataText, "name") || path.basename(path.dirname(filePath));
  const description = yamlLikeField(metadataText, "description");
  const descriptionChars = description.length;
  const shownPath = displayPath(filePath);
  const estimatedCatalogChars = name.length + descriptionChars + shownPath.length + 16;

  return {
    name,
    scope: root.scope,
    path: shownPath,
    fileBytes,
    descriptionChars,
    estimatedCatalogChars,
  };
}

async function getSkillCatalogSummary() {
  const roots = skillCatalogRoots();
  const discovered = await Promise.all(roots.map((root) => findSkillFiles(root)));
  const skillFiles = [];

  for (const rootResult of discovered) {
    const root = roots.find((candidate) => candidate.path === rootResult.root) || {};
    for (const filePath of rootResult.files) {
      skillFiles.push({ filePath, root });
    }
  }

  const seenFiles = new Set();
  const uniqueSkillFiles = skillFiles.filter((item) => {
    const resolved = path.resolve(item.filePath);
    if (seenFiles.has(resolved)) return false;
    seenFiles.add(resolved);
    return true;
  });

  const skills = await Promise.all(uniqueSkillFiles.map((item) => readSkillMetadata(item.filePath, item.root)));
  const skillCount = skills.length;
  const estimatedCatalogChars = skills.reduce((total, skill) => total + skill.estimatedCatalogChars, 0);
  const descriptionChars = skills.reduce((total, skill) => total + skill.descriptionChars, 0);
  const longDescriptionCount = skills.filter((skill) => skill.descriptionChars >= longSkillDescriptionChars).length;
  const largeSkillFileCount = skills.filter((skill) => skill.fileBytes >= largeSkillFileBytes).length;
  const truncated = discovered.some((root) => root.truncated);
  const scopeCounts = skills.reduce((counts, skill) => {
    counts[skill.scope] = (counts[skill.scope] || 0) + 1;
    return counts;
  }, {});
  const userManagedCount = (scopeCounts.user || 0) + (scopeCounts.repo || 0) + (scopeCounts["codex-home"] || 0) + (scopeCounts.plugin || 0);
  const highLoad =
    truncated ||
    estimatedCatalogChars >= skillCatalogBudgetChars * 3 ||
    skillCount >= 120 ||
    longDescriptionCount >= 18;
  const mediumLoad =
    highLoad ||
    estimatedCatalogChars >= skillCatalogBudgetChars ||
    skillCount >= 40 ||
    longDescriptionCount >= 6 ||
    largeSkillFileCount >= 8;
  const tone = highLoad ? "high" : mediumLoad ? "medium" : "low";
  const label = skillCount
    ? `${skillCount.toLocaleString()} skill${skillCount === 1 ? "" : "s"}`
    : "No skills";
  const action = tone === "low" ? "Keep concise" : highLoad ? "Trim catalog" : "Review /skills";
  const longestSkills = [...skills]
    .sort((a, b) => b.descriptionChars - a.descriptionChars)
    .slice(0, 8)
    .map((skill) => ({
      name: skill.name,
      scope: skill.scope,
      path: skill.path,
      descriptionChars: skill.descriptionChars,
      fileBytes: skill.fileBytes,
    }));
  const rootsSummary = discovered.map((root) => ({
    label: root.label,
    scope: root.scope,
    path: displayPath(root.root),
    exists: root.exists,
    skillCount: root.fileCount,
    dirCount: root.dirCount,
    truncated: root.truncated,
  }));

  const detail =
    tone === "low"
      ? `Skill metadata looks light: ${skillCount.toLocaleString()} skill${skillCount === 1 ? "" : "s"} and about ${estimatedCatalogChars.toLocaleString()} catalog character${estimatedCatalogChars === 1 ? "" : "s"}.`
      : [
          `Codex includes skill name, description, and path metadata in the initial prompt, with a documented fallback cap around ${skillCatalogBudgetChars.toLocaleString()} characters when the context window is unknown.`,
          `Refit estimates ${estimatedCatalogChars.toLocaleString()} catalog character${estimatedCatalogChars === 1 ? "" : "s"} across ${skillCount.toLocaleString()} skill${skillCount === 1 ? "" : "s"}.`,
          longDescriptionCount
            ? `${longDescriptionCount.toLocaleString()} description${longDescriptionCount === 1 ? "" : "s"} ${pluralVerb(longDescriptionCount)} at least ${longSkillDescriptionChars.toLocaleString()} characters.`
            : null,
          truncated ? "The scan hit its safety cap before finishing every skill root." : null,
        ]
          .filter(Boolean)
          .join(" ");

  return {
    status: "ready",
    tone,
    label,
    action,
    detail,
    skillCount,
    userManagedCount,
    systemSkillCount: scopeCounts.system || 0,
    pluginSkillCount: scopeCounts.plugin || 0,
    userSkillCount: scopeCounts.user || 0,
    repoSkillCount: scopeCounts.repo || 0,
    codexHomeSkillCount: scopeCounts["codex-home"] || 0,
    adminSkillCount: scopeCounts.admin || 0,
    scopeCounts,
    estimatedCatalogChars,
    descriptionChars,
    longDescriptionCount,
    largeSkillFileCount,
    largestDescriptionChars: longestSkills[0]?.descriptionChars || 0,
    budgetChars: skillCatalogBudgetChars,
    overBudget: estimatedCatalogChars >= skillCatalogBudgetChars,
    truncated,
    roots: rootsSummary,
    longestSkills,
  };
}

function emptyInstructionStackSummary() {
  return {
    status: "ready",
    tone: "low",
    label: "No guidance",
    action: "Add only useful rules",
    detail: "No non-empty global or current-project instruction files were found.",
    globalBytes: 0,
    projectBytes: 0,
    projectCandidateBytes: 0,
    totalBytes: 0,
    selectedFileCount: 0,
    emptyFileCount: 0,
    overrideFileCount: 0,
    fallbackFileCount: 0,
    largeFileCount: 0,
    projectDocMaxBytes: defaultProjectDocMaxBytes,
    projectDocMaxConfigured: false,
    projectBytesRatio: 0,
    projectNearCap: false,
    projectOverCap: false,
    fallbackNames: [],
    currentProjectPath: null,
    currentWorkPath: null,
    files: [],
  };
}

function emptyInstructionOverrideSummary() {
  return {
    status: "ready",
    tone: "low",
    label: "Defaults",
    action: "Use sparingly",
    detail: "No custom instruction or compact-prompt overrides were found in the active Codex config layers Refit inspected.",
    configuredCount: 0,
    effectiveCount: 0,
    developerInstructionsConfigured: false,
    modelInstructionsFileConfigured: false,
    compactPromptConfigured: false,
    compactPromptFileConfigured: false,
    developerInstructionChars: 0,
    compactPromptChars: 0,
    modelInstructionFileBytes: 0,
    compactPromptFileBytes: 0,
    instructionOverrideBytes: 0,
    compactOverrideBytes: 0,
    missingFileCount: 0,
    largeOverrideCount: 0,
    sources: [],
  };
}

async function gitRootFor(startPath) {
  try {
    const { stdout } = await execFileAsync("git", ["-C", startPath, "rev-parse", "--show-toplevel"], {
      timeout: 2500,
      maxBuffer: 128 * 1024,
    });
    const resolved = path.resolve(stdout.trim());
    return resolved || null;
  } catch {
    return null;
  }
}

function directoryChain(rootPath, targetPath) {
  const root = path.resolve(rootPath || "");
  let target = path.resolve(targetPath || root);
  if (!pathContains(root, target)) target = root;

  const chain = [];
  let current = target;
  while (pathContains(root, current)) {
    chain.unshift(current);
    if (current === root) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return chain.length ? chain : [root];
}

function instructionCandidateNames(fallbackNames = []) {
  return ["AGENTS.override.md", "AGENTS.md", ...fallbackNames.filter(Boolean)];
}

async function instructionFileInfo(filePath, { scope, source, selected = false, reason = null } = {}) {
  const stats = await statOrNull(filePath);
  if (!stats?.isFile()) return null;
  return {
    scope,
    source,
    path: displayPath(filePath),
    bytes: stats.size,
    mtime: stats.mtime.toISOString(),
    selected,
    empty: stats.size === 0,
    override: path.basename(filePath) === "AGENTS.override.md",
    fallback: !["AGENTS.override.md", "AGENTS.md"].includes(path.basename(filePath)),
    reason,
  };
}

async function selectInstructionFile(directory, { scope, fallbackNames = [] } = {}) {
  const all = [];
  for (const name of instructionCandidateNames(fallbackNames)) {
    const filePath = path.join(directory, name);
    const info = await instructionFileInfo(filePath, { scope, source: name });
    if (!info) continue;
    all.push(info);
    if (!info.empty) return { selected: { ...info, selected: true }, all };
  }
  return { selected: null, all };
}

async function resolveInstructionProjectRoot(currentProject = null) {
  const candidates = [
    currentProject?.exists ? currentProject.path : null,
    await gitRootFor(process.cwd()),
    await gitRootFor(rootDir),
    path.resolve(rootDir),
  ].filter(Boolean);

  return path.resolve(candidates[0]);
}

function resolveInstructionWorkPath(projectRoot) {
  const candidates = [process.cwd(), rootDir].map((candidate) => path.resolve(candidate));
  return (
    candidates
      .filter((candidate) => pathContains(projectRoot, candidate))
      .sort((a, b) => b.length - a.length)[0] || projectRoot
  );
}

async function getInstructionStackSummary({ values = {}, currentProject = null } = {}) {
  const fallbackNames = tomlArrayStringNames(values.project_doc_fallback_filenames);
  const projectDocMaxBytes = configNumber(values.project_doc_max_bytes) || defaultProjectDocMaxBytes;
  const projectRoot = await resolveInstructionProjectRoot(currentProject);
  const workPath = resolveInstructionWorkPath(projectRoot);
  const projectDirs = directoryChain(projectRoot, workPath);
  const files = [];

  const globalSelection = await selectInstructionFile(paths.codexHome, {
    scope: "global",
    fallbackNames: [],
  });
  if (globalSelection.selected) files.push(globalSelection.selected);
  for (const info of globalSelection.all) {
    if (!info.selected) files.push({ ...info, reason: info.empty ? "Skipped empty global guidance" : "Not active at global scope" });
  }

  const projectSelections = [];
  for (const dir of projectDirs) {
    projectSelections.push({ dir, ...(await selectInstructionFile(dir, { scope: "project", fallbackNames })) });
  }

  let projectBytes = 0;
  let projectCandidateBytes = 0;
  let projectOverCap = false;
  for (const selection of projectSelections) {
    if (!selection.selected) {
      files.push(
        ...selection.all.map((info) => ({
          ...info,
          reason: info.empty ? "Skipped empty project guidance" : "Not selected for this directory",
        })),
      );
      continue;
    }

    const selected = selection.selected;
    projectCandidateBytes += selected.bytes;
    const wouldExceed = projectBytes + selected.bytes > projectDocMaxBytes;
    if (wouldExceed) {
      projectOverCap = true;
      files.push({ ...selected, selected: false, reason: "Past project_doc_max_bytes cap" });
    } else {
      projectBytes += selected.bytes;
      files.push(selected);
    }

    for (const info of selection.all) {
      if (info.path === selected.path) continue;
      files.push({
        ...info,
        reason: info.empty ? "Skipped empty project guidance" : "Lower priority in this directory",
      });
    }
  }

  const selectedFiles = files.filter((file) => file.selected);
  const globalBytes = selectedFiles.filter((file) => file.scope === "global").reduce((total, file) => total + file.bytes, 0);
  const totalBytes = globalBytes + projectBytes;
  const emptyFileCount = files.filter((file) => file.empty).length;
  const overrideFileCount = selectedFiles.filter((file) => file.override).length;
  const fallbackFileCount = selectedFiles.filter((file) => file.fallback).length;
  const largeFileCount = selectedFiles.filter((file) => file.bytes >= largeInstructionFileBytes).length;
  const projectBytesRatio = projectDocMaxBytes ? projectBytes / projectDocMaxBytes : 0;
  const projectNearCap = projectBytesRatio >= 0.75;

  if (!selectedFiles.length && !projectOverCap) {
    return {
      ...emptyInstructionStackSummary(),
      emptyFileCount,
      projectDocMaxBytes,
      projectDocMaxConfigured: values.project_doc_max_bytes !== undefined,
      fallbackNames,
      currentProjectPath: displayPath(projectRoot),
      currentWorkPath: displayPath(workPath),
      files,
    };
  }

  const highLoad = projectOverCap || projectBytesRatio >= 0.95 || totalBytes >= 80 * 1024 || largeFileCount >= 4;
  const mediumLoad = highLoad || projectNearCap || totalBytes >= 24 * 1024 || globalBytes >= 12 * 1024 || selectedFiles.length >= 5 || largeFileCount > 0;
  const tone = highLoad ? "high" : mediumLoad ? "medium" : "low";
  const label = projectOverCap && !selectedFiles.length
    ? "Capped"
    : `${selectedFiles.length.toLocaleString()} file${selectedFiles.length === 1 ? "" : "s"}`;
  const action = tone === "low" ? "Keep practical" : projectOverCap || projectNearCap ? "Split or trim" : "Review guidance";
  const projectDocMaxLabel =
    values.project_doc_max_bytes !== undefined
      ? `configured to ${formatBytesServer(projectDocMaxBytes)}`
      : `${formatBytesServer(projectDocMaxBytes)} by default`;
  const detail =
    tone === "low"
      ? `Instruction stack is concise: ${formatBytesServer(totalBytes)} selected across ${selectedFiles.length.toLocaleString()} file${selectedFiles.length === 1 ? "" : "s"}.`
      : [
          `Codex reads global and project AGENTS guidance before work, then concatenates project files from root to current directory until project_doc_max_bytes (${projectDocMaxLabel}).`,
          `Refit found ${formatBytesServer(totalBytes)} selected guidance: ${formatBytesServer(globalBytes)} global and ${formatBytesServer(projectBytes)} project.`,
          projectCandidateBytes > projectBytes ? `${formatBytesServer(projectCandidateBytes)} of project guidance was available before the cap was applied.` : null,
          projectOverCap ? "Some project guidance would land past the configured project instruction cap." : null,
          largeFileCount ? `${largeFileCount.toLocaleString()} selected instruction file${largeFileCount === 1 ? "" : "s"} ${pluralVerb(largeFileCount)} at least ${formatBytesServer(largeInstructionFileBytes)}.` : null,
        ]
          .filter(Boolean)
          .join(" ");

  return {
    status: "ready",
    tone,
    label,
    action,
    detail,
    globalBytes,
    projectBytes,
    projectCandidateBytes,
    totalBytes,
    selectedFileCount: selectedFiles.length,
    emptyFileCount,
    overrideFileCount,
    fallbackFileCount,
    largeFileCount,
    projectDocMaxBytes,
    projectDocMaxConfigured: values.project_doc_max_bytes !== undefined,
    projectBytesRatio,
    projectNearCap,
    projectOverCap,
    fallbackNames,
    currentProjectPath: displayPath(projectRoot),
    currentWorkPath: displayPath(workPath),
    files,
  };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function tomlStringAssignment(text, key) {
  const source = String(text || "");
  const escaped = escapeRegExp(key);
  const triple = source.match(new RegExp(`^\\s*${escaped}\\s*=\\s*("""|''')([\\s\\S]*?)\\1`, "m"));
  if (triple) {
    return {
      present: true,
      value: triple[2],
      chars: triple[2].length,
      bytes: Buffer.byteLength(triple[2], "utf8"),
      multiline: true,
    };
  }

  const line = source.match(new RegExp(`^\\s*${escaped}\\s*=\\s*(.+)$`, "m"));
  if (!line) {
    return { present: false, value: "", chars: 0, bytes: 0, multiline: false };
  }

  const value = parseTomlScalar(line[1]);
  const stringValue = value === undefined || value === null ? "" : String(value);
  return {
    present: true,
    value: stringValue,
    chars: stringValue.length,
    bytes: Buffer.byteLength(stringValue, "utf8"),
    multiline: false,
  };
}

function resolveConfigPathValue(value, configPath) {
  if (!value) return null;
  const text = String(value);
  return path.isAbsolute(text) ? text : path.resolve(path.dirname(configPath), text);
}

async function projectConfigPathsFor(currentProject = null) {
  const projectRoot = await resolveInstructionProjectRoot(currentProject);
  const workPath = resolveInstructionWorkPath(projectRoot);
  const dirs = directoryChain(projectRoot, workPath);
  const configs = [];

  for (const dir of dirs) {
    const configPath = path.join(dir, ".codex", "config.toml");
    if (await exists(configPath)) configs.push(configPath);
  }

  return configs;
}

async function collectInstructionOverrideSource({ configPath, text, scope }) {
  const entries = [];
  const addInline = (key, label) => {
    const assignment = tomlStringAssignment(text, key);
    if (!assignment.present) return;
    entries.push({
      key,
      label,
      scope,
      configPath: displayPath(configPath),
      type: "inline",
      chars: assignment.chars,
      bytes: assignment.bytes,
      multiline: assignment.multiline,
      exists: true,
      effective: false,
    });
  };
  const addFile = async (key, label) => {
    const assignment = tomlStringAssignment(text, key);
    if (!assignment.present) return;
    const resolved = resolveConfigPathValue(assignment.value, configPath);
    const stats = resolved ? await statOrNull(resolved) : null;
    entries.push({
      key,
      label,
      scope,
      configPath: displayPath(configPath),
      type: "file",
      filePath: resolved ? displayPath(resolved) : null,
      exists: Boolean(stats?.isFile()),
      bytes: stats?.isFile() ? stats.size : 0,
      chars: 0,
      missing: !stats?.isFile(),
      effective: false,
    });
  };

  addInline("developer_instructions", "Developer Instructions");
  addInline("compact_prompt", "Compact Prompt");
  await addFile("model_instructions_file", "Model Instructions File");
  await addFile("experimental_compact_prompt_file", "Compact Prompt File");
  return entries;
}

async function getInstructionOverrideSummary({ globalConfigText = "", currentProject = null } = {}) {
  const sources = [];
  if (globalConfigText) {
    sources.push({
      scope: "global",
      configPath: paths.configToml,
      text: globalConfigText,
    });
  }

  const projectConfigPaths = await projectConfigPathsFor(currentProject);
  for (const configPath of projectConfigPaths) {
    try {
      sources.push({
        scope: "project",
        configPath,
        text: await fs.readFile(configPath, "utf8"),
      });
    } catch {
      // Missing project config files are ignored; they can disappear while a scan is running.
    }
  }

  const entries = [];
  for (const source of sources) {
    entries.push(...(await collectInstructionOverrideSource(source)));
  }
  if (!entries.length) return emptyInstructionOverrideSummary();

  const effectiveByKey = new Map();
  for (const entry of entries) {
    effectiveByKey.set(entry.key, entry);
  }
  const effectiveEntries = entries.map((entry) => ({
    ...entry,
    effective: effectiveByKey.get(entry.key) === entry,
  }));
  const effective = effectiveEntries.filter((entry) => entry.effective);
  const configuredCount = entries.length;
  const missingFileCount = effective.filter((entry) => entry.missing).length;
  const developerEntry = effective.find((entry) => entry.key === "developer_instructions");
  const compactEntry = effective.find((entry) => entry.key === "compact_prompt");
  const modelFileEntry = effective.find((entry) => entry.key === "model_instructions_file");
  const compactFileEntry = effective.find((entry) => entry.key === "experimental_compact_prompt_file");
  const developerInstructionChars = developerEntry?.chars || 0;
  const compactPromptChars = compactEntry?.chars || 0;
  const modelInstructionFileBytes = modelFileEntry?.bytes || 0;
  const compactPromptFileBytes = compactFileEntry?.bytes || 0;
  const instructionOverrideBytes = (developerEntry?.bytes || 0) + modelInstructionFileBytes;
  const compactOverrideBytes = (compactEntry?.bytes || 0) + compactPromptFileBytes;
  const largeOverrideCount = effective.filter((entry) => (entry.bytes || 0) >= largeInstructionFileBytes).length;
  const developerInstructionsConfigured = Boolean(developerEntry);
  const modelInstructionsFileConfigured = Boolean(modelFileEntry);
  const compactPromptConfigured = Boolean(compactEntry);
  const compactPromptFileConfigured = Boolean(compactFileEntry);
  const highLoad =
    missingFileCount > 0 ||
    instructionOverrideBytes >= 48 * 1024 ||
    developerInstructionChars >= 24 * 1024 ||
    largeOverrideCount >= 3;
  const mediumLoad =
    highLoad ||
    instructionOverrideBytes >= 12 * 1024 ||
    compactOverrideBytes >= 12 * 1024 ||
    developerInstructionChars >= 4 * 1024 ||
    modelInstructionsFileConfigured ||
    compactPromptConfigured ||
    compactPromptFileConfigured;
  const tone = highLoad ? "high" : mediumLoad ? "medium" : "low";
  const effectiveCount = effective.length;
  const label = effectiveCount
    ? `${effectiveCount.toLocaleString()} override${effectiveCount === 1 ? "" : "s"}`
    : "Defaults";
  const action =
    tone === "low"
      ? "Keep rare"
      : missingFileCount
        ? "Fix file paths"
        : modelInstructionsFileConfigured
          ? "Review base override"
          : "Trim overrides";
  const detail =
    tone === "low"
      ? "Custom instruction overrides are present but small. Keep them rare so AGENTS.md and task prompts remain the main behavior controls."
      : [
          "Codex can inject developer_instructions before AGENTS.md, load model_instructions_file instead of the built-in base instructions, and use compact prompt overrides during summarization.",
          `Refit found ${effectiveCount.toLocaleString()} effective override${effectiveCount === 1 ? "" : "s"} totaling ${formatBytesServer(instructionOverrideBytes + compactOverrideBytes)}.`,
          modelInstructionsFileConfigured ? "A model_instructions_file override changes the base behavior Codex starts from." : null,
          compactPromptConfigured || compactPromptFileConfigured ? "A compact prompt override can affect long-thread summarization quality." : null,
          missingFileCount ? `${missingFileCount.toLocaleString()} referenced instruction file${missingFileCount === 1 ? "" : "s"} ${pluralVerb(missingFileCount)} missing.` : null,
        ]
          .filter(Boolean)
          .join(" ");

  return {
    status: "ready",
    tone,
    label,
    action,
    detail,
    configuredCount,
    effectiveCount,
    developerInstructionsConfigured,
    modelInstructionsFileConfigured,
    compactPromptConfigured,
    compactPromptFileConfigured,
    developerInstructionChars,
    compactPromptChars,
    modelInstructionFileBytes,
    compactPromptFileBytes,
    instructionOverrideBytes,
    compactOverrideBytes,
    missingFileCount,
    largeOverrideCount,
    sources: effectiveEntries.map((entry) => ({
      key: entry.key,
      label: entry.label,
      scope: entry.scope,
      configPath: entry.configPath,
      type: entry.type,
      filePath: entry.filePath || null,
      exists: entry.exists,
      missing: Boolean(entry.missing),
      bytes: entry.bytes || 0,
      chars: entry.chars || 0,
      multiline: Boolean(entry.multiline),
      effective: Boolean(entry.effective),
    })),
  };
}

function emptyCustomAgentSummary() {
  return {
    status: "ready",
    tone: "low",
    label: "None",
    action: "Use when helpful",
    detail: "No personal or current-project custom agent files were found.",
    agentCount: 0,
    validAgentCount: 0,
    invalidAgentCount: 0,
    globalAgentCount: 0,
    projectAgentCount: 0,
    duplicateNameCount: 0,
    builtInOverrideCount: 0,
    highEffortCount: 0,
    modelOverrideCount: 0,
    sandboxOverrideCount: 0,
    mcpServerCount: 0,
    requiredMcpCount: 0,
    missingMcpEnvVarCount: 0,
    skillsConfigCount: 0,
    totalDeveloperInstructionBytes: 0,
    longDeveloperInstructionCount: 0,
    roots: [],
    agents: [],
  };
}

async function customAgentRoots(currentProject = null) {
  const projectRoot = await resolveInstructionProjectRoot(currentProject);
  const roots = [
    {
      scope: "global",
      label: "Personal Custom Agents",
      path: paths.customAgents,
    },
    {
      scope: "project",
      label: "Project Custom Agents",
      path: path.join(projectRoot, ".codex", "agents"),
    },
  ];
  const seen = new Set();
  return roots
    .map((root) => ({ ...root, path: path.resolve(root.path) }))
    .filter((root) => {
      if (seen.has(root.path)) return false;
      seen.add(root.path);
      return true;
    });
}

async function listCustomAgentFiles(root) {
  const result = {
    scope: root.scope,
    label: root.label,
    path: displayPath(root.path),
    exists: false,
    fileCount: 0,
    dirCount: 0,
    files: [],
  };
  const stats = await statOrNull(root.path);
  if (!stats?.isDirectory()) return result;
  result.exists = true;

  const stack = [{ dir: root.path, depth: 0 }];
  while (stack.length) {
    const { dir, depth } = stack.pop();
    result.dirCount += 1;
    let entries = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const stats = await statOrNull(fullPath);
      if (!stats) continue;
      if (stats.isDirectory() && depth < 2 && ![".git", "node_modules"].includes(entry.name)) {
        stack.push({ dir: fullPath, depth: depth + 1 });
        continue;
      }
      if (stats.isFile() && /\.toml$/i.test(entry.name)) {
        result.files.push(fullPath);
      }
    }
  }

  result.fileCount = result.files.length;
  return result;
}

function normalizedEffort(value) {
  return String(value || "").toLowerCase().replaceAll("_", "-");
}

async function readCustomAgentFile(filePath, root) {
  const stats = await statOrNull(filePath);
  let text = "";
  let parsed = { values: {}, sections: [] };
  let parseError = null;
  try {
    text = await fs.readFile(filePath, "utf8");
    parsed = parseTomlSummary(text);
  } catch (error) {
    parseError = error.message;
  }

  const nameEntry = tomlStringAssignment(text, "name");
  const descriptionEntry = tomlStringAssignment(text, "description");
  const developerEntry = tomlStringAssignment(text, "developer_instructions");
  const values = parsed.values || {};
  const sections = parsed.sections || [];
  const name = (nameEntry.present ? nameEntry.value : values.name) || path.basename(filePath, path.extname(filePath));
  const descriptionChars = descriptionEntry.chars || 0;
  const developerInstructionBytes = developerEntry.bytes || 0;
  const model = values.model || null;
  const effort = values.model_reasoning_effort || values.reasoning_effort || null;
  const effortText = normalizedEffort(effort);
  const highEffort = ["high", "xhigh", "extra-high"].includes(effortText);
  const mcpSummary = buildMcpConfigSummary(values, sections);
  const skillsConfigCount = sections.filter((section) => section === "skills.config").length;
  const missingRequired = [];
  if (!nameEntry.present || !String(nameEntry.value || "").trim()) missingRequired.push("name");
  if (!descriptionEntry.present || !String(descriptionEntry.value || "").trim()) missingRequired.push("description");
  if (!developerEntry.present || !String(developerEntry.value || "").trim()) missingRequired.push("developer_instructions");
  if (parseError) missingRequired.push("readable TOML");

  return {
    scope: root.scope,
    name,
    path: displayPath(filePath),
    bytes: stats?.isFile() ? stats.size : 0,
    mtime: stats?.mtime?.toISOString?.() || null,
    valid: missingRequired.length === 0,
    missingRequired,
    builtInOverride: builtInAgentNames.has(String(name).toLowerCase()),
    descriptionChars,
    developerInstructionBytes,
    model,
    reasoningEffort: effort,
    highEffort,
    modelOverride: Boolean(model),
    sandboxOverride: Boolean(values.sandbox_mode || values.approval_policy || values.approvals_reviewer),
    mcpServerCount: mcpSummary.enabledCount || 0,
    requiredMcpCount: mcpSummary.requiredCount || 0,
    missingMcpEnvVarCount: mcpSummary.missingEnvVarCount || 0,
    skillsConfigCount,
  };
}

async function getCustomAgentSummary(currentProject = null) {
  const roots = await customAgentRoots(currentProject);
  const discovered = await Promise.all(roots.map((root) => listCustomAgentFiles(root)));
  const files = [];
  for (const rootResult of discovered) {
    const root = roots.find((candidate) => displayPath(candidate.path) === rootResult.path) || roots.find((candidate) => candidate.scope === rootResult.scope) || {};
    for (const filePath of rootResult.files) files.push({ filePath, root });
  }

  if (!files.length) {
    return {
      ...emptyCustomAgentSummary(),
      roots: discovered.map((root) => ({
        scope: root.scope,
        label: root.label,
        path: root.path,
        exists: root.exists,
        fileCount: root.fileCount,
        dirCount: root.dirCount,
      })),
    };
  }

  const agents = await Promise.all(files.map((item) => readCustomAgentFile(item.filePath, item.root)));
  const nameCounts = agents.reduce((counts, agent) => {
    const key = String(agent.name || "").toLowerCase();
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});
  const duplicateNameCount = Object.values(nameCounts).filter((count) => count > 1).length;
  const invalidAgentCount = agents.filter((agent) => !agent.valid).length;
  const builtInOverrideCount = agents.filter((agent) => agent.builtInOverride).length;
  const highEffortCount = agents.filter((agent) => agent.highEffort).length;
  const modelOverrideCount = agents.filter((agent) => agent.modelOverride).length;
  const sandboxOverrideCount = agents.filter((agent) => agent.sandboxOverride).length;
  const mcpServerCount = agents.reduce((total, agent) => total + agent.mcpServerCount, 0);
  const requiredMcpCount = agents.reduce((total, agent) => total + agent.requiredMcpCount, 0);
  const missingMcpEnvVarCount = agents.reduce((total, agent) => total + agent.missingMcpEnvVarCount, 0);
  const skillsConfigCount = agents.reduce((total, agent) => total + agent.skillsConfigCount, 0);
  const totalDeveloperInstructionBytes = agents.reduce((total, agent) => total + agent.developerInstructionBytes, 0);
  const longDeveloperInstructionCount = agents.filter((agent) => agent.developerInstructionBytes >= largeInstructionFileBytes).length;
  const agentCount = agents.length;
  const projectAgentCount = agents.filter((agent) => agent.scope === "project").length;
  const globalAgentCount = agents.filter((agent) => agent.scope === "global").length;
  const highLoad =
    invalidAgentCount > 0 ||
    builtInOverrideCount > 0 ||
    missingMcpEnvVarCount > 0 ||
    totalDeveloperInstructionBytes >= 48 * 1024 ||
    longDeveloperInstructionCount >= 3;
  const mediumLoad =
    highLoad ||
    agentCount >= 6 ||
    highEffortCount > 0 ||
    modelOverrideCount >= 3 ||
    sandboxOverrideCount > 0 ||
    mcpServerCount >= 4 ||
    requiredMcpCount > 0 ||
    totalDeveloperInstructionBytes >= 12 * 1024 ||
    duplicateNameCount > 0;
  const tone = highLoad ? "high" : mediumLoad ? "medium" : "low";
  const label = `${agentCount.toLocaleString()} agent${agentCount === 1 ? "" : "s"}`;
  const action =
    tone === "low"
      ? "Keep narrow"
      : invalidAgentCount || missingMcpEnvVarCount
        ? "Fix agents"
        : builtInOverrideCount
          ? "Review override"
          : "Review agents";
  const detail =
    tone === "low"
      ? `Custom agents look tidy: ${agentCount.toLocaleString()} configured, ${formatBytesServer(totalDeveloperInstructionBytes)} of developer instructions.`
      : [
          "Custom agents are spawned only when requested, but each does its own model and tool work. Their files can override model, effort, sandbox, MCP, skills, and developer instructions for spawned sessions.",
          `Refit found ${agentCount.toLocaleString()} custom agent${agentCount === 1 ? "" : "s"} with ${formatBytesServer(totalDeveloperInstructionBytes)} of developer instructions.`,
          invalidAgentCount ? `${invalidAgentCount.toLocaleString()} agent file${invalidAgentCount === 1 ? "" : "s"} ${pluralVerb(invalidAgentCount)} missing required fields.` : null,
          builtInOverrideCount ? `${builtInOverrideCount.toLocaleString()} custom agent name${builtInOverrideCount === 1 ? "" : "s"} ${pluralVerb(builtInOverrideCount, "overrides", "override")} built-in agents.` : null,
          highEffortCount ? `${highEffortCount.toLocaleString()} agent${highEffortCount === 1 ? "" : "s"} ${pluralVerb(highEffortCount, "uses", "use")} high or xhigh reasoning.` : null,
          missingMcpEnvVarCount ? `${missingMcpEnvVarCount.toLocaleString()} MCP env var reference${missingMcpEnvVarCount === 1 ? "" : "s"} ${pluralVerb(missingMcpEnvVarCount)} missing.` : null,
        ]
          .filter(Boolean)
          .join(" ");

  return {
    status: "ready",
    tone,
    label,
    action,
    detail,
    agentCount,
    validAgentCount: agentCount - invalidAgentCount,
    invalidAgentCount,
    globalAgentCount,
    projectAgentCount,
    duplicateNameCount,
    builtInOverrideCount,
    highEffortCount,
    modelOverrideCount,
    sandboxOverrideCount,
    mcpServerCount,
    requiredMcpCount,
    missingMcpEnvVarCount,
    skillsConfigCount,
    totalDeveloperInstructionBytes,
    longDeveloperInstructionCount,
    roots: discovered.map((root) => ({
      scope: root.scope,
      label: root.label,
      path: root.path,
      exists: root.exists,
      fileCount: root.fileCount,
      dirCount: root.dirCount,
    })),
    agents: agents
      .sort((a, b) => {
        const aRisk = (!a.valid ? 6 : 0) + (a.builtInOverride ? 5 : 0) + (a.missingMcpEnvVarCount ? 4 : 0) + (a.highEffort ? 2 : 0) + a.developerInstructionBytes / 1024;
        const bRisk = (!b.valid ? 6 : 0) + (b.builtInOverride ? 5 : 0) + (b.missingMcpEnvVarCount ? 4 : 0) + (b.highEffort ? 2 : 0) + b.developerInstructionBytes / 1024;
        return bRisk - aRisk;
      })
      .slice(0, 12),
  };
}

function emptyCustomPromptSummary() {
  return {
    status: "ready",
    tone: "low",
    label: "None",
    action: "Use skills",
    detail: "No top-level custom prompt Markdown files were found.",
    promptCount: 0,
    totalBytes: 0,
    missingDescriptionCount: 0,
    argumentHintCount: 0,
    placeholderCount: 0,
    largePromptCount: 0,
    nestedMarkdownCount: 0,
    ignoredFileCount: 0,
    prompts: [],
  };
}

function promptPlaceholders(text) {
  const matches = String(text || "").match(/\$(?:ARGUMENTS|[1-9]|[A-Z][A-Z0-9_]*)/g) || [];
  return [...new Set(matches)];
}

async function readCustomPromptFile(filePath) {
  const stats = await statOrNull(filePath);
  let text = "";
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch {
    text = "";
  }
  const frontMatter = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  const metadataText = frontMatter ? frontMatter[1] : "";
  const description = yamlLikeField(metadataText, "description");
  const argumentHint = yamlLikeField(metadataText, "argument-hint");
  const placeholders = promptPlaceholders(text);

  return {
    name: path.basename(filePath, path.extname(filePath)),
    path: displayPath(filePath),
    bytes: stats?.isFile() ? stats.size : 0,
    mtime: stats?.mtime?.toISOString?.() || null,
    hasDescription: Boolean(description),
    hasArgumentHint: Boolean(argumentHint),
    placeholderCount: placeholders.length,
    large: (stats?.size || 0) >= largeInstructionFileBytes,
  };
}

async function getCustomPromptSummary() {
  const rootStats = await statOrNull(paths.customPrompts);
  if (!rootStats?.isDirectory()) return emptyCustomPromptSummary();

  let entries = [];
  try {
    entries = await fs.readdir(paths.customPrompts, { withFileTypes: true });
  } catch {
    return emptyCustomPromptSummary();
  }

  const promptFiles = [];
  let nestedMarkdownCount = 0;
  let ignoredFileCount = 0;

  for (const entry of entries) {
    const fullPath = path.join(paths.customPrompts, entry.name);
    if (entry.isFile() && /\.md$/i.test(entry.name)) {
      promptFiles.push(fullPath);
      continue;
    }
    if (entry.isDirectory()) {
      try {
        const nested = await fs.readdir(fullPath, { withFileTypes: true });
        nestedMarkdownCount += nested.filter((nestedEntry) => nestedEntry.isFile() && /\.md$/i.test(nestedEntry.name)).length;
      } catch {
        // Ignore unreadable nested prompt folders; Codex ignores nested prompt files too.
      }
      continue;
    }
    if (entry.isFile()) ignoredFileCount += 1;
  }

  if (!promptFiles.length) {
    return {
      ...emptyCustomPromptSummary(),
      nestedMarkdownCount,
      ignoredFileCount,
      detail:
        nestedMarkdownCount || ignoredFileCount
          ? `No top-level custom prompt Markdown files were found. Codex ignores nested prompt Markdown and non-Markdown files in ${displayPath(paths.customPrompts)}.`
          : "No top-level custom prompt Markdown files were found.",
    };
  }

  const prompts = await Promise.all(promptFiles.map(readCustomPromptFile));
  const promptCount = prompts.length;
  const totalBytes = prompts.reduce((total, prompt) => total + prompt.bytes, 0);
  const missingDescriptionCount = prompts.filter((prompt) => !prompt.hasDescription).length;
  const argumentHintCount = prompts.filter((prompt) => prompt.hasArgumentHint).length;
  const placeholderCount = prompts.reduce((total, prompt) => total + prompt.placeholderCount, 0);
  const largePromptCount = prompts.filter((prompt) => prompt.large).length;
  const highLoad = promptCount >= 20 || totalBytes >= 64 * 1024 || largePromptCount >= 4;
  const mediumLoad = highLoad || promptCount > 0;
  const tone = highLoad ? "high" : mediumLoad ? "medium" : "low";
  const label = `${promptCount.toLocaleString()} prompt${promptCount === 1 ? "" : "s"}`;
  const action = highLoad ? "Migrate to skills" : "Review or migrate";
  const detail = [
    "Custom prompts are deprecated; Codex recommends skills for reusable instructions that should be invoked explicitly or implicitly.",
    `Refit found ${promptCount.toLocaleString()} top-level prompt Markdown file${promptCount === 1 ? "" : "s"} totaling ${formatBytesServer(totalBytes)}.`,
    missingDescriptionCount ? `${missingDescriptionCount.toLocaleString()} prompt${missingDescriptionCount === 1 ? "" : "s"} ${pluralVerb(missingDescriptionCount)} missing description metadata.` : null,
    nestedMarkdownCount ? `${nestedMarkdownCount.toLocaleString()} nested Markdown prompt${nestedMarkdownCount === 1 ? "" : "s"} will be ignored by Codex.` : null,
  ]
    .filter(Boolean)
    .join(" ");

  return {
    status: "ready",
    tone,
    label,
    action,
    detail,
    promptCount,
    totalBytes,
    missingDescriptionCount,
    argumentHintCount,
    placeholderCount,
    largePromptCount,
    nestedMarkdownCount,
    ignoredFileCount,
    prompts: prompts
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, 12),
  };
}

function mcpEnvVarNames(values, section) {
  const names = [];
  const add = (value) => {
    if (typeof value !== "string") return;
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) names.push(value);
  };

  for (const name of tomlArrayStringNames(values[`${section}.env_vars`])) add(name);
  add(values[`${section}.bearer_token_env_var`]);

  for (const value of tomlInlineTableValues(values[`${section}.env_http_headers`])) add(value);
  const envHttpPrefix = `${section}.env_http_headers.`;
  for (const [key, value] of Object.entries(values)) {
    if (key.startsWith(envHttpPrefix)) add(value);
  }

  return [...new Set(names)];
}

function mcpInlineEnvCount(values, section) {
  let count = 0;
  if (values[`${section}.env`]) {
    count += tomlInlineTableValues(values[`${section}.env`]).length;
  }
  const envPrefix = `${section}.env.`;
  for (const key of Object.keys(values)) {
    if (key.startsWith(envPrefix)) count += 1;
  }
  return count;
}

function pluralVerb(count, singular = "was", plural = "were") {
  return Number(count) === 1 ? singular : plural;
}

function buildMcpConfigSummary(values = {}, sections = []) {
  const descriptors = mcpServerDescriptors(sections);
  const servers = descriptors.map((descriptor) => {
    const section = descriptor.section;
    const pluginEnabled = descriptor.pluginSection ? values[`${descriptor.pluginSection}.enabled`] !== false : true;
    const enabled = pluginEnabled && values[`${section}.enabled`] !== false;
    const hasCommand = Boolean(values[`${section}.command`]);
    const hasUrl = Boolean(values[`${section}.url`]);
    const transport = hasCommand ? "stdio" : hasUrl ? "http" : "unknown";
    const startupTimeoutSec = configNumber(values[`${section}.startup_timeout_sec`]) ?? 10;
    const toolTimeoutSec = configNumber(values[`${section}.tool_timeout_sec`]) ?? 60;
    const envVarNames = mcpEnvVarNames(values, section);
    const missingEnvVarCount = envVarNames.filter((name) => process.env[name] === undefined).length;
    const inlineEnvCount = mcpInlineEnvCount(values, section);
    const hasToolFilter = Boolean(values[`${section}.enabled_tools`] || values[`${section}.disabled_tools`]);

    return {
      scope: descriptor.scope,
      name: descriptor.name,
      enabled,
      required: enabled && values[`${section}.required`] === true,
      transport,
      remoteStdio: enabled && hasCommand && values[`${section}.experimental_environment`] === "remote",
      startupTimeoutSec,
      toolTimeoutSec,
      envVarCount: envVarNames.length,
      missingEnvVarCount,
      inlineEnvCount,
      hasToolFilter,
      defaultToolsApprovalMode: values[`${section}.default_tools_approval_mode`] || null,
      configured: {
        command: hasCommand,
        url: hasUrl,
      },
    };
  });

  const enabledServers = servers.filter((server) => server.enabled);
  const enabledCount = enabledServers.length;
  const requiredCount = enabledServers.filter((server) => server.required).length;
  const stdioCount = enabledServers.filter((server) => server.transport === "stdio").length;
  const httpCount = enabledServers.filter((server) => server.transport === "http").length;
  const unknownTransportCount = enabledServers.filter((server) => server.transport === "unknown").length;
  const remoteStdioCount = enabledServers.filter((server) => server.remoteStdio).length;
  const pluginMcpCount = enabledServers.filter((server) => server.scope === "plugin").length;
  const missingEnvVarCount = enabledServers.reduce((total, server) => total + server.missingEnvVarCount, 0);
  const longStartupTimeoutCount = enabledServers.filter((server) => server.startupTimeoutSec > 20).length;
  const longToolTimeoutCount = enabledServers.filter((server) => server.toolTimeoutSec > 120).length;
  const unfilteredToolServerCount = enabledServers.filter((server) => !server.hasToolFilter).length;
  const broadApprovalServerCount = enabledServers.filter((server) => server.defaultToolsApprovalMode === "approve").length;
  const highLoad = enabledCount >= 12 || requiredCount >= 3 || missingEnvVarCount >= 3 || unknownTransportCount > 0;
  const mediumLoad =
    highLoad ||
    enabledCount >= 6 ||
    requiredCount > 0 ||
    pluginMcpCount >= 4 ||
    missingEnvVarCount > 0 ||
    longStartupTimeoutCount > 0 ||
    longToolTimeoutCount > 0;
  const tone = highLoad ? "high" : mediumLoad ? "medium" : "low";
  const label = enabledCount ? `${enabledCount.toLocaleString()} enabled` : descriptors.length ? "Disabled" : "None";
  const detail = enabledCount
    ? `${enabledCount.toLocaleString()} enabled MCP server${enabledCount === 1 ? "" : "s"}: ${stdioCount.toLocaleString()} stdio, ${httpCount.toLocaleString()} HTTP, ${pluginMcpCount.toLocaleString()} plugin-provided. ${requiredCount.toLocaleString()} required server${requiredCount === 1 ? "" : "s"} can fail session startup if initialization breaks.`
    : descriptors.length
      ? `${descriptors.length.toLocaleString()} MCP server${descriptors.length === 1 ? "" : "s"} configured but disabled.`
      : "No configured MCP servers were found in user or current trusted project config.";

  return {
    status: "ready",
    tone,
    label,
    configuredCount: descriptors.length,
    enabledCount,
    disabledCount: servers.filter((server) => !server.enabled).length,
    requiredCount,
    stdioCount,
    httpCount,
    unknownTransportCount,
    remoteStdioCount,
    pluginMcpCount,
    missingEnvVarCount,
    longStartupTimeoutCount,
    longToolTimeoutCount,
    unfilteredToolServerCount,
    broadApprovalServerCount,
    servers,
    detail:
      missingEnvVarCount > 0
        ? `${detail} ${missingEnvVarCount.toLocaleString()} referenced environment variable${missingEnvVarCount === 1 ? "" : "s"} ${pluralVerb(missingEnvVarCount)} not visible to this Refit process.`
        : detail,
  };
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

function processCommandLabel(command) {
  const text = String(command || "").trim();
  if (!text) return "command";
  const lower = text.toLowerCase();
  if (lower.includes("npm ")) return "npm";
  if (lower.includes("pnpm ")) return "pnpm";
  if (lower.includes("yarn ")) return "yarn";
  if (lower.includes("vite")) return "vite";
  if (lower.includes("sqlite3")) return "sqlite3";
  if (lower.includes("python")) return "python";
  if (lower.includes("node")) return "node";
  if (lower.includes("zsh")) return "shell";
  if (lower.includes("bash")) return "shell";
  const first = text.match(/^"([^"]+)"|^'([^']+)'|^(\S+)/)?.slice(1).find(Boolean) || "command";
  return path.basename(first).replace(/[^\w.-]/g, "").slice(0, 24) || "command";
}

function shouldCountBackgroundCommand(processInfo) {
  if (processInfo.kind) return false;
  const label = processInfo.commandLabel;
  if (["ps", "rg", "sed", "awk", "curl"].includes(label)) return false;
  if (/server\.mjs|codex-refit|Codex Refit/i.test(processInfo.command)) return false;
  if (processInfo.ageSeconds >= 30) return true;
  if (processInfo.cpuPercent >= 5) return true;
  return processInfo.rssBytes >= 100 * 1024 ** 2;
}

function summarizeBackgroundCommands(allProcesses, codexRoots) {
  const childrenByParent = new Map();
  for (const processInfo of allProcesses) {
    const list = childrenByParent.get(processInfo.ppid) || [];
    list.push(processInfo);
    childrenByParent.set(processInfo.ppid, list);
  }

  const seen = new Set(codexRoots);
  const queue = [...codexRoots];
  const descendants = [];
  while (queue.length) {
    const pid = queue.shift();
    for (const child of childrenByParent.get(pid) || []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      if (!child.kind) descendants.push(child);
      queue.push(child.pid);
    }
  }

  const commands = descendants.filter(shouldCountBackgroundCommand);
  const rssBytes = commands.reduce((total, processInfo) => total + processInfo.rssBytes, 0);
  const cpuPercent = commands.reduce((total, processInfo) => total + processInfo.cpuPercent, 0);
  const longestAgeSeconds = commands.reduce((max, processInfo) => Math.max(max, processInfo.ageSeconds || 0), 0);
  const countByLabel = commands.reduce((counts, processInfo) => {
    counts[processInfo.commandLabel] = (counts[processInfo.commandLabel] || 0) + 1;
    return counts;
  }, {});
  const largest = [...commands]
    .sort((a, b) => b.rssBytes + b.cpuPercent * 20 * 1024 ** 2 - (a.rssBytes + a.cpuPercent * 20 * 1024 ** 2))
    .slice(0, 4)
    .map((processInfo) => ({
      label: processInfo.commandLabel,
      rssBytes: processInfo.rssBytes,
      cpuPercent: Number(processInfo.cpuPercent.toFixed(1)),
      ageSeconds: processInfo.ageSeconds,
    }));

  const highLoad = commands.length >= 4 || cpuPercent >= 50 || rssBytes >= 2 * 1024 ** 3;
  const mediumLoad = commands.length >= 1 || cpuPercent >= 10 || rssBytes >= 512 * 1024 ** 2;
  const tone = highLoad ? "high" : mediumLoad ? "medium" : "low";
  const detail =
    commands.length === 0
      ? "No long-running background terminal commands were found under Codex."
      : tone === "high"
        ? `Refit sees ${commands.length.toLocaleString()} background command${commands.length === 1 ? "" : "s"} under Codex using ${formatBytesServer(rssBytes)} and about ${cpuPercent.toFixed(0)}% CPU. Use /ps to inspect and /stop when the work is no longer needed.`
        : `Refit sees ${commands.length.toLocaleString()} background command${commands.length === 1 ? "" : "s"} under Codex using ${formatBytesServer(rssBytes)}. Use /ps before judging local cleanup.`;

  return {
    status: "ready",
    tone,
    label: tone === "high" ? "Busy" : tone === "medium" ? "Running" : "Quiet",
    processCount: commands.length,
    rssBytes,
    cpuPercent: Number(cpuPercent.toFixed(1)),
    longestAgeSeconds,
    longestAgeLabel: longestAgeSeconds ? formatAgeServer(longestAgeSeconds) : "None",
    detail,
    action: tone === "low" ? "Keep current" : "Use /ps",
    largest,
    counts: countByLabel,
  };
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

function buildBackgroundTerminalSnippet() {
  return [
    "# In the active Codex thread:",
    "/ps",
    "",
    "# Stop background terminal work only after confirming it is no longer needed:",
    "/stop",
  ].join("\n");
}

async function getCodexProcessSummary() {
  try {
    const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,rss=,pcpu=,etime=,command="], {
      timeout: 3000,
      maxBuffer: 2 * 1024 * 1024,
    });
    const allProcesses = String(stdout || "")
      .split(/\r?\n/)
      .map((line) => {
        const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+([0-9.]+)\s+(\S+)\s+(.+)$/);
        if (!match) return null;
        const command = match[6];
        const kind = codexProcessKind(command);
        return {
          pid: Number(match[1]),
          ppid: Number(match[2]),
          kind,
          label: kind ? codexProcessLabel(kind) : processCommandLabel(command),
          commandLabel: processCommandLabel(command),
          command,
          rssBytes: (Number(match[3]) || 0) * 1024,
          cpuPercent: Number(match[4]) || 0,
          ageSeconds: parsePsElapsedSeconds(match[5]),
        };
      })
      .filter(Boolean);

    const processes = allProcesses.filter((processInfo) => processInfo.kind);
    const pressureProcesses = processes.filter((processInfo) => !["refit", "crashpad"].includes(processInfo.kind));
    const pressurePids = new Set(pressureProcesses.map((processInfo) => processInfo.pid));
    const background = summarizeBackgroundCommands(allProcesses, pressurePids);
    const countByKind = pressureProcesses.reduce((counts, processInfo) => {
      counts[processInfo.kind] = (counts[processInfo.kind] || 0) + 1;
      return counts;
    }, {});
    const rssBytes = pressureProcesses.reduce((total, processInfo) => total + processInfo.rssBytes, 0);
    const cpuPercent = pressureProcesses.reduce((total, processInfo) => total + processInfo.cpuPercent, 0);
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
      cpuPercent: Number(cpuPercent.toFixed(1)),
      longestAgeSeconds,
      longestAgeLabel: longestAgeSeconds ? formatAgeServer(longestAgeSeconds) : "None",
      detail,
      action: tone === "low" ? "Keep current" : tone === "medium" ? "Close idle threads" : "Restart after active work",
      largest,
      counts: countByKind,
      background,
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
      cpuPercent: 0,
      longestAgeSeconds: 0,
      longestAgeLabel: "Unknown",
      detail: `Refit could not read live process load: ${error.message}`,
      action: "Run ps manually",
      largest: [],
      counts: {},
      background: {
        status: "unavailable",
        tone: "medium",
        label: "Unknown",
        processCount: 0,
        rssBytes: 0,
        cpuPercent: 0,
        longestAgeSeconds: 0,
        longestAgeLabel: "Unknown",
        detail: `Refit could not read background terminal load: ${error.message}`,
        action: "Run /ps",
        largest: [],
        counts: {},
      },
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

function emptyLocalEnvironmentSummary({ hasCodexDir = false, hasUsefulPackageScripts = false } = {}) {
  return {
    status: hasCodexDir ? "empty" : "missing",
    tone: hasUsefulPackageScripts ? "medium" : "low",
    label: hasCodexDir ? "Not set up" : "No .codex",
    action: hasUsefulPackageScripts ? "Add setup/actions" : "Document setup",
    detail: hasCodexDir
      ? "No Codex local environment setup scripts or app actions were found in this project's .codex folder."
      : "No project .codex folder was found. Codex local environments live there when you share setup scripts and app actions.",
    configFileCount: 0,
    candidateFileCount: 0,
    setupScriptCount: 0,
    actionCount: 0,
    platformSpecificCount: 0,
    scriptLikeCount: 0,
    parseWarningCount: 0,
    hasSetupScript: false,
    hasActions: false,
    hasPackageCommands: hasUsefulPackageScripts,
    files: [],
  };
}

function localEnvironmentNameLooksRelevant(name) {
  return /(^|[-_.])(local|env|environment|environments|action|actions|setup|setups|worktree|worktrees|workspace)([-_.]|$)/i.test(
    String(name || ""),
  );
}

function localEnvironmentExtensionLooksRelevant(name) {
  return /\.(jsonc?|ya?ml|toml|txt|md)$/i.test(String(name || ""));
}

function localEnvironmentKeyLooksInteresting(key) {
  return /\b(setup|action|script|command|macos|darwin|linux|windows|win32|worktree|environment)\b/i.test(
    String(key || "").replaceAll("_", " "),
  );
}

function localEnvironmentStringLooksScript(value) {
  const text = String(value || "").trim();
  if (!text || text.length > 12000) return false;
  return /\b(npm|pnpm|yarn|bun|node|vite|electron|make|cargo|go|python|pytest|poetry|pip|bundle|composer|dotnet|swift|xcodebuild|cmake|gradle|mvn|install|build|test|lint|typecheck|dev|start)\b|&&|\|\||\n/i.test(
    text,
  );
}

function countScriptLikeValues(value, depth = 0) {
  if (depth > 6 || value === null || value === undefined) return 0;
  if (typeof value === "string") return localEnvironmentStringLooksScript(value) ? 1 : 0;
  if (Array.isArray(value)) return value.reduce((total, item) => total + countScriptLikeValues(item, depth + 1), 0);
  if (typeof value !== "object") return 0;
  return Object.entries(value).reduce((total, [key, item]) => {
    const keyLooksRunnable = /\b(script|command|cmd|run|shell)\b/i.test(String(key || "").replaceAll("_", " "));
    if (keyLooksRunnable && typeof item === "string" && localEnvironmentStringLooksScript(item)) return total + 1;
    return total + countScriptLikeValues(item, depth + 1);
  }, 0);
}

function countActionLikeValues(value, depth = 0) {
  if (depth > 5 || value === null || value === undefined) return 0;
  if (typeof value === "string") return localEnvironmentStringLooksScript(value) ? 1 : 0;
  if (Array.isArray(value)) return value.reduce((total, item) => total + countActionLikeValues(item, depth + 1), 0);
  if (typeof value !== "object") return 0;

  const entries = Object.entries(value);
  const hasActionShape = entries.some(([key]) => /\b(name|label|title|description|script|command|cmd|run)\b/i.test(key));
  const scriptCount = countScriptLikeValues(value, depth + 1);
  if (hasActionShape && scriptCount) return 1;

  return entries.reduce((total, [key, item]) => {
    if (/action/i.test(key)) return total + countActionLikeValues(item, depth + 1);
    return total;
  }, 0);
}

function analyzeLocalEnvironmentJson(value) {
  const foundKeys = new Set();
  const counts = {
    setupScriptCount: 0,
    actionCount: 0,
    platformSpecificCount: 0,
    scriptLikeCount: 0,
  };

  const visit = (node, parentKey = "", depth = 0) => {
    if (depth > 8 || node === null || node === undefined) return;
    if (typeof node === "string") {
      if (localEnvironmentStringLooksScript(node)) counts.scriptLikeCount += 1;
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) visit(item, parentKey, depth + 1);
      return;
    }
    if (typeof node !== "object") return;

    for (const [key, item] of Object.entries(node)) {
      const normalized = String(key || "").toLowerCase().replaceAll("_", " ");
      const interesting = localEnvironmentKeyLooksInteresting(normalized);
      if (interesting && foundKeys.size < 18) foundKeys.add(key);

      if (/\b(macos|darwin|linux|windows|win32)\b/.test(normalized) && countScriptLikeValues(item)) {
        counts.platformSpecificCount += 1;
      }
      if (/\bsetup|worktree\b/.test(normalized)) {
        counts.setupScriptCount += countScriptLikeValues(item);
      }
      if (/\bactions?\b/.test(normalized)) {
        counts.actionCount += countActionLikeValues(item);
      }
      if (/\b(script|command|cmd|run|shell)\b/.test(normalized) && localEnvironmentStringLooksScript(item)) {
        counts.scriptLikeCount += 1;
      }

      visit(item, `${parentKey} ${normalized}`.trim(), depth + 1);
    }
  };

  visit(value);
  return {
    ...counts,
    keys: [...foundKeys],
  };
}

function analyzeLocalEnvironmentText(text) {
  const { values, sections } = parseTomlSummary(text);
  const foundKeys = new Set();
  let setupScriptCount = 0;
  let actionCount = 0;
  let platformSpecificCount = 0;
  let scriptLikeCount = 0;

  for (const section of sections) {
    if (localEnvironmentKeyLooksInteresting(section) && foundKeys.size < 18) foundKeys.add(section);
  }

  for (const [key, value] of Object.entries(values)) {
    const normalized = String(key || "").toLowerCase().replaceAll("_", " ");
    const scriptLike = countScriptLikeValues(value);
    if (localEnvironmentKeyLooksInteresting(normalized) && foundKeys.size < 18) foundKeys.add(key);
    if (scriptLike) scriptLikeCount += scriptLike;
    if (scriptLike && /\b(setup|worktree)\b/.test(normalized)) setupScriptCount += scriptLike;
    if (scriptLike && /\bactions?\b/.test(normalized)) actionCount += 1;
    if (scriptLike && /\b(macos|darwin|linux|windows|win32)\b/.test(normalized)) platformSpecificCount += 1;
  }

  const raw = String(text || "");
  if (!setupScriptCount && /\b(setup|worktree)\b[\s\S]{0,240}\b(npm|pnpm|yarn|bun|make|install|build|test)\b/i.test(raw)) {
    setupScriptCount = 1;
  }
  if (!actionCount && /\bactions?\b[\s\S]{0,260}\b(script|command|npm|pnpm|yarn|bun|build|test|dev|start)\b/i.test(raw)) {
    actionCount = 1;
  }
  if (!platformSpecificCount && /\b(macos|darwin|linux|windows|win32)\b[\s\S]{0,220}\b(script|command|npm|pnpm|yarn|bun|make)\b/i.test(raw)) {
    platformSpecificCount = 1;
  }

  return {
    setupScriptCount,
    actionCount,
    platformSpecificCount,
    scriptLikeCount,
    keys: [...foundKeys],
  };
}

async function localEnvironmentCandidateFiles(codexDir) {
  const files = [];
  const seen = new Set();

  const addFile = async (filePath, depth) => {
    if (files.length >= 40) return;
    const resolved = path.resolve(filePath);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    const stats = await statOrNull(resolved);
    if (!stats?.isFile() || stats.size > 256 * 1024) return;
    const name = path.basename(resolved);
    if (!localEnvironmentExtensionLooksRelevant(name)) return;
    files.push({ path: resolved, name, bytes: stats.size, depth });
  };

  const visit = async (dir, depth = 0) => {
    if (files.length >= 40 || depth > 2) return;
    let entries = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (files.length >= 40) break;
      const fullPath = path.join(dir, entry.name);
      if (entry.isFile()) {
        const relevant =
          localEnvironmentNameLooksRelevant(entry.name) ||
          (depth === 0 && /^config\.toml$/i.test(entry.name)) ||
          localEnvironmentNameLooksRelevant(path.basename(dir));
        if (relevant) await addFile(fullPath, depth);
        continue;
      }
      if (!entry.isDirectory()) continue;
      if (["agents", "rules", "hooks"].includes(entry.name.toLowerCase())) continue;
      if (depth < 2 && localEnvironmentNameLooksRelevant(entry.name)) await visit(fullPath, depth + 1);
    }
  };

  await visit(codexDir);
  return files;
}

async function summarizeLocalEnvironmentFile(file) {
  const summary = {
    path: file.path,
    name: file.name,
    bytes: file.bytes,
    format: path.extname(file.name).replace(/^\./, "").toLowerCase() || "text",
    setupScriptCount: 0,
    actionCount: 0,
    platformSpecificCount: 0,
    scriptLikeCount: 0,
    keys: [],
    parseWarning: null,
  };

  let text = "";
  try {
    text = await fs.readFile(file.path, "utf8");
  } catch (error) {
    summary.parseWarning = error.message;
    return summary;
  }

  try {
    const jsonLike = /\.(json|jsonc)$/i.test(file.name);
    const parsed = jsonLike ? JSON.parse(text.replace(/^\uFEFF/, "")) : null;
    const analysis = jsonLike ? analyzeLocalEnvironmentJson(parsed) : analyzeLocalEnvironmentText(text);
    Object.assign(summary, analysis);
  } catch (error) {
    summary.parseWarning = error.message;
    Object.assign(summary, analyzeLocalEnvironmentText(text));
  }

  summary.setupScriptCount = Math.max(0, Number(summary.setupScriptCount || 0));
  summary.actionCount = Math.max(0, Number(summary.actionCount || 0));
  summary.platformSpecificCount = Math.max(0, Number(summary.platformSpecificCount || 0));
  summary.scriptLikeCount = Math.max(0, Number(summary.scriptLikeCount || 0));
  summary.keys = (summary.keys || []).slice(0, 18);
  return summary;
}

async function getLocalEnvironmentSummary({ codexDir, hasCodexDir = false, packageScripts = {} } = {}) {
  const hasUsefulPackageScripts = Object.values(packageScripts || {}).some(scriptLooksUseful);
  if (!hasCodexDir) return emptyLocalEnvironmentSummary({ hasCodexDir, hasUsefulPackageScripts });

  const candidates = await localEnvironmentCandidateFiles(codexDir);
  const files = await Promise.all(candidates.map((file) => summarizeLocalEnvironmentFile(file)));
  const configFiles = files.filter((file) => file.setupScriptCount || file.actionCount || file.keys.length || file.parseWarning);
  const setupScriptCount = files.reduce((total, file) => total + file.setupScriptCount, 0);
  const actionCount = files.reduce((total, file) => total + file.actionCount, 0);
  const platformSpecificCount = files.reduce((total, file) => total + file.platformSpecificCount, 0);
  const scriptLikeCount = files.reduce((total, file) => total + file.scriptLikeCount, 0);
  const parseWarningCount = files.filter((file) => file.parseWarning).length;
  const hasSetupScript = setupScriptCount > 0;
  const hasActions = actionCount > 0;
  const configured = hasSetupScript || hasActions;
  const missingUsefulPieces = hasUsefulPackageScripts && (!hasSetupScript || !hasActions);
  const tone = parseWarningCount && !configured ? "medium" : missingUsefulPieces ? "medium" : "low";
  const label = configured
    ? `${setupScriptCount.toLocaleString()} setup / ${actionCount.toLocaleString()} actions`
    : candidates.length
      ? "No setup/actions"
      : "Not set up";
  const action = configured
    ? missingUsefulPieces
      ? "Finish setup/actions"
      : "Keep shared"
    : hasUsefulPackageScripts
      ? "Add setup/actions"
      : "Document setup";
  const detail = configured
    ? `Refit found ${setupScriptCount.toLocaleString()} setup script${setupScriptCount === 1 ? "" : "s"} and ${actionCount.toLocaleString()} app action${actionCount === 1 ? "" : "s"} in project .codex local-environment files.${platformSpecificCount ? ` ${platformSpecificCount.toLocaleString()} platform-specific override${platformSpecificCount === 1 ? "" : "s"} ${pluralVerb(platformSpecificCount)} detected.` : ""}`
    : hasUsefulPackageScripts
      ? "This project has useful package scripts, but Refit did not find Codex local-environment setup/actions under .codex. Add them through Codex app settings so new worktrees and common commands do not need rediscovery."
      : "Refit did not find Codex local-environment setup/actions under .codex. Add them when this project needs repeat setup, build, test, or dev-server commands.";

  return {
    status: "ready",
    tone,
    label,
    action,
    detail: parseWarningCount ? `${detail} ${parseWarningCount.toLocaleString()} candidate file${parseWarningCount === 1 ? "" : "s"} could not be parsed cleanly.` : detail,
    configFileCount: configFiles.length,
    candidateFileCount: candidates.length,
    setupScriptCount,
    actionCount,
    platformSpecificCount,
    scriptLikeCount,
    parseWarningCount,
    hasSetupScript,
    hasActions,
    hasPackageCommands: hasUsefulPackageScripts,
    files: files
      .filter((file) => file.setupScriptCount || file.actionCount || file.parseWarning)
      .slice(0, 8)
      .map((file) => ({
        name: file.name,
        bytes: file.bytes,
        format: file.format,
        setupScriptCount: file.setupScriptCount,
        actionCount: file.actionCount,
        platformSpecificCount: file.platformSpecificCount,
        parseWarning: file.parseWarning ? "parse warning" : null,
        keys: file.keys,
      })),
  };
}

function emptyHookSource({ scope, format, sourcePath, active = true, exists = false, error = null }) {
  return {
    scope,
    format,
    path: sourcePath,
    active,
    exists,
    error,
    groupCount: 0,
    commandCount: 0,
    turnScopedCommandCount: 0,
    broadMatcherCount: 0,
    eventCounts: {},
  };
}

function incrementHookEvent(source, event, commandCount = 0) {
  if (!hookEvents.includes(event)) return;
  source.eventCounts[event] = (source.eventCounts[event] || 0) + commandCount;
  source.commandCount += commandCount;
  if (turnScopedHookEvents.has(event)) source.turnScopedCommandCount += commandCount;
}

function summarizeHookJsonConfig(json, source) {
  const hooks = json?.hooks && typeof json.hooks === "object" ? json.hooks : json;
  if (!hooks || typeof hooks !== "object") return source;

  for (const event of hookEvents) {
    const groups = Array.isArray(hooks[event]) ? hooks[event] : [];
    source.groupCount += groups.length;
    for (const group of groups) {
      if (!group || typeof group !== "object") continue;
      const matcher = group.matcher === undefined ? "*" : String(group.matcher);
      if (matcher === "*" || matcher === ".*") source.broadMatcherCount += 1;
      const handlers = Array.isArray(group.hooks) ? group.hooks : [];
      const commandCount = handlers.filter((handler) => handler && typeof handler === "object").length;
      incrementHookEvent(source, event, commandCount);
    }
  }
  return source;
}

function summarizeInlineTomlHooks(text, source) {
  let currentEvent = null;
  let inHandler = false;
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const handlerMatch = line.match(/^\[\[hooks\.([A-Za-z]+)\.hooks\]\]$/);
    if (handlerMatch) {
      currentEvent = handlerMatch[1];
      inHandler = true;
      continue;
    }
    const groupMatch = line.match(/^\[\[hooks\.([A-Za-z]+)\]\]$/);
    if (groupMatch) {
      currentEvent = groupMatch[1];
      inHandler = false;
      if (hookEvents.includes(currentEvent)) source.groupCount += 1;
      continue;
    }
    if (!currentEvent || !hookEvents.includes(currentEvent)) continue;
    if (/^matcher\s*=\s*["']?\*["']?\s*$/.test(line) || /^matcher\s*=\s*["']?\.\*["']?\s*$/.test(line)) {
      source.broadMatcherCount += 1;
    }
    if (inHandler && /^command(?:_windows)?\s*=/.test(line)) {
      incrementHookEvent(source, currentEvent, 1);
      inHandler = false;
    }
  }
  return source;
}

async function summarizeHooksJsonFile(sourcePath, { scope, active = true } = {}) {
  const existsOnDisk = await exists(sourcePath);
  const source = emptyHookSource({ scope, format: "hooks.json", sourcePath, active, exists: existsOnDisk });
  if (!existsOnDisk) return source;
  const json = await readJsonOrNull(sourcePath);
  if (!json) return { ...source, error: "Could not parse hooks.json" };
  return summarizeHookJsonConfig(json, source);
}

async function summarizeInlineHooksFile(sourcePath, { scope, active = true, text = null } = {}) {
  const existsOnDisk = text !== null || (await exists(sourcePath));
  const source = emptyHookSource({ scope, format: "config.toml", sourcePath, active, exists: existsOnDisk });
  if (!existsOnDisk) return source;
  try {
    const configText = text ?? (await fs.readFile(sourcePath, "utf8"));
    return summarizeInlineTomlHooks(configText, source);
  } catch (error) {
    return { ...source, error: error.message };
  }
}

function mergeHookSources(sources, hooksFeature = true) {
  const activeSources = sources.filter((source) => source.exists && source.active);
  const commandCount = activeSources.reduce((total, source) => total + source.commandCount, 0);
  const turnScopedCommandCount = activeSources.reduce((total, source) => total + source.turnScopedCommandCount, 0);
  const groupCount = activeSources.reduce((total, source) => total + source.groupCount, 0);
  const broadMatcherCount = activeSources.reduce((total, source) => total + source.broadMatcherCount, 0);
  const eventCounts = {};
  for (const source of activeSources) {
    for (const [event, count] of Object.entries(source.eventCounts || {})) {
      eventCounts[event] = (eventCounts[event] || 0) + count;
    }
  }
  const highLoad = hooksFeature && (turnScopedCommandCount >= 6 || commandCount >= 10 || broadMatcherCount >= 4);
  const mediumLoad = hooksFeature && (turnScopedCommandCount >= 2 || commandCount >= 4 || broadMatcherCount >= 1);
  const tone = !hooksFeature ? "low" : highLoad ? "high" : mediumLoad ? "medium" : "low";
  const label = !hooksFeature ? "Disabled" : commandCount ? `${commandCount.toLocaleString()} hooks` : "None";
  const detail =
    !hooksFeature
      ? "Lifecycle hooks are disabled by config."
      : commandCount
        ? `${commandCount.toLocaleString()} hook command${commandCount === 1 ? "" : "s"} can load from ${activeSources.length.toLocaleString()} active source${activeSources.length === 1 ? "" : "s"}; ${turnScopedCommandCount.toLocaleString()} can run at turn or tool scope. Use /hooks to review trust and disable stale hooks.`
        : "No active lifecycle hook commands were found in user or current trusted project config.";

  return {
    hooksFeature,
    status: "ready",
    tone,
    label,
    sourceCount: activeSources.length,
    groupCount,
    commandCount,
    turnScopedCommandCount,
    broadMatcherCount,
    eventCounts,
    sources,
    detail,
  };
}

async function getHookConfigSummary({ hooksFeature = true, globalConfigText = null, currentProject = null } = {}) {
  const sources = [
    await summarizeHooksJsonFile(paths.globalHooks, { scope: "user" }),
    await summarizeInlineHooksFile(paths.configToml, { scope: "user", text: globalConfigText }),
  ];

  if (currentProject?.path && currentProject.exists) {
    const projectCodexDir = path.join(currentProject.path, ".codex");
    sources.push(
      await summarizeHooksJsonFile(path.join(projectCodexDir, "hooks.json"), { scope: "current project" }),
      await summarizeInlineHooksFile(path.join(projectCodexDir, "config.toml"), { scope: "current project" }),
    );
  }

  return mergeHookSources(sources, hooksFeature);
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
    hasLocalEnvironment: false,
    localEnvironment: emptyLocalEnvironmentSummary(),
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

  summary.localEnvironment = await getLocalEnvironmentSummary({
    codexDir,
    hasCodexDir: summary.hasCodexDir,
    packageScripts: summary.scripts,
  });
  summary.hasLocalEnvironment = summary.localEnvironment.hasSetupScript || summary.localEnvironment.hasActions;
  summary.hasLocalEnvironmentHint = summary.hasLocalEnvironmentHint || summary.localEnvironment.candidateFileCount > 0;

  if (!summary.hasAgents) {
    summary.gaps.push(summary.hasAgentsFile ? "Fill in AGENTS.md" : "Add AGENTS.md");
  }
  if (!summary.hasCodexDir) summary.gaps.push("Add .codex local setup/actions");
  if (summary.hasCodexDir && !summary.localEnvironment.hasSetupScript && summary.hasPackageJson) {
    summary.gaps.push("Add worktree setup script");
  }
  if (summary.hasCodexDir && !summary.localEnvironment.hasActions && Object.keys(summary.scripts).length) {
    summary.gaps.push("Add local environment actions");
  }
  if (summary.hasPackageJson && !summary.hasDevScript && !summary.hasBuildScript) summary.gaps.push("Document run/build command");
  if (summary.hasPackageJson && !summary.hasTestScript && !summary.hasBuildScript) {
    summary.gaps.push("Add or document verification command");
  }

  const localEnvironmentScore = summary.hasLocalEnvironment
    ? summary.localEnvironment.hasSetupScript && summary.localEnvironment.hasActions
      ? 10
      : 6
    : summary.hasCodexDir
      ? 2
      : 0;
  summary.score = Math.min(
    100,
    (summary.hasAgents ? 35 : 0) +
      (summary.hasProjectConfig ? 15 : summary.hasCodexDir ? 8 : 0) +
      localEnvironmentScore +
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
    missingLocalEnvironmentCount: existingProjects.filter(
      (project) => project.hasPackageJson && (!project.localEnvironment?.hasSetupScript || !project.localEnvironment?.hasActions),
    ).length,
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
  const [globalAgentsBaseBytes, globalAgentsOverrideBytes, globalAgentsFileExists, globalAgentsOverrideExists] = await Promise.all([
    fileSize(paths.globalAgents),
    fileSize(paths.globalAgentsOverride),
    exists(paths.globalAgents),
    exists(paths.globalAgentsOverride),
  ]);
  const globalAgentsBytes = globalAgentsOverrideBytes || globalAgentsBaseBytes;
  const summary = {
    path: paths.configToml,
    exists: false,
    model: null,
    reasoningEffort: null,
    modelVerbosity: null,
    modelReasoningSummary: null,
    modelSupportsReasoningSummaries: null,
    showRawAgentReasoning: false,
    hideAgentReasoning: false,
    responseShapeSummary: buildResponseShapeSummary({}),
    approvalPolicy: null,
    approvalReviewer: "user",
    approvalFlow: buildApprovalFlowSummary({}),
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
    shellEnvironmentSummary: buildShellEnvironmentSummary({}),
    contextBudgetSummary: buildContextBudgetSummary({}),
    networkSandbox: emptyNetworkSandboxSummary(),
    instructionStack: emptyInstructionStackSummary(),
    instructionOverrides: emptyInstructionOverrideSummary(),
    customAgents: emptyCustomAgentSummary(),
    customPrompts: emptyCustomPromptSummary(),
    managedConfig: emptyManagedConfigSummary(),
    goalsFeature: false,
    hooksFeature: true,
    rulesFeature: true,
    commandRules: emptyCommandRuleSummary(true),
    hookSummary: {
      hooksFeature: true,
      status: "ready",
      tone: "low",
      label: "None",
      sourceCount: 0,
      groupCount: 0,
      commandCount: 0,
      turnScopedCommandCount: 0,
      broadMatcherCount: 0,
      eventCounts: {},
      sources: [],
      detail: "No active lifecycle hook commands were found in user or current trusted project config.",
    },
    memoriesFeature: false,
    memoriesUseMemories: null,
    memoriesUseMemoriesEffective: false,
    memoriesGenerateMemories: null,
    memoriesGenerateMemoriesEffective: false,
    memoriesDisableOnExternalContext: null,
    memoriesMinRateLimitRemainingPercent: null,
    memoriesExtractModel: null,
    memoriesConsolidationModel: null,
    webSearchMode: null,
    webSearchConfigured: false,
    webSearchEffectiveMode: "cached",
    webSearchLabel: "Cached default",
    webSearchLegacyKeyCount: 0,
    webSearchLegacyKeys: [],
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
      missingLocalEnvironmentCount: 0,
      missingVerificationCount: 0,
      averageScore: 0,
      currentProject: null,
      weakestProjects: [],
    },
    enabledPluginCount: 0,
    enabledMcpCount: 0,
    disabledMcpCount: 0,
    requiredMcpCount: 0,
    mcpSummary: buildMcpConfigSummary({}, []),
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
    globalAgentsFileExists: globalAgentsFileExists || globalAgentsOverrideExists,
    globalAgentsBytes,
    globalAgentsBaseBytes,
    globalAgentsOverrideBytes,
  };

  Object.assign(summary, await getCodexProfileSummaries());

  if (!(await exists(paths.configToml))) {
    summary.hookSummary = await getHookConfigSummary({ hooksFeature: summary.hooksFeature });
    summary.networkSandbox = buildNetworkSandboxSummary({}, []);
    summary.instructionStack = await getInstructionStackSummary({ values: {}, currentProject: null });
    summary.instructionOverrides = await getInstructionOverrideSummary({ globalConfigText: "", currentProject: null });
    summary.customAgents = await getCustomAgentSummary(null);
    summary.customPrompts = await getCustomPromptSummary();
    summary.managedConfig = await getManagedConfigSummary({ userValues: {}, userSections: [] });
    summary.commandRules = await getCommandRuleSummary({ rulesFeature: summary.rulesFeature, currentProject: null });
    return summary;
  }
  summary.exists = true;

  try {
    const text = await fs.readFile(paths.configToml, "utf8");
    const parsed = parseTomlSummary(text);
    const { values, sections } = parsed;
    summary.model = values.model || null;
    summary.reasoningEffort = values.model_reasoning_effort || values.reasoning_effort || null;
    summary.modelVerbosity = values.model_verbosity || null;
    summary.modelReasoningSummary = values.model_reasoning_summary || null;
    summary.modelSupportsReasoningSummaries = values.model_supports_reasoning_summaries ?? null;
    summary.showRawAgentReasoning = values.show_raw_agent_reasoning === true;
    summary.hideAgentReasoning = values.hide_agent_reasoning === true;
    summary.responseShapeSummary = buildResponseShapeSummary(values);
    summary.approvalPolicy = values.approval_policy || null;
    summary.approvalReviewer = values.approvals_reviewer || "user";
    summary.approvalFlow = buildApprovalFlowSummary(values);
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
    summary.shellEnvironmentSummary = buildShellEnvironmentSummary(values);
    summary.contextBudgetSummary = buildContextBudgetSummary(values);
    summary.goalsFeature = values["features.goals"] === true;
    summary.hooksFeature = (values["features.hooks"] ?? values["features.codex_hooks"]) !== false;
    summary.rulesFeature = values["features.rules"] !== false;
    summary.memoriesFeature = values["features.memories"] === true;
    summary.memoriesUseMemories = values["memories.use_memories"] ?? null;
    summary.memoriesUseMemoriesEffective = summary.memoriesFeature && summary.memoriesUseMemories !== false;
    summary.memoriesGenerateMemories = values["memories.generate_memories"] ?? null;
    summary.memoriesGenerateMemoriesEffective = summary.memoriesFeature && summary.memoriesGenerateMemories !== false;
    summary.memoriesDisableOnExternalContext =
      values["memories.disable_on_external_context"] ?? values["memories.no_memories_if_mcp_or_web_search"] ?? null;
    summary.memoriesMinRateLimitRemainingPercent = configNumber(values["memories.min_rate_limit_remaining_percent"]);
    summary.memoriesExtractModel = values["memories.extract_model"] || null;
    summary.memoriesConsolidationModel = values["memories.consolidation_model"] || null;
    summary.webSearchMode = values.web_search ?? null;
    summary.webSearchConfigured = values.web_search !== undefined;
    summary.webSearchEffectiveMode = effectiveWebSearchMode(values);
    summary.webSearchLegacyKeys = legacyWebSearchKeys(values);
    summary.webSearchLegacyKeyCount = summary.webSearchLegacyKeys.length;
    summary.webSearchLabel = summary.webSearchConfigured
      ? webSearchModeLabel(summary.webSearchEffectiveMode, true)
      : summary.webSearchLegacyKeyCount
        ? `${webSearchModeLabel(summary.webSearchEffectiveMode, true)} legacy`
        : webSearchModeLabel(summary.webSearchEffectiveMode, false);
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
    summary.hookSummary = await getHookConfigSummary({
      hooksFeature: summary.hooksFeature,
      globalConfigText: text,
      currentProject: summary.projectReadiness.currentProject,
    });
    summary.enabledPluginCount = sections.filter((section) => section.startsWith('plugins."') && values[`${section}.enabled`] === true).length;
    let mcpValues = values;
    let mcpSections = sections;
    const currentProjectConfigPath = summary.projectReadiness.currentProject?.path
      ? path.join(summary.projectReadiness.currentProject.path, ".codex", "config.toml")
      : null;
    if (currentProjectConfigPath && (await exists(currentProjectConfigPath))) {
      try {
        const projectMcpConfig = parseTomlSummary(await fs.readFile(currentProjectConfigPath, "utf8"));
        mcpValues = { ...mcpValues, ...projectMcpConfig.values };
        mcpSections = [...mcpSections, ...projectMcpConfig.sections];
      } catch {
        // Keep MCP diagnostics available from the user config even if project config is unreadable.
      }
    }
    summary.instructionStack = await getInstructionStackSummary({
      values: mcpValues,
      currentProject: summary.projectReadiness.currentProject,
    });
    summary.networkSandbox = buildNetworkSandboxSummary(mcpValues, mcpSections);
    summary.instructionOverrides = await getInstructionOverrideSummary({
      globalConfigText: text,
      currentProject: summary.projectReadiness.currentProject,
    });
    summary.customAgents = await getCustomAgentSummary(summary.projectReadiness.currentProject);
    summary.customPrompts = await getCustomPromptSummary();
    summary.commandRules = await getCommandRuleSummary({
      rulesFeature: summary.rulesFeature,
      currentProject: summary.projectReadiness.currentProject,
    });
    summary.mcpSummary = buildMcpConfigSummary(mcpValues, mcpSections);
    summary.enabledMcpCount = summary.mcpSummary.enabledCount;
    summary.disabledMcpCount = summary.mcpSummary.disabledCount;
    summary.requiredMcpCount = summary.mcpSummary.requiredCount;
    summary.managedConfig = await getManagedConfigSummary({ userValues: mcpValues, userSections: mcpSections });
  } catch (error) {
    summary.error = error.message;
    summary.managedConfig = await getManagedConfigSummary({ userValues: {}, userSections: [] });
    summary.commandRules = await getCommandRuleSummary({ rulesFeature: summary.rulesFeature, currentProject: null });
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
  const localEnvironment = project?.localEnvironment || emptyLocalEnvironmentSummary({ hasCodexDir: project?.hasCodexDir });
  const needsLocalSetup = !project?.hasCodexDir || !localEnvironment.hasSetupScript || (!localEnvironment.hasActions && Object.keys(project?.scripts || {}).length);
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

  if (needsLocalSetup) {
    lines.push(
      "",
      "# Also configure Codex app Local Environments for this project.",
      "# Codex stores the shared generated file under this folder:",
      `# ${path.join(projectPath, ".codex")}`,
      "",
      "# Good setup script:",
      runCommand.startsWith("npm run") ? "npm install" : "# install dependencies for this repo",
      buildCommand.startsWith("npm run") ? buildCommand : "# build once if this repo needs generated files",
      "",
      "# Good actions:",
      runCommand,
      verifyCommand,
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
  const webSearchEffectiveMode = codexConfig?.webSearchEffectiveMode || codexConfig?.webSearchMode || "cached";
  const webSearchLabel = codexConfig?.webSearchLabel || webSearchModeLabel(webSearchEffectiveMode, Boolean(codexConfig?.webSearchConfigured));
  const webSearchLive = webSearchEffectiveMode === "live";
  const webSearchLegacyKeys = codexConfig?.webSearchLegacyKeys || [];
  const webSearchLegacyKeyCount = Number(codexConfig?.webSearchLegacyKeyCount || webSearchLegacyKeys.length || 0);
  const shellEnvironmentSummary = codexConfig?.shellEnvironmentSummary || buildShellEnvironmentSummary({});
  const contextBudgetSummary = codexConfig?.contextBudgetSummary || buildContextBudgetSummary({});
  const responseShapeSummary = codexConfig?.responseShapeSummary || buildResponseShapeSummary({});
  const networkSandbox = codexConfig?.networkSandbox || emptyNetworkSandboxSummary();
  const instructionStack = codexConfig?.instructionStack || emptyInstructionStackSummary();
  const instructionOverrides = codexConfig?.instructionOverrides || emptyInstructionOverrideSummary();
  const customAgents = codexConfig?.customAgents || emptyCustomAgentSummary();
  const customPrompts = codexConfig?.customPrompts || emptyCustomPromptSummary();
  const managedConfig = codexConfig?.managedConfig || emptyManagedConfigSummary();
  const commandRules = codexConfig?.commandRules || emptyCommandRuleSummary(codexConfig?.rulesFeature !== false);
  const hasFastTaskProfile = Boolean(codexConfig?.hasFastTaskProfile);
  const projectReadiness = codexConfig?.projectReadiness || {};
  const currentProject = projectReadiness.currentProject;
  const currentLocalEnvironment = currentProject?.localEnvironment || null;
  const localEnvironmentNeedsWork = Boolean(
    currentProject &&
      (currentLocalEnvironment?.tone !== "low" ||
        !currentLocalEnvironment?.hasSetupScript ||
        (Object.keys(currentProject.scripts || {}).length && !currentLocalEnvironment?.hasActions)),
  );
  const authCache = codexConfig?.authCache || {};
  const approvalFlow = codexConfig?.approvalFlow || buildApprovalFlowSummary({});
  const mcpSummary = codexConfig?.mcpSummary || buildMcpConfigSummary({}, []);
  const processSummary = context.processSummary || {};
  const backgroundSummary = processSummary.background || {};
  const hookSummary = codexConfig?.hookSummary || {};
  const agentMaxThreads = Number(codexConfig?.agentMaxThreadsEffective ?? 6);
  const agentMaxDepth = Number(codexConfig?.agentMaxDepthEffective ?? 1);
  const agentFanoutRisk = agentMaxDepth > 1 || agentMaxThreads >= 12;
  const memoryBytes = scan?.categories?.memoryState?.bytes || 0;
  const memoryFiles = scan?.categories?.memoryState?.fileCount || 0;
  const memoryInjection = Boolean(codexConfig?.memoriesUseMemoriesEffective);
  const memoryGeneration = Boolean(codexConfig?.memoriesGenerateMemoriesEffective);
  const memoryReviewNeeded = memoryBytes > 2 * 1024 ** 2 || memoryFiles >= 50 || memoryInjection || memoryGeneration;
  const skillCatalog = scan?.skillCatalog || {};

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

  if (skillCatalog.status === "ready" && skillCatalog.tone !== "low") {
    addFix({
      id: "skill-catalog",
      label: "Skill Catalog",
      value: skillCatalog.label,
      tone: skillCatalog.tone === "high" ? "high" : "medium",
      action: "/skills",
      detail:
        "Codex starts each task with skill metadata so it can pick the right workflow. Keep installed skills intentional and descriptions concise so the skill list does not crowd the prompt.",
      snippet: [
        "/skills",
        "",
        "# Disable a stale skill without deleting it:",
        "# ~/.codex/config.toml",
        "[[skills.config]]",
        'path = "/path/to/skill/SKILL.md"',
        "enabled = false",
        "",
        "# Also shorten long SKILL.md descriptions: front-load the trigger words, then stop.",
      ].join("\n"),
    });
  }

  if (instructionStack.status === "ready" && instructionStack.tone !== "low") {
    addFix({
      id: "instruction-stack",
      label: "Instruction Stack",
      value: formatBytesServer(instructionStack.projectCandidateBytes || instructionStack.totalBytes || 0),
      tone: instructionStack.tone === "high" ? "high" : "medium",
      action: instructionStack.action || "Review guidance",
      detail:
        "Codex loads durable AGENTS guidance before work. Keep always-on instructions short, concrete, and scoped so every task starts with useful context instead of stale bulk.",
      snippet: [
        "# Review active guidance without changing files:",
        'codex --ask-for-approval never "Show which instruction files are active and summarize the rules in priority order."',
        "",
        "# Keep AGENTS.md concise. Move deep background docs into linked markdown files,",
        "# and put directory-specific rules in the closest subdirectory AGENTS.md.",
        "",
        "# Optional ~/.codex/config.toml if critical project guidance is being truncated:",
        `project_doc_max_bytes = ${Number(instructionStack.projectDocMaxBytes || defaultProjectDocMaxBytes)}`,
      ].join("\n"),
    });
  }

  if (instructionOverrides.status === "ready" && instructionOverrides.tone !== "low") {
    const overrideConfigPaths = [
      ...new Set((instructionOverrides.sources || []).filter((source) => source.effective).map((source) => source.configPath).filter(Boolean)),
    ];
    addFix({
      id: "instruction-overrides",
      label: "Instruction Overrides",
      value: instructionOverrides.label,
      tone: instructionOverrides.tone === "high" ? "high" : "medium",
      action: instructionOverrides.action || "Review overrides",
      detail:
        "Custom instruction overrides can change what Codex loads before normal repo guidance. Keep them small, intentional, and easy to remove.",
      snippet: [
        "# Review active override config file(s):",
        ...(overrideConfigPaths.length ? overrideConfigPaths.map((configPath) => `# ${configPath}`) : [`# ${paths.configToml}`]),
        "",
        "# Review these keys if they are present:",
        "# developer_instructions = \"...\"",
        "# model_instructions_file = \"/path/to/instructions.txt\"",
        "# compact_prompt = \"...\"",
        "# experimental_compact_prompt_file = \"/path/to/compact_prompt.txt\"",
        "",
        "# Prefer AGENTS.md for durable repo guidance and skills for reusable workflows.",
      ].join("\n"),
    });
  }

  if (customAgents.status === "ready" && customAgents.tone !== "low") {
    addFix({
      id: "custom-agents",
      label: "Custom Agents",
      value: customAgents.label,
      tone: customAgents.tone === "high" ? "high" : "medium",
      action: customAgents.action || "Review agents",
      detail:
        "Custom agents can be powerful, but each spawned agent does its own model and tool work. Keep agents narrow, valid, and tuned to the job.",
      snippet: [
        "# Review custom agent files:",
        `# ${displayPath(paths.customAgents)}`,
        "# <project>/.codex/agents/",
        "",
        "# Each custom agent TOML must include:",
        'name = "reviewer"',
        'description = "Focused reviewer for correctness, security, and tests."',
        'developer_instructions = """',
        "Stay narrow. Return concise findings with file references.",
        '"""',
        "",
        "# For fast scans, prefer a lighter model/effort inside the agent file when appropriate.",
      ].join("\n"),
    });
  }

  if (customPrompts.status === "ready" && customPrompts.tone !== "low") {
    addFix({
      id: "custom-prompts",
      label: "Custom Prompts",
      value: customPrompts.label,
      tone: customPrompts.tone === "high" ? "high" : "medium",
      action: customPrompts.action || "Review prompts",
      detail:
        "Custom prompts still work as slash commands, but Codex documents them as deprecated. Move reusable workflows to skills when you touch them.",
      snippet: [
        `# ${displayPath(paths.customPrompts)}`,
        "# Codex scans only top-level Markdown files here.",
        "# Use /prompts:name for existing prompts, but prefer skills for reusable workflows:",
        "$skill-creator",
        "",
        "# Keep prompt templates small and add front matter:",
        "---",
        "description: Short command summary",
        "argument-hint: [FILES=]",
        "---",
      ].join("\n"),
    });
  }

  if (managedConfig.status === "ready" && managedConfig.tone !== "low") {
    addFix({
      id: "managed-config",
      label: "Managed Config",
      value: managedConfig.label,
      tone: managedConfig.tone === "high" ? "high" : "medium",
      action: managedConfig.action || "Check admin settings",
      detail:
        "Managed Codex requirements and defaults can override local config at startup. Review the policy layer before repeatedly changing ~/.codex/config.toml.",
      snippet: [
        "codex doctor --summary",
        "",
        "# Documented local/system managed Codex files:",
        `# ${displayPath(paths.requirementsToml)}`,
        `# ${displayPath(paths.managedConfigToml)}`,
        "",
        "# On managed Macs, an MDM profile can also set com.openai.codex payloads.",
        "# Cloud-managed requirements can be assigned by ChatGPT Business/Enterprise admins.",
      ].join("\n"),
    });
  }

  if (commandRules.status === "ready" && commandRules.tone !== "low") {
    const rulePaths = (commandRules.ruleFiles || []).map((file) => file.path).filter(Boolean).slice(0, 4);
    const rulesArgs = rulePaths.length ? rulePaths.map((rulePath) => `  --rules ${shellQuote(rulePath)} \\`) : ["  --rules ~/.codex/rules/default.rules \\"];
    addFix({
      id: "command-rules",
      label: "Command Rules",
      value: commandRules.label,
      tone: commandRules.tone === "high" ? "high" : "medium",
      action: commandRules.action || "Review execpolicy",
      detail:
        "Command rules decide whether Codex can run matching commands outside the sandbox. Broad prompt rules can add repeated approval stops.",
      snippet: [
        "# Test how active command rules handle a specific command:",
        "codex execpolicy check --pretty \\",
        ...rulesArgs,
        "  -- <command>",
        "",
        "# Keep prefix_rule patterns narrow, for example:",
        '# pattern = ["pnpm", "run", "lint"]',
        '# Avoid broad prompt patterns such as ["bash"], ["python"], or ["curl"] unless you really want every matching escalation to stop.',
      ].join("\n"),
    });
  }

  if (responseShapeSummary.status === "ready" && responseShapeSummary.tone !== "low") {
    addFix({
      id: "response-shape",
      label: "Response Shape",
      value: responseShapeSummary.label,
      tone: responseShapeSummary.tone === "high" ? "high" : "medium",
      action: responseShapeSummary.action,
      detail:
        "High verbosity, detailed reasoning summaries, or raw reasoning display can make small local tasks feel slower and add extra text to sift through.",
      snippet: [
        "# ~/.codex/config.toml",
        "# Lean default for small/local coding tasks:",
        'model_verbosity = "low"',
        'model_reasoning_summary = "concise"',
        "",
        "# For the shortest output:",
        '# model_reasoning_summary = "none"',
        "",
        "# Keep raw reasoning display off unless you are debugging model behavior:",
        "show_raw_agent_reasoning = false",
      ].join("\n"),
    });
  }

  if (networkSandbox.status === "ready" && networkSandbox.tone !== "low") {
    const snippet =
      networkSandbox.networkProxyNoEffect
        ? [
            "# ~/.codex/config.toml",
            'sandbox_mode = "workspace-write"',
            "",
            "[sandbox_workspace_write]",
            "network_access = true",
            "",
            "[features.network_proxy]",
            "enabled = true",
            '# Add only the hosts this workflow needs, for example:',
            '# domains = { "api.openai.com" = "allow", "objects.githubusercontent.com" = "allow" }',
          ].join("\n")
        : networkSandbox.unrestrictedDirectNetwork || networkSandbox.globalAllow
          ? [
              "# ~/.codex/config.toml",
              "[features.network_proxy]",
              "enabled = true",
              '# Prefer exact hosts or scoped wildcards over "*":',
              '# domains = { "api.openai.com" = "allow", "objects.githubusercontent.com" = "allow" }',
              "# Leave allow_local_binding = false unless a local dev server truly needs broader access.",
            ].join("\n")
          : [
              "# ~/.codex/config.toml",
              'sandbox_mode = "workspace-write"',
              "",
              "[sandbox_workspace_write]",
              "# Turn this on only for tasks that need installs, fetches, or external APIs.",
              "network_access = true",
              "",
              "# For planning/read-only tasks, keep command network off.",
            ].join("\n");
    addFix({
      id: "network-sandbox",
      label: "Network Sandbox",
      value: networkSandbox.label,
      tone: networkSandbox.tone === "high" ? "high" : "medium",
      action: networkSandbox.action || "Review network",
      detail:
        "Codex command network access is separate from web search. Match sandbox network settings to the task so installs and fetches do not stall or overreach.",
      snippet,
    });
  }

  if (webSearchLive) {
    addFix({
      id: "web-search-mode",
      label: "Web Search",
      value: webSearchLabel,
      tone: "medium",
      action: "Use cached/local",
      detail:
        "Codex cached web search is the normal local-task baseline. Live search fetches the freshest data, but for local-only coding it can add unpredictability and exposure to untrusted live content.",
      snippet: [
        "# ~/.codex/config.toml",
        "# Good default for most local coding tasks:",
        'web_search = "cached"',
        "",
        "# For fully local tasks that should never look outward:",
        '# web_search = "disabled"',
        "",
        "# Use live only when current external facts matter:",
        '# web_search = "live"',
      ].join("\n"),
    });
  }

  if (webSearchLegacyKeyCount) {
    addFix({
      id: "legacy-web-search",
      label: "Web Search Config",
      value: `${webSearchLegacyKeyCount.toLocaleString()} legacy`,
      tone: "medium",
      action: "Use web_search",
      detail:
        "Codex still maps deprecated web-search toggles, but the modern setting is clearer and avoids surprises when profiles or managed config are layered.",
      snippet: [
        "# ~/.codex/config.toml",
        "# Replace deprecated keys:",
        ...webSearchLegacyKeys.map((key) => `# ${key} = ...`),
        "",
        "# Use one modern mode instead:",
        `web_search = "${webSearchEffectiveMode}"`,
        "",
        "# cached is the usual local-task baseline; live is for current external facts; disabled is for fully local work.",
      ].join("\n"),
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

  if (backgroundSummary.status === "ready" && backgroundSummary.tone !== "low") {
    addFix({
      id: "background-terminal-load",
      label: "Background Work",
      value: `${Number(backgroundSummary.processCount || 0).toLocaleString()} cmds`,
      tone: backgroundSummary.tone === "high" ? "high" : "medium",
      action: "/ps, then /stop",
      detail:
        "Long-running terminal commands under Codex can make everything feel slow. Use /ps to inspect them and /stop only after confirming the work is no longer needed.",
      snippet: buildBackgroundTerminalSnippet(),
    });
  }

  if (hookSummary.status === "ready" && hookSummary.hooksFeature && hookSummary.tone !== "low") {
    addFix({
      id: "hook-load",
      label: "Lifecycle Hooks",
      value: `${Number(hookSummary.commandCount || 0).toLocaleString()} hooks`,
      tone: hookSummary.tone === "high" ? "high" : "medium",
      action: "Review /hooks",
      detail:
        "Matching hooks from multiple files can all run, and turn/tool-scope hooks can add latency around frequent actions. Review loaded hooks before disabling anything.",
      snippet: [
        "# In Codex:",
        "/hooks",
        "",
        "# If you intentionally need a temporary local speed run with hooks disabled, edit ~/.codex/config.toml:",
        "# [features]",
        "# hooks = false",
      ].join("\n"),
    });
  }

  if (approvalFlow.autoReviewApplies) {
    addFix({
      id: "approval-review-flow",
      label: "Approval Review",
      value: "Auto review",
      tone: "medium",
      action: "Review approval flow",
      detail:
        "Automatic approval review can save manual clicks, but it uses extra model calls for eligible interactive approvals. If latency matters more than auto-review, route approvals back to you.",
      snippet: [
        "# ~/.codex/config.toml",
        "# Faster interactive approvals: route eligible prompts to you instead of auto-review.",
        'approvals_reviewer = "user"',
        "",
        "# For a trusted, scoped speed run only, you can also choose fewer approval prompts:",
        '# approval_policy = "never"',
      ].join("\n"),
    });
  }

  if (mcpSummary.status === "ready" && mcpSummary.tone !== "low") {
    addFix({
      id: "mcp-startup-pressure",
      label: "MCP Startup",
      value: mcpSummary.label,
      tone: mcpSummary.tone === "high" ? "high" : "medium",
      action: "/mcp verbose",
      detail:
        "Codex starts configured MCP servers with a session. Required servers can fail startup if initialization breaks, and missing environment variables can make a useful server look slow or broken.",
      snippet: [
        "# In Codex:",
        "/mcp verbose",
        "",
        "# For optional servers you do not need every run, edit ~/.codex/config.toml:",
        "# [mcp_servers.example]",
        "# enabled = false",
        "",
        "# Keep required = true only for servers every session truly needs.",
        "# If desktop Codex cannot see MCP env vars, put them in ~/.codex/.env and restart the app.",
      ].join("\n"),
    });
  }

  if (shellEnvironmentSummary.status === "ready" && shellEnvironmentSummary.tone !== "low") {
    addFix({
      id: "shell-environment-policy",
      label: "Shell Env",
      value: shellEnvironmentSummary.label,
      tone: shellEnvironmentSummary.tone === "high" ? "high" : "medium",
      action: "Trim env policy",
      detail:
        "Codex forwards environment variables to spawned commands according to shell_environment_policy. A trimmed policy keeps commands predictable and avoids dragging secrets into local subprocesses.",
      snippet: [
        "# ~/.codex/config.toml",
        "# Start with a small command environment, then add project-specific vars intentionally.",
        "[shell_environment_policy]",
        'inherit = "core"',
        "ignore_default_excludes = false",
        'include_only = ["PATH", "HOME", "SHELL", "TMPDIR"]',
        "",
        "# Add required build or MCP variables explicitly instead of inheriting everything.",
      ].join("\n"),
    });
  }

  if (contextBudgetSummary.status === "ready" && contextBudgetSummary.tone !== "low") {
    addFix({
      id: "context-budget",
      label: "Context Budget",
      value: contextBudgetSummary.label,
      tone: contextBudgetSummary.tone === "high" ? "high" : "medium",
      action: contextBudgetSummary.action,
      detail:
        "Codex stores file reads, command output, and the ongoing conversation in the model context. Large tool-output retention or awkward compaction thresholds can make long sessions noisier and slower.",
      snippet: [
        "# ~/.codex/config.toml",
        "# Prefer model defaults unless you have measured a specific need.",
        "# model_context_window = 128000",
        "# model_auto_compact_token_limit = 64000",
        "",
        "# Keep per-command output lean; use files for huge logs.",
        "tool_output_token_limit = 12000",
        "",
        "# In long active threads, use:",
        "/compact",
      ].join("\n"),
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

  if (memoryReviewNeeded) {
    addFix({
      id: "memory-context",
      label: "Memory Context",
      value: memoryBytes ? formatBytesServer(memoryBytes) : memoryInjection ? "Injecting" : "Enabled",
      tone: memoryBytes > 10 * 1024 ** 2 || memoryFiles >= 200 ? "medium" : "low",
      action: "Review memories",
      detail:
        "Memories can save repeated prompting, but they are hidden context. Review local memory files before sharing Codex home and keep required rules in AGENTS.md.",
      snippet: [
        "# Review memory behavior inside Codex:",
        "/memories",
        "",
        "# Metadata-only local check:",
        `find ${shellQuote(paths.memories)} ${shellQuote(paths.memoriesExtensions)} -type f 2>/dev/null | wc -l`,
        `du -sh ${shellQuote(paths.memories)} ${shellQuote(paths.memoriesExtensions)} 2>/dev/null`,
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
    (!currentProject.hasAgents ||
      !currentProject.hasCodexDir ||
      localEnvironmentNeedsWork ||
      (!currentProject.hasTestScript && !currentProject.hasBuildScript))
  ) {
    addFix({
      id: "project-playbook",
      label: "Project Playbook",
      value: `${currentProject.score}/100`,
      tone: currentProject.score >= 70 ? "low" : "medium",
      action: currentProject.hasAgents ? (localEnvironmentNeedsWork ? "Add setup/actions" : "Add verification") : "Add AGENTS.md",
      detail:
        "Project guidance, worktree setup scripts, and local actions help Codex start with run, build, and verification context instead of rediscovering it.",
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
  const shellEnvironmentSummary = codexConfig?.shellEnvironmentSummary || buildShellEnvironmentSummary({});
  const contextBudgetSummary = codexConfig?.contextBudgetSummary || buildContextBudgetSummary({});
  const responseShapeSummary = codexConfig?.responseShapeSummary || buildResponseShapeSummary({});
  const networkSandbox = codexConfig?.networkSandbox || emptyNetworkSandboxSummary();
  const instructionStack = codexConfig?.instructionStack || emptyInstructionStackSummary();
  const instructionOverrides = codexConfig?.instructionOverrides || emptyInstructionOverrideSummary();
  const customAgents = codexConfig?.customAgents || emptyCustomAgentSummary();
  const customPrompts = codexConfig?.customPrompts || emptyCustomPromptSummary();
  const managedConfig = codexConfig?.managedConfig || emptyManagedConfigSummary();
  const commandRules = codexConfig?.commandRules || emptyCommandRuleSummary(codexConfig?.rulesFeature !== false);
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
  const projectGapCount =
    Number(projectReadiness.missingGuidanceCount || 0) +
    Number(projectReadiness.missingCodexDirCount || 0) +
    Number(projectReadiness.missingLocalEnvironmentCount || 0);
  const currentLocalEnvironment = currentProject?.localEnvironment || null;
  const authCache = codexConfig?.authCache || {};
  const approvalFlow = codexConfig?.approvalFlow || buildApprovalFlowSummary({});
  const mcpSummary = codexConfig?.mcpSummary || buildMcpConfigSummary({}, []);
  const skillCatalog = scan?.skillCatalog || {};
  const skillCatalogReady = skillCatalog.status === "ready";
  const skillCatalogLoaded = skillCatalogReady && skillCatalog.tone !== "low";
  const globalGuidanceReady = Boolean(codexConfig?.globalAgentsExists);
  const emptyGlobalGuidance = Boolean(codexConfig?.globalAgentsFileExists && !codexConfig?.globalAgentsExists);
  const staleTrustedProjectCount = Number(codexConfig?.staleTrustedProjectCount || 0);
  const webSearchEffectiveMode = codexConfig?.webSearchEffectiveMode || codexConfig?.webSearchMode || "cached";
  const webSearchLabel = codexConfig?.webSearchLabel || webSearchModeLabel(webSearchEffectiveMode, Boolean(codexConfig?.webSearchConfigured));
  const webSearchLive = webSearchEffectiveMode === "live";
  const webSearchLegacyKeys = codexConfig?.webSearchLegacyKeys || [];
  const webSearchLegacyKeyCount = Number(codexConfig?.webSearchLegacyKeyCount || webSearchLegacyKeys.length || 0);
  const memoryBytes = categories.memoryState?.bytes || 0;
  const memoryFiles = categories.memoryState?.fileCount || 0;
  const memoriesFeature = Boolean(codexConfig?.memoriesFeature);
  const memoriesUse = Boolean(codexConfig?.memoriesUseMemoriesEffective);
  const memoriesGenerate = Boolean(codexConfig?.memoriesGenerateMemoriesEffective);
  const hookSummary = codexConfig?.hookSummary || {};
  const hooksFeature = hookSummary.hooksFeature !== false;
  const hookCommandCount = Number(hookSummary.commandCount || 0);
  const hookTurnScopedCount = Number(hookSummary.turnScopedCommandCount || 0);
  const hookTone = hookSummary.tone || "low";
  const hookLabel = hooksFeature ? hookSummary.label || (hookCommandCount ? `${hookCommandCount} hooks` : "None") : "Disabled";
  const hookDetail =
    hookSummary.detail ||
    (hooksFeature
      ? "No active lifecycle hook commands were found in user or current trusted project config."
      : "Lifecycle hooks are disabled by config.");
  const memoryStateLabel = memoriesUse
    ? "Injecting"
    : memoriesGenerate
      ? "Generating"
      : memoriesFeature
        ? "Enabled"
        : "Off";
  const memoryTone = memoryBytes > 10 * 1024 ** 2 || memoryFiles >= 200 ? "medium" : "low";
  const memoryDetail =
    memoriesUse || memoriesGenerate
      ? `Memories are ${memoriesUse ? "available for future-session context" : "enabled for generation"} with ${memoryFiles.toLocaleString()} local memory file${memoryFiles === 1 ? "" : "s"} (${formatBytesServer(memoryBytes)}). Keep required rules in AGENTS.md and review memories before sharing Codex home.`
      : memoriesFeature
        ? `Memories are enabled, but Refit found ${memoryFiles.toLocaleString()} local memory file${memoryFiles === 1 ? "" : "s"} (${formatBytesServer(memoryBytes)}).`
        : `Memories are off in config. Refit found ${memoryFiles.toLocaleString()} local memory file${memoryFiles === 1 ? "" : "s"} (${formatBytesServer(memoryBytes)}).`;
  const docsSource = "Official Codex manual: Speed, Models, Config, AGENTS, MCP, Memories, Troubleshooting";
  const processReady = processSummary?.status === "ready";
  const processLoaded = processReady && processSummary.tone !== "low";
  const processCount = Number(processSummary?.processCount || 0);
  const processRssBytes = Number(processSummary?.rssBytes || 0);
  const backgroundSummary = processSummary?.background || {};
  const backgroundReady = backgroundSummary.status === "ready";
  const backgroundLoaded = backgroundReady && backgroundSummary.tone !== "low";
  const backgroundCount = Number(backgroundSummary.processCount || 0);
  const backgroundRssBytes = Number(backgroundSummary.rssBytes || 0);
  const backgroundCpuPercent = Number(backgroundSummary.cpuPercent || 0);

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
      : `${currentProject.label} is missing ${currentProject.gaps.slice(0, 3).join(", ")}. Add project guidance and local setup so Codex does not rediscover basics every run.`
    : existingProjectCount
      ? `${projectReadyCount}/${existingProjectCount} trusted projects look Codex-ready. Add AGENTS.md and local setup/actions to the projects you use most.`
      : "No existing trusted projects were found to inspect.";

  const localEnvironmentDetail = currentProject
    ? currentLocalEnvironment?.detail || "No local environment details were available for the current project."
    : "Open a trusted project so Refit can check its Codex local-environment setup scripts and app actions.";

  const runtimeDetail = runtime?.versionMismatch
    ? `Terminal Codex is ${runtime.cliVersion}; the bundled app binary is ${runtime.appVersion}. The manual notes app and CLI versions can differ.`
    : runtime?.cliVersion || runtime?.appVersion
      ? `Terminal Codex ${runtime.cliVersion || "not found"}; app binary ${runtime.appVersion || "not found"}.`
      : "Codex CLI was not found on PATH and the app binary was not detected.";

  const processDetail =
    processReady
      ? `${processSummary.detail} Oldest live Codex process: ${processSummary.longestAgeLabel || "unknown"}.`
      : processSummary?.detail || "Live Codex process load was not available for this scan.";
  const backgroundDetail =
    backgroundReady
      ? `${backgroundSummary.detail} Longest background command: ${backgroundSummary.longestAgeLabel || "unknown"}.`
      : backgroundSummary?.detail || "Background terminal load was not available for this scan.";

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
      value: approvalFlow.label || codexConfig?.approvalPolicy || "Default",
      tone: approvalFlow.tone || "medium",
      action: approvalFlow.action || "Review prompts",
      priority: approvalFlow.priority || 72,
      detail: approvalFlow.detail || "Approval prompts can interrupt fast runs. Use /permissions or config only when the trust/safety tradeoff is right.",
    },
    {
      id: "managed-config",
      label: "Managed Config",
      value: managedConfig.label,
      tone: managedConfig.tone,
      action: managedConfig.action,
      priority:
        managedConfig.tone === "high"
          ? 90
          : managedConfig.tone === "medium"
            ? managedConfig.conflictCount
              ? 78
              : 55
            : 16,
      detail: managedConfig.detail,
    },
    {
      id: "command-rules",
      label: "Command Rules",
      value: commandRules.label,
      tone: commandRules.tone,
      action: commandRules.action,
      priority:
        commandRules.tone === "high"
          ? 89
          : commandRules.tone === "medium"
            ? commandRules.broadRuleCount
              ? 73
              : 56
            : commandRules.ruleCount
              ? 30
              : 15,
      detail: commandRules.detail,
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
      id: "shell-environment",
      label: "Shell Env",
      value: shellEnvironmentSummary.label,
      tone: shellEnvironmentSummary.tone,
      action: shellEnvironmentSummary.action,
      priority: shellEnvironmentSummary.tone === "high" ? 86 : shellEnvironmentSummary.tone === "medium" ? 64 : 24,
      detail: shellEnvironmentSummary.detail,
    },
    {
      id: "context-budget",
      label: "Context Budget",
      value: contextBudgetSummary.label,
      tone: contextBudgetSummary.tone,
      action: contextBudgetSummary.action,
      priority: contextBudgetSummary.tone === "high" ? 85 : contextBudgetSummary.tone === "medium" ? 63 : 21,
      detail: contextBudgetSummary.detail,
    },
    {
      id: "response-shape",
      label: "Response Shape",
      value: responseShapeSummary.label,
      tone: responseShapeSummary.tone,
      action: responseShapeSummary.action,
      priority: responseShapeSummary.tone === "high" ? 82 : responseShapeSummary.tone === "medium" ? 62 : 20,
      detail: responseShapeSummary.detail,
    },
    {
      id: "network-sandbox",
      label: "Network Sandbox",
      value: networkSandbox.label,
      tone: networkSandbox.tone,
      action: networkSandbox.action,
      priority:
        networkSandbox.tone === "high"
          ? 84
          : networkSandbox.tone === "medium"
            ? networkSandbox.networkProxyNoEffect || networkSandbox.unrestrictedDirectNetwork
              ? 67
              : 48
            : 18,
      detail: networkSandbox.detail,
    },
    {
      id: "instruction-stack",
      label: "Instruction Stack",
      value: instructionStack.selectedFileCount
        ? `${formatBytesServer(instructionStack.totalBytes)}`
        : instructionStack.projectOverCap
          ? "Capped"
        : instructionStack.emptyFileCount
          ? "Empty files"
          : "None",
      tone: instructionStack.tone || "low",
      action: instructionStack.action || "Keep practical",
      priority: instructionStack.tone === "high" ? 87 : instructionStack.tone === "medium" ? 65 : instructionStack.emptyFileCount ? 38 : 19,
      detail: instructionStack.detail,
    },
    {
      id: "instruction-overrides",
      label: "Instruction Overrides",
      value: instructionOverrides.label,
      tone: instructionOverrides.tone,
      action: instructionOverrides.action,
      priority: instructionOverrides.tone === "high" ? 86 : instructionOverrides.tone === "medium" ? 64 : instructionOverrides.configuredCount ? 34 : 17,
      detail: instructionOverrides.detail,
    },
    {
      id: "hooks",
      label: "Lifecycle Hooks",
      value: hookLabel,
      tone: hookTone,
      action: hooksFeature && hookCommandCount ? "Review /hooks" : hooksFeature ? "No hooks found" : "Disabled",
      priority: hookTone === "high" ? 88 : hookTone === "medium" ? 74 : 22,
      detail: hookDetail,
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
      value: webSearchLabel,
      tone: webSearchLive ? "medium" : "low",
      action: webSearchLive ? "Use cached/local" : "Keep scoped",
      priority: webSearchLive ? 70 : 24,
      detail:
        webSearchLive
          ? "Live web search is useful for current facts, but cached or disabled search can make local coding runs more predictable. Full-access sandboxes can default to live search even when web_search is unset."
          : webSearchLegacyKeyCount
            ? `Effective mode is ${webSearchEffectiveMode}. Replace deprecated ${webSearchLegacyKeys.join(", ")} with the modern web_search setting so behavior is easier to reason about.`
          : "Cached/default web search is a good baseline. Disable it only for fully local tasks that should never look outward.",
    },
    {
      id: "memories",
      label: "Memories",
      value: memoryStateLabel,
      tone: memoryTone,
      action: memoriesUse || memoriesGenerate || memoryFiles ? "Review when needed" : "Optional",
      priority: memoryTone === "medium" ? 68 : memoriesUse || memoriesGenerate ? 40 : 18,
      detail: memoryDetail,
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
    {
      id: "custom-prompts",
      label: "Custom Prompts",
      value: customPrompts.label,
      tone: customPrompts.tone,
      action: customPrompts.action,
      priority: customPrompts.tone === "high" ? 62 : customPrompts.tone === "medium" ? 44 : customPrompts.nestedMarkdownCount ? 24 : 10,
      detail: customPrompts.detail,
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
  const enabledMcpCount = Number(mcpSummary.enabledCount ?? codexConfig?.enabledMcpCount ?? 0);
  const requiredMcpCount = Number(mcpSummary.requiredCount ?? codexConfig?.requiredMcpCount ?? 0);
  const mcpStartupLoaded = mcpSummary.tone !== "low";
  const mcpStartupDetail =
    mcpSummary.detail ||
    `${enabledMcpCount.toLocaleString()} MCP server${enabledMcpCount === 1 ? "" : "s"} are enabled. Use /mcp to inspect active tools.`;
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
      id: "background-terminal-load",
      label: "Background Work",
      value: backgroundReady ? `${backgroundCount.toLocaleString()} cmds` : "Unknown",
      tone: backgroundSummary?.tone || "medium",
      action: backgroundReady ? backgroundSummary.action || "Use /ps" : "Run /ps",
      priority: backgroundLoaded ? (backgroundSummary.tone === "high" ? 96 : 80) : 25,
      detail: backgroundDetail,
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
      id: "custom-agents",
      label: "Custom Agents",
      value: customAgents.label,
      tone: customAgents.tone,
      action: customAgents.action,
      priority: customAgents.tone === "high" ? 87 : customAgents.tone === "medium" ? 67 : customAgents.agentCount ? 27 : 11,
      detail: customAgents.detail,
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
      id: "local-environment",
      label: "Local Setup",
      value: currentProject ? currentLocalEnvironment?.label || "Unknown" : "No project",
      tone: currentProject ? currentLocalEnvironment?.tone || "medium" : "low",
      action: currentProject ? currentLocalEnvironment?.action || "Review setup" : "Open project",
      priority: currentProject
        ? currentLocalEnvironment?.tone === "medium"
          ? 79
          : currentLocalEnvironment?.hasSetupScript || currentLocalEnvironment?.hasActions
            ? 32
            : 58
        : 10,
      detail: localEnvironmentDetail,
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
      tone: mcpStartupLoaded || enabledPluginCount + enabledMcpCount > 10 ? "medium" : "low",
      action: mcpStartupLoaded ? "/mcp verbose" : enabledPluginCount + enabledMcpCount > 10 ? "Disable unused" : "Keep intentional",
      priority: mcpStartupLoaded ? (mcpSummary.tone === "high" ? 82 : 58) : enabledPluginCount + enabledMcpCount > 10 ? 48 : 14,
      detail: `${enabledPluginCount.toLocaleString()} plugin${enabledPluginCount === 1 ? "" : "s"} and ${enabledMcpCount.toLocaleString()} MCP server${enabledMcpCount === 1 ? "" : "s"} are enabled. ${mcpStartupDetail}`,
    },
    {
      id: "skill-catalog",
      label: "Skill Catalog",
      value: skillCatalogReady ? skillCatalog.label : "Unknown",
      tone: skillCatalogReady ? skillCatalog.tone : "medium",
      action: skillCatalogLoaded ? skillCatalog.action || "/skills" : "Keep concise",
      priority: skillCatalogLoaded ? (skillCatalog.tone === "high" ? 84 : 61) : 13,
      detail:
        skillCatalog.detail ||
        "Codex uses skill name, description, and path metadata to choose reusable workflows. Keep descriptions clear and short.",
    },
    {
      id: "required-mcp",
      label: "Required MCP",
      value: requiredMcpCount ? requiredMcpCount.toLocaleString() : "None",
      tone: requiredMcpCount || mcpSummary.missingEnvVarCount ? "medium" : "low",
      action: requiredMcpCount ? "Reserve for critical" : mcpSummary.missingEnvVarCount ? "Check env" : "No startup blockers",
      priority: requiredMcpCount ? 60 : mcpSummary.missingEnvVarCount ? 54 : 12,
      detail:
        requiredMcpCount > 0
          ? `Required MCP servers can block startup if they fail. Use required only for tools every run truly needs. ${mcpSummary.missingEnvVarCount ? `${mcpSummary.missingEnvVarCount.toLocaleString()} referenced environment variable${mcpSummary.missingEnvVarCount === 1 ? "" : "s"} ${pluralVerb(mcpSummary.missingEnvVarCount)} not visible to Refit.` : ""}`
          : mcpSummary.missingEnvVarCount
            ? `${mcpSummary.missingEnvVarCount.toLocaleString()} referenced MCP environment variable${mcpSummary.missingEnvVarCount === 1 ? "" : "s"} ${pluralVerb(mcpSummary.missingEnvVarCount)} not visible to Refit. Desktop apps may need ~/.codex/.env plus restart.`
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

  if (backgroundLoaded) {
    addRecommendation({
      id: "background-terminal-load",
      label: "Background Work",
      value: `${backgroundCount.toLocaleString()} cmds`,
      action: "/ps, then /stop",
      tone: backgroundSummary.tone === "high" ? "high" : "medium",
      priority: backgroundSummary.tone === "high" ? 97 : 83,
      detail:
        backgroundSummary.tone === "high"
          ? `Codex has ${backgroundCount.toLocaleString()} background command${backgroundCount === 1 ? "" : "s"} using ${formatBytesServer(backgroundRssBytes)} and about ${backgroundCpuPercent.toFixed(0)}% CPU. Inspect with /ps before stopping anything.`
          : `Codex has ${backgroundCount.toLocaleString()} background command${backgroundCount === 1 ? "" : "s"} still running. Use /ps before judging cleanup results.`,
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

  if (approvalFlow.autoReviewApplies) {
    addRecommendation({
      id: "approval-auto-review",
      label: "Approval Review",
      value: "Auto review",
      action: "Review policy",
      tone: "medium",
      priority: 74,
      detail:
        "Auto-review can make approvals less manual, but it uses extra model calls for eligible interactive approval requests. Route approvals to you for the lowest-latency local run.",
    });
  }

  if (managedConfig.status === "ready" && managedConfig.tone !== "low") {
    addRecommendation({
      id: "managed-config",
      label: "Managed Config",
      value: managedConfig.label,
      action: managedConfig.action || "Check admin settings",
      tone: managedConfig.tone === "high" ? "high" : "medium",
      priority: managedConfig.conflictCount || managedConfig.managedMcpBlockedCount ? 88 : 57,
      detail:
        managedConfig.conflictCount || managedConfig.managedMcpBlockedCount
          ? `${managedConfig.detail} Check this before changing local config again.`
          : managedConfig.detail,
    });
  }

  if (commandRules.status === "ready" && commandRules.tone !== "low") {
    addRecommendation({
      id: "command-rules",
      label: "Command Rules",
      value: commandRules.label,
      action: commandRules.action || "Review execpolicy",
      tone: commandRules.tone === "high" ? "high" : "medium",
      priority: commandRules.broadPromptRuleCount || commandRules.parseWarningCount ? 87 : 59,
      detail:
        commandRules.broadPromptRuleCount > 0
          ? `${commandRules.detail} Narrow broad prompt rules before changing approval policy.`
          : commandRules.detail,
    });
  }

  if (networkSandbox.status === "ready" && networkSandbox.tone !== "low") {
    addRecommendation({
      id: "network-sandbox",
      label: "Network Sandbox",
      value: networkSandbox.label,
      action: networkSandbox.action || "Review network",
      tone: networkSandbox.tone === "high" ? "high" : "medium",
      priority:
        networkSandbox.networkProxyNoEffect || networkSandbox.globalAllow || networkSandbox.dangerousNetworkSettingCount
          ? 79
          : networkSandbox.unrestrictedDirectNetwork
            ? 61
            : 45,
      detail:
        networkSandbox.networkProxyNoEffect
          ? `${networkSandbox.detail} Turn on sandbox_workspace_write.network_access only when the task needs command network access.`
          : networkSandbox.detail,
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

  if (customAgents.status === "ready" && customAgents.tone !== "low") {
    addRecommendation({
      id: "custom-agents",
      label: "Custom Agents",
      value: customAgents.label,
      action: customAgents.action || "Review agents",
      tone: customAgents.tone === "high" ? "high" : "medium",
      priority: customAgents.tone === "high" ? 81 : 61,
      detail:
        customAgents.invalidAgentCount || customAgents.missingMcpEnvVarCount
          ? `${customAgents.detail} Fix invalid agents before relying on subagent workflows for speed.`
          : customAgents.detail,
    });
  }

  if (mcpSummary.status === "ready" && mcpSummary.tone !== "low") {
    addRecommendation({
      id: "mcp-startup-pressure",
      label: "MCP Startup",
      value: mcpSummary.label,
      action: "/mcp verbose",
      tone: mcpSummary.tone === "high" ? "high" : "medium",
      priority: mcpSummary.tone === "high" ? 84 : 62,
      detail:
        mcpSummary.missingEnvVarCount > 0
          ? `${mcpSummary.missingEnvVarCount.toLocaleString()} referenced MCP environment variable${mcpSummary.missingEnvVarCount === 1 ? "" : "s"} ${pluralVerb(mcpSummary.missingEnvVarCount)} not visible to Refit. Check /mcp verbose and ~/.codex/.env before blaming Codex latency.`
          : `${mcpSummary.detail} Disable optional servers you do not need in every run.`,
    });
  }

  if (skillCatalogLoaded) {
    addRecommendation({
      id: "skill-catalog-pressure",
      label: "Skill Catalog",
      value: skillCatalog.label,
      action: skillCatalog.action || "/skills",
      tone: skillCatalog.tone === "high" ? "high" : "medium",
      priority: skillCatalog.tone === "high" ? 85 : 63,
      detail:
        skillCatalog.overBudget
          ? `${skillCatalog.detail} Review unused local/plugin skills and shorten long descriptions before chasing deeper prompt-routing problems.`
          : skillCatalog.detail,
    });
  }

  if (shellEnvironmentSummary.status === "ready" && shellEnvironmentSummary.tone !== "low") {
    addRecommendation({
      id: "shell-environment-policy",
      label: "Shell Env",
      value: shellEnvironmentSummary.label,
      action: shellEnvironmentSummary.action,
      tone: shellEnvironmentSummary.tone === "high" ? "high" : "medium",
      priority: shellEnvironmentSummary.tone === "high" ? 81 : 57,
      detail:
        shellEnvironmentSummary.pathAvailable
          ? `${shellEnvironmentSummary.detail} Use shell_environment_policy to keep spawned commands fast, predictable, and scoped.`
          : `${shellEnvironmentSummary.detail} Restore PATH with include_only or set before judging command failures.`,
    });
  }

  if (contextBudgetSummary.status === "ready" && contextBudgetSummary.tone !== "low") {
    addRecommendation({
      id: "context-budget",
      label: "Context Budget",
      value: contextBudgetSummary.label,
      action: contextBudgetSummary.action,
      tone: contextBudgetSummary.tone === "high" ? "high" : "medium",
      priority: contextBudgetSummary.tone === "high" ? 80 : 56,
      detail:
        contextBudgetSummary.toolOutputWide
          ? `${contextBudgetSummary.detail} Keep huge logs in files and ask Codex to inspect slices.`
          : `${contextBudgetSummary.detail} Use /compact after long runs so key decisions survive without flooding context.`,
    });
  }

  if (responseShapeSummary.status === "ready" && responseShapeSummary.tone !== "low") {
    addRecommendation({
      id: "response-shape",
      label: "Response Shape",
      value: responseShapeSummary.label,
      action: responseShapeSummary.action,
      tone: responseShapeSummary.tone === "high" ? "high" : "medium",
      priority: responseShapeSummary.tone === "high" ? 78 : 52,
      detail: responseShapeSummary.detail,
    });
  }

  if (instructionStack.status === "ready" && instructionStack.tone !== "low") {
    addRecommendation({
      id: "instruction-stack",
      label: "Instruction Stack",
      value: formatBytesServer(instructionStack.projectCandidateBytes || instructionStack.totalBytes || 0),
      action: instructionStack.action || "Review guidance",
      tone: instructionStack.tone === "high" ? "high" : "medium",
      priority: instructionStack.tone === "high" ? 83 : 59,
      detail:
        instructionStack.projectOverCap
          ? `${instructionStack.detail} Keep the always-loaded files concise or split guidance closer to the directories where it applies.`
          : instructionStack.detail,
    });
  }

  if (instructionOverrides.status === "ready" && instructionOverrides.tone !== "low") {
    addRecommendation({
      id: "instruction-overrides",
      label: "Instruction Overrides",
      value: instructionOverrides.label,
      action: instructionOverrides.action || "Review overrides",
      tone: instructionOverrides.tone === "high" ? "high" : "medium",
      priority: instructionOverrides.tone === "high" ? 82 : 58,
      detail:
        instructionOverrides.missingFileCount > 0
          ? `${instructionOverrides.detail} Fix or remove missing instruction file references before debugging prompt quality.`
          : instructionOverrides.modelInstructionsFileConfigured
            ? `${instructionOverrides.detail} Prefer this only when you intentionally need to replace the default Codex base behavior.`
            : instructionOverrides.detail,
    });
  }

  if (currentProject && !currentProject.ready) {
    addRecommendation({
      id: "project-playbook",
      label: "Project Playbook",
      value: `${currentProject.score}/100`,
      action: currentProject.hasAgents ? (currentLocalEnvironment?.tone !== "low" ? "Add setup/actions" : "Add verification") : "Add AGENTS.md",
      tone: "medium",
      priority: 72,
      detail: projectDetail,
    });
  }

  if (currentProject && currentLocalEnvironment?.tone !== "low") {
    addRecommendation({
      id: "local-environment",
      label: "Local Setup",
      value: currentLocalEnvironment.label,
      action: currentLocalEnvironment.action,
      tone: "medium",
      priority: 70,
      detail: localEnvironmentDetail,
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

  if (customPrompts.status === "ready" && customPrompts.tone !== "low") {
    addRecommendation({
      id: "custom-prompts",
      label: "Custom Prompts",
      value: customPrompts.label,
      action: customPrompts.action || "Review prompts",
      tone: customPrompts.tone === "high" ? "high" : "medium",
      priority: customPrompts.tone === "high" ? 53 : 43,
      detail: customPrompts.detail,
    });
  }

  if (webSearchLive) {
    addRecommendation({
      id: "web-search-live",
      label: "Web Search",
      value: webSearchLabel,
      action: "Use cached/local",
      tone: "medium",
      priority: 50,
      detail: "Live web search is useful for current facts, but cached or disabled search can make local-only coding runs steadier.",
    });
  }

  if (webSearchLegacyKeyCount) {
    addRecommendation({
      id: "legacy-web-search",
      label: "Web Search",
      value: "Legacy keys",
      action: "Use web_search",
      tone: "medium",
      priority: 49,
      detail: `Replace deprecated ${webSearchLegacyKeys.join(", ")} with web_search = "${webSearchEffectiveMode}" so profiles and managed config resolve predictably.`,
    });
  }

  if (hooksFeature && hookSummary.status === "ready" && hookTone !== "low") {
    addRecommendation({
      id: "hook-load",
      label: "Lifecycle Hooks",
      value: `${hookCommandCount.toLocaleString()} hooks`,
      action: "Review /hooks",
      tone: hookTone === "high" ? "high" : "medium",
      priority: hookTone === "high" ? 89 : 69,
      detail:
        hookTurnScopedCount > 0
          ? `${hookTurnScopedCount.toLocaleString()} hook command${hookTurnScopedCount === 1 ? "" : "s"} can run at turn or tool scope. Matching hooks from multiple files all run, so stale hooks can add latency.`
          : "Lifecycle hooks are configured. Review loaded hook sources and trust state with /hooks.",
    });
  }

  if (memoryTone === "medium") {
    addRecommendation({
      id: "memory-context",
      label: "Memory Context",
      value: formatBytesServer(memoryBytes),
      action: "Review memories",
      tone: "medium",
      priority: 58,
      detail:
        "Local memories can be useful hidden context. If Codex starts carrying stale assumptions, review memory files and keep hard requirements in AGENTS.md instead.",
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
    approvalPolicy: codexConfig?.approvalPolicy || null,
    approvalReviewer: codexConfig?.approvalReviewer || "user",
    approvalFlow,
    fastMode,
    serviceTier: tier,
    desktopServiceTier: desktopTier,
    displayServiceTier: displayTier,
    fastModeFeature,
    shellSnapshot,
    shellEnvironmentSummary,
    contextBudgetSummary,
    responseShapeSummary,
    networkSandbox,
    instructionStack,
    instructionOverrides,
    goalsFeature,
    webSearchMode: webSearchEffectiveMode,
    webSearchLabel,
    webSearchLegacyKeyCount,
    webSearchLegacyKeys,
    hooksFeature,
    rulesFeature: codexConfig?.rulesFeature !== false,
    hookSummary,
    commandRules,
    memoriesFeature,
    memoriesUseMemories: codexConfig?.memoriesUseMemories ?? null,
    memoriesUseMemoriesEffective: memoriesUse,
    memoriesGenerateMemories: codexConfig?.memoriesGenerateMemories ?? null,
    memoriesGenerateMemoriesEffective: memoriesGenerate,
    memoriesDisableOnExternalContext: codexConfig?.memoriesDisableOnExternalContext ?? null,
    memoriesMinRateLimitRemainingPercent: codexConfig?.memoriesMinRateLimitRemainingPercent ?? null,
    memoriesExtractModel: codexConfig?.memoriesExtractModel ?? null,
    memoriesConsolidationModel: codexConfig?.memoriesConsolidationModel ?? null,
    maxConcurrentThreadsPerSession: codexConfig?.maxConcurrentThreadsPerSession || null,
    agentMaxThreads: codexConfig?.agentMaxThreads ?? null,
    agentMaxThreadsEffective: agentMaxThreads,
    agentMaxDepth: codexConfig?.agentMaxDepth ?? null,
    agentMaxDepthEffective: agentMaxDepth,
    agentJobMaxRuntimeSeconds: codexConfig?.agentJobMaxRuntimeSeconds ?? null,
    customAgents,
    customPrompts,
    managedConfig,
    commandRules,
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
    mcpSummary,
    skillCatalog,
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
  categories.memoryState.hotspots = [
    `${categories.memoryState.fileCount.toLocaleString()} memory file${categories.memoryState.fileCount === 1 ? "" : "s"}`,
    categories.memoryState.bytes
      ? `${formatBytesServer(categories.memoryState.bytes)} of local recall context to review before sharing.`
      : "No local memory files found.",
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
    memoryState,
    crashDumps,
    browserCaches,
    archivedStillInSessions,
    activeStale,
    archivedDeleteCandidates,
    logs,
    state,
    preflight,
    codexConfig,
    skillCatalog,
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
    summarizeMany([paths.memories, paths.memoriesExtensions], {
      label: "Memory State",
      pathLabel: "memories + memories_extensions",
      risk: "scan",
      largestLimit: 8,
      largestPredicate: (filePath) => /\.(md|json|jsonl|txt)$/i.test(filePath),
    }),
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
    getSkillCatalogSummary(),
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
    memoryState,
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
    skillCatalog,
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
  score -= Math.min(12, Math.max(0, Number(metrics.backgroundProcessCount || 0)) * 2);
  score -= Math.min(10, Math.max(0, Number(metrics.backgroundCpuPercent || 0)) * 0.18);
  score -= Math.min(8, ((Number(metrics.backgroundRssBytes || 0) / 1024 ** 3) || 0) * 2);
  score -= Math.min(8, Math.max(0, Number(metrics.agentMaxDepth || 1) - 1) * 4);
  score -= Math.min(6, Math.max(0, Number(metrics.agentMaxThreads || 6) - 12) * 0.45);
  score -= Math.min(8, Number(metrics.customAgentInvalidCount || 0) * 4);
  score -= Math.min(5, Number(metrics.customAgentBuiltInOverrideCount || 0) * 3);
  score -= Math.min(5, Number(metrics.customAgentMissingMcpEnvVarCount || 0) * 2);
  score -= Math.min(4, Number(metrics.customAgentHighEffortCount || 0) * 1.2);
  score -= Math.min(4, Math.max(0, Number(metrics.customAgentInstructionBytes || 0) - 12 * 1024) / 8192);
  score -= Math.min(8, Math.max(0, Number(metrics.hookTurnScopedCommandCount || 0) - 1) * 1.2);
  score -= Math.min(4, Math.max(0, Number(metrics.hookBroadMatcherCount || 0)) * 1.5);
  if (metrics.approvalAutoReview) score -= 4;
  score -= Math.min(8, Math.max(0, Number(metrics.mcpEnabledCount || 0) - 6) * 0.7);
  score -= Math.min(5, Number(metrics.mcpRequiredCount || 0) * 1.5);
  score -= Math.min(5, Number(metrics.mcpMissingEnvVarCount || 0) * 2);
  score -= Math.min(3, Number(metrics.mcpLongStartupTimeoutCount || 0) * 1.2);
  if (!metrics.shellEnvTightPolicy) score -= Math.min(5, Math.max(0, Number(metrics.shellEnvVarCount || 0) - 80) * 0.035);
  if (!metrics.shellEnvTightPolicy) score -= Math.min(4, Number(metrics.shellEnvSecretLikeNameCount || 0) * 0.35);
  if (metrics.shellEnvMissingPath) score -= 6;
  score -= Math.min(6, Math.max(0, Number(metrics.toolOutputTokenLimit || 12000) - 12000) / 4000);
  if (metrics.responseHighVerbosity) score -= 2;
  if (metrics.responseDetailedSummary) score -= 1;
  if (metrics.responseRawReasoning) score -= 2;
  if (metrics.responseSummariesForced) score -= 1;
  if (metrics.compactTooLate) score -= 4;
  if (metrics.compactEarly) score -= 2;
  if (metrics.smallContextWindow) score -= 3;
  score -= Math.min(5, Math.max(0, Number(metrics.instructionTotalBytes || 0) - 24 * 1024) / 8192);
  if (metrics.instructionProjectOverCap) score -= 5;
  if (metrics.instructionProjectNearCap) score -= 2;
  score -= Math.min(5, Math.max(0, Number(metrics.instructionOverrideBytes || 0) - 12 * 1024) / 8192);
  if (metrics.instructionOverrideMissingFileCount) score -= Math.min(6, Number(metrics.instructionOverrideMissingFileCount || 0) * 3);
  if (metrics.modelInstructionsFileConfigured) score -= 2;
  score -= Math.min(3, Math.max(0, Number(metrics.customPromptCount || 0) - 5) * 0.35);
  score -= Math.min(3, Math.max(0, Number(metrics.customPromptBytes || 0) - 24 * 1024) / 8192);
  if (metrics.memoriesUseMemories) score -= Math.min(5, ((Number(metrics.memoryBytes || 0) / 1024 ** 2) || 0) / 3);
  score -= Math.min(5, Math.max(0, Number(metrics.skillEstimatedCatalogChars || 0) - skillCatalogBudgetChars) / 4000);
  score -= Math.min(4, Math.max(0, Number(metrics.skillCount || 0) - 40) * 0.08);
  if (metrics.skillCatalogTruncated) score -= 2;
  score -= Math.min(5, Number(metrics.managedConfigConflictCount || 0) * 2);
  score -= Math.min(3, Number(metrics.managedMcpBlockedCount || 0) * 1.5);
  score -= Math.min(3, Number(metrics.managedHookCount || 0) * 0.75);
  score -= Math.min(5, Number(metrics.commandRuleBroadPromptCount || 0) * 1.5);
  score -= Math.min(4, Math.max(0, Number(metrics.commandRulePromptCount || 0) - 6) * 0.2);
  score -= Math.min(3, Number(metrics.commandRuleParseWarningCount || 0) * 1.5);
  if (metrics.networkProxyNoEffect) score -= 3;
  if (metrics.networkGlobalAllow) score -= 2;
  if (metrics.networkDangerousSettingCount) score -= Math.min(4, Number(metrics.networkDangerousSettingCount || 0) * 2);
  if (metrics.webSearchLive) score -= 2;
  if (metrics.webSearchLegacyKeyCount) score -= Math.min(2, Number(metrics.webSearchLegacyKeyCount || 0));
  if (metrics.projectHasUsefulScripts && !metrics.localEnvironmentHasSetupScript) score -= 2;
  if (metrics.projectHasUsefulScripts && !metrics.localEnvironmentHasActions) score -= 2;
  score -= Math.min(3, Number(metrics.localEnvironmentParseWarningCount || 0) * 1.5);
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
  if (metrics.backgroundProcessCount > 0) {
    guidance.push(
      `Use /ps to inspect ${Number(metrics.backgroundProcessCount).toLocaleString()} Codex background command${metrics.backgroundProcessCount === 1 ? "" : "s"} before using /stop.`,
    );
  }
  if (metrics.agentMaxDepth > 1) {
    guidance.push(
      `Cap subagent depth back toward 1 unless you deliberately need recursive delegation; depth ${Number(metrics.agentMaxDepth).toLocaleString()} can add latency and resource load.`,
    );
  } else if (metrics.agentMaxThreads >= 12) {
    guidance.push(`Keep subagent fan-out scoped; agents.max_threads is ${Number(metrics.agentMaxThreads).toLocaleString()}.`);
  }
  if (metrics.customAgentInvalidCount > 0) {
    guidance.push(`Fix ${Number(metrics.customAgentInvalidCount).toLocaleString()} invalid custom agent file${metrics.customAgentInvalidCount === 1 ? "" : "s"} before using subagents for speed.`);
  } else if (metrics.customAgentMissingMcpEnvVarCount > 0) {
    guidance.push(
      `Check custom agent MCP setup: ${Number(metrics.customAgentMissingMcpEnvVarCount).toLocaleString()} referenced env var${metrics.customAgentMissingMcpEnvVarCount === 1 ? "" : "s"} ${metrics.customAgentMissingMcpEnvVarCount === 1 ? "was" : "were"} not visible to Refit.`,
    );
  } else if (metrics.customAgentBuiltInOverrideCount > 0) {
    guidance.push(`Review ${Number(metrics.customAgentBuiltInOverrideCount).toLocaleString()} custom agent name${metrics.customAgentBuiltInOverrideCount === 1 ? "" : "s"} overriding built-in agents.`);
  } else if (metrics.customAgentHighEffortCount > 0) {
    guidance.push(`Review custom agents with high/xhigh reasoning; use lighter effort for fast scan-style subagents.`);
  }
  if (metrics.memoriesUseMemories && metrics.memoryBytes > 10 * 1024 ** 2) {
    guidance.push(`Review ${formatBytesServer(metrics.memoryBytes)} of local memories if Codex starts carrying stale assumptions.`);
  }
  if (metrics.skillCatalogTruncated) {
    guidance.push("Review installed skills with /skills; Refit hit its skill scan cap, so the local/plugin skill catalog may be oversized.");
  } else if (metrics.skillEstimatedCatalogChars >= skillCatalogBudgetChars) {
    guidance.push(
      `Review the skill catalog with /skills; Refit estimates ${Number(metrics.skillEstimatedCatalogChars).toLocaleString()} skill metadata characters before Codex chooses a skill.`,
    );
  } else if (metrics.skillCount >= 40) {
    guidance.push(`Keep skill descriptions tight; ${Number(metrics.skillCount).toLocaleString()} skills are available to Codex.`);
  }
  if (metrics.customPromptCount > 0) {
    guidance.push(
      `Review ${Number(metrics.customPromptCount).toLocaleString()} deprecated custom prompt${metrics.customPromptCount === 1 ? "" : "s"}; use skills for reusable workflows as you update them.`,
    );
  }
  if (metrics.managedConfigConflictCount > 0) {
    guidance.push(
      `Review managed Codex config before editing local settings again; ${Number(metrics.managedConfigConflictCount).toLocaleString()} local setting${metrics.managedConfigConflictCount === 1 ? "" : "s"} appear to disagree with managed defaults or requirements.`,
    );
  } else if (metrics.managedRequirementKeyCount > 0 || metrics.managedConfigKeyCount > 0) {
    guidance.push("Managed Codex defaults or requirements are active. Keep that layer in mind when speed settings seem to reset.");
  }
  if (metrics.managedMcpBlockedCount > 0) {
    guidance.push(
      `${Number(metrics.managedMcpBlockedCount).toLocaleString()} MCP server${metrics.managedMcpBlockedCount === 1 ? "" : "s"} may be outside the managed allowlist; check admin policy before debugging MCP startup.`,
    );
  }
  if (metrics.commandRuleBroadPromptCount > 0) {
    guidance.push(
      `Narrow ${Number(metrics.commandRuleBroadPromptCount).toLocaleString()} broad command prompt rule${metrics.commandRuleBroadPromptCount === 1 ? "" : "s"}; broad prefix_rule patterns can make routine escalations stop repeatedly.`,
    );
  } else if (metrics.commandRulePromptCount >= 8) {
    guidance.push(
      `Review ${Number(metrics.commandRulePromptCount).toLocaleString()} prompt command rule${metrics.commandRulePromptCount === 1 ? "" : "s"} with codex execpolicy check before changing approval policy.`,
    );
  }
  if (metrics.commandRuleParseWarningCount > 0) {
    guidance.push(
      `Test ${Number(metrics.commandRuleParseWarningCount).toLocaleString()} command rule warning${metrics.commandRuleParseWarningCount === 1 ? "" : "s"} with codex execpolicy check.`,
    );
  }
  if (metrics.networkProxyNoEffect) {
    guidance.push("Network proxy is enabled, but command network access is off. Turn on sandbox_workspace_write.network_access only for tasks that need command network.");
  } else if (metrics.networkUnrestrictedDirect) {
    guidance.push("Command network access is on without Codex network_proxy policy. Add scoped domain rules for repeat workflows that fetch or install.");
  } else if (metrics.networkCommandAccess === false) {
    guidance.push("Command network access is off in the workspace sandbox. Installs and fetches may need approval or a task-specific network setting.");
  }
  if (metrics.networkGlobalAllow) {
    guidance.push("Network policy has a global '*' allow rule. Prefer exact hosts or scoped wildcards for faster, safer repeat runs.");
  }
  if (metrics.webSearchLive) {
    guidance.push("Switch web_search to cached for most local coding runs; keep live search for tasks that truly need current external facts.");
  }
  if (metrics.webSearchLegacyKeyCount > 0) {
    guidance.push(
      `Replace ${Number(metrics.webSearchLegacyKeyCount).toLocaleString()} deprecated web-search key${metrics.webSearchLegacyKeyCount === 1 ? "" : "s"} with the modern web_search mode.`,
    );
  }
  if (metrics.hooksFeature !== false && metrics.hookTurnScopedCommandCount >= 2) {
    guidance.push(
      `Review ${Number(metrics.hookTurnScopedCommandCount).toLocaleString()} turn/tool-scope lifecycle hook command${metrics.hookTurnScopedCommandCount === 1 ? "" : "s"} with /hooks if Codex commands feel slow.`,
    );
  }
  if (metrics.approvalAutoReview) {
    guidance.push("Auto-review is enabled for interactive approvals. It can reduce clicks, but uses extra model calls for eligible approval requests.");
  }
  if (metrics.mcpMissingEnvVarCount > 0) {
    guidance.push(
      `Check MCP environment setup: ${Number(metrics.mcpMissingEnvVarCount).toLocaleString()} referenced env var${metrics.mcpMissingEnvVarCount === 1 ? "" : "s"} ${metrics.mcpMissingEnvVarCount === 1 ? "was" : "were"} not visible to Refit.`,
    );
  } else if (metrics.mcpRequiredCount > 0) {
    guidance.push(
      `Review ${Number(metrics.mcpRequiredCount).toLocaleString()} required MCP server${metrics.mcpRequiredCount === 1 ? "" : "s"} with /mcp verbose; required servers can fail session startup if initialization breaks.`,
    );
  } else if (metrics.mcpEnabledCount >= 8) {
    guidance.push(`Trim optional MCP servers for quick local tasks; ${Number(metrics.mcpEnabledCount).toLocaleString()} are enabled.`);
  }
  if (metrics.shellEnvMissingPath) {
    guidance.push("Shell environment policy does not clearly preserve PATH for spawned commands. Restore PATH before chasing tool failures.");
  } else if (!metrics.shellEnvTightPolicy && metrics.shellEnvVarCount >= 80) {
    guidance.push(
      `Trim shell_environment_policy for spawned commands; Refit sees ${Number(metrics.shellEnvVarCount).toLocaleString()} visible env var${metrics.shellEnvVarCount === 1 ? "" : "s"}.`,
    );
  }
  if (metrics.toolOutputTokenLimit > 24000) {
    guidance.push(`Lower tool_output_token_limit from ${Number(metrics.toolOutputTokenLimit).toLocaleString()} or keep huge logs in files so context stays usable.`);
  } else if (metrics.responseHighVerbosity) {
    guidance.push('Set model_verbosity = "low" for fast small-task runs so Codex writes shorter responses.');
  } else if (metrics.responseDetailedSummary || metrics.responseSummariesForced) {
    guidance.push('Use concise or none for model_reasoning_summary unless you need detailed reasoning summaries.');
  } else if (metrics.responseRawReasoning) {
    guidance.push("Turn off show_raw_agent_reasoning unless you are debugging model behavior.");
  } else if (metrics.compactTooLate) {
    guidance.push("Auto-compact is set very late relative to the context window. Review model_auto_compact_token_limit if long threads get noisy.");
  } else if (metrics.smallContextWindow) {
    guidance.push("Configured context window is small for long work. Expect more frequent compaction or use shorter threads.");
  }
  if (metrics.instructionProjectOverCap) {
    guidance.push(
      `Project guidance is past the configured instruction cap${metrics.instructionProjectCandidateBytes ? ` (${formatBytesServer(metrics.instructionProjectCandidateBytes)} available)` : ""}. Trim AGENTS.md or split rules closer to the directories where they apply.`,
    );
  } else if (metrics.instructionTotalBytes >= 24 * 1024) {
    guidance.push(`Review AGENTS guidance; Codex starts with ${formatBytesServer(metrics.instructionTotalBytes)} of selected instruction files.`);
  } else if (metrics.instructionEmptyFileCount > 0) {
    guidance.push(`Fill in or remove ${Number(metrics.instructionEmptyFileCount).toLocaleString()} empty AGENTS instruction file${metrics.instructionEmptyFileCount === 1 ? "" : "s"}.`);
  }
  if (metrics.instructionOverrideMissingFileCount > 0) {
    guidance.push(
      `Fix ${Number(metrics.instructionOverrideMissingFileCount).toLocaleString()} missing instruction override file reference${metrics.instructionOverrideMissingFileCount === 1 ? "" : "s"} in Codex config.`,
    );
  } else if (metrics.modelInstructionsFileConfigured) {
    guidance.push("Review model_instructions_file; it replaces the default Codex base instructions and can change every run.");
  } else if (metrics.instructionOverrideBytes >= 12 * 1024) {
    guidance.push(`Trim custom instruction overrides; Refit sees ${formatBytesServer(metrics.instructionOverrideBytes)} before AGENTS guidance.`);
  } else if (metrics.compactOverrideBytes >= 12 * 1024) {
    guidance.push(`Review compact prompt overrides; ${formatBytesServer(metrics.compactOverrideBytes)} can affect long-thread summarization.`);
  }
  if (metrics.projectHasUsefulScripts && !metrics.localEnvironmentHasSetupScript) {
    guidance.push("Add a Codex local-environment setup script so new worktrees can install/build without rediscovering the same steps.");
  }
  if (metrics.projectHasUsefulScripts && !metrics.localEnvironmentHasActions) {
    guidance.push("Add Codex local-environment actions for your dev, build, and verification commands so common runs are one click in the app.");
  }
  if (metrics.localEnvironmentParseWarningCount > 0) {
    guidance.push(
      `Check ${Number(metrics.localEnvironmentParseWarningCount).toLocaleString()} local-environment candidate file${metrics.localEnvironmentParseWarningCount === 1 ? "" : "s"} that Refit could not parse cleanly.`,
    );
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
    scoreModel: "local-state-v6",
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
    "backgroundProcessCount",
    "backgroundRssBytes",
    "backgroundCpuPercent",
    "agentMaxThreads",
    "agentMaxDepth",
    "customAgentCount",
    "customAgentInvalidCount",
    "customAgentBuiltInOverrideCount",
    "customAgentHighEffortCount",
    "customAgentMissingMcpEnvVarCount",
    "customAgentInstructionBytes",
    "mcpEnabledCount",
    "mcpRequiredCount",
    "mcpMissingEnvVarCount",
    "mcpStdioCount",
    "mcpHttpCount",
    "mcpLongStartupTimeoutCount",
    "shellEnvVarCount",
    "shellEnvSecretLikeNameCount",
    "contextWindow",
    "autoCompactTokenLimit",
    "toolOutputTokenLimit",
    "responseHighVerbosity",
    "responseDetailedSummary",
    "responseRawReasoning",
    "responseSummariesForced",
    "responseConfiguredCount",
    "instructionTotalBytes",
    "instructionGlobalBytes",
    "instructionProjectBytes",
    "instructionProjectCandidateBytes",
    "instructionSelectedFileCount",
    "instructionEmptyFileCount",
    "instructionOverrideConfiguredCount",
    "instructionOverrideBytes",
    "compactOverrideBytes",
    "instructionOverrideMissingFileCount",
    "hookCommandCount",
    "hookTurnScopedCommandCount",
    "hookBroadMatcherCount",
    "memoryBytes",
    "memoryFiles",
    "skillCount",
    "skillUserManagedCount",
    "skillPluginCount",
    "skillEstimatedCatalogChars",
    "skillDescriptionChars",
    "skillLongDescriptionCount",
    "customPromptCount",
    "customPromptBytes",
    "managedConfigKeyCount",
    "managedRequirementKeyCount",
    "managedConfigConflictCount",
    "managedMcpBlockedCount",
    "managedHookCount",
    "commandRuleCount",
    "commandRulePromptCount",
    "commandRuleForbiddenCount",
    "commandRuleBroadCount",
    "commandRuleBroadPromptCount",
    "commandRuleParseWarningCount",
    "networkDomainRuleCount",
    "networkDangerousSettingCount",
    "networkWritableRootCount",
    "webSearchLive",
    "webSearchDisabled",
    "webSearchLegacyKeyCount",
    "localEnvironmentConfigCount",
    "localEnvironmentCandidateFileCount",
    "localEnvironmentSetupCount",
    "localEnvironmentActionCount",
    "localEnvironmentPlatformSpecificCount",
    "localEnvironmentParseWarningCount",
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
    backgroundProcessCount: entry.metrics.backgroundProcessCount || 0,
    backgroundRssBytes: entry.metrics.backgroundRssBytes || 0,
    backgroundCpuPercent: entry.metrics.backgroundCpuPercent || 0,
    agentMaxThreads: entry.metrics.agentMaxThreads ?? 6,
    agentMaxDepth: entry.metrics.agentMaxDepth ?? 1,
    customAgentCount: entry.metrics.customAgentCount || 0,
    customAgentInvalidCount: entry.metrics.customAgentInvalidCount || 0,
    customAgentBuiltInOverrideCount: entry.metrics.customAgentBuiltInOverrideCount || 0,
    customAgentHighEffortCount: entry.metrics.customAgentHighEffortCount || 0,
    customAgentModelOverrideCount: entry.metrics.customAgentModelOverrideCount || 0,
    customAgentSandboxOverrideCount: entry.metrics.customAgentSandboxOverrideCount || 0,
    customAgentMcpServerCount: entry.metrics.customAgentMcpServerCount || 0,
    customAgentRequiredMcpCount: entry.metrics.customAgentRequiredMcpCount || 0,
    customAgentMissingMcpEnvVarCount: entry.metrics.customAgentMissingMcpEnvVarCount || 0,
    customAgentInstructionBytes: entry.metrics.customAgentInstructionBytes || 0,
    approvalAutoReview: Boolean(entry.metrics.approvalAutoReview),
    approvalInteractive: entry.metrics.approvalInteractive !== false,
    approvalGranularPolicy: Boolean(entry.metrics.approvalGranularPolicy),
    mcpEnabledCount: entry.metrics.mcpEnabledCount || 0,
    mcpRequiredCount: entry.metrics.mcpRequiredCount || 0,
    mcpMissingEnvVarCount: entry.metrics.mcpMissingEnvVarCount || 0,
    mcpStdioCount: entry.metrics.mcpStdioCount || 0,
    mcpHttpCount: entry.metrics.mcpHttpCount || 0,
    mcpLongStartupTimeoutCount: entry.metrics.mcpLongStartupTimeoutCount || 0,
    shellEnvVarCount: entry.metrics.shellEnvVarCount || 0,
    shellEnvSecretLikeNameCount: entry.metrics.shellEnvSecretLikeNameCount || 0,
    shellEnvTightPolicy: Boolean(entry.metrics.shellEnvTightPolicy),
    shellEnvMissingPath: Boolean(entry.metrics.shellEnvMissingPath),
    contextWindow: entry.metrics.contextWindow || 0,
    autoCompactTokenLimit: entry.metrics.autoCompactTokenLimit || 0,
    toolOutputTokenLimit: entry.metrics.toolOutputTokenLimit || 0,
    responseShapeTone: entry.metrics.responseShapeTone || "low",
    responseVerbosity: entry.metrics.responseVerbosity || "default",
    responseReasoningSummary: entry.metrics.responseReasoningSummary || "default",
    responseHighVerbosity: Boolean(entry.metrics.responseHighVerbosity),
    responseLowVerbosity: Boolean(entry.metrics.responseLowVerbosity),
    responseDetailedSummary: Boolean(entry.metrics.responseDetailedSummary),
    responseNoSummary: Boolean(entry.metrics.responseNoSummary),
    responseRawReasoning: Boolean(entry.metrics.responseRawReasoning),
    responseSummariesForced: Boolean(entry.metrics.responseSummariesForced),
    responseConfiguredCount: entry.metrics.responseConfiguredCount || 0,
    compactTooLate: Boolean(entry.metrics.compactTooLate),
    compactEarly: Boolean(entry.metrics.compactEarly),
    smallContextWindow: Boolean(entry.metrics.smallContextWindow),
    instructionTotalBytes: entry.metrics.instructionTotalBytes || 0,
    instructionGlobalBytes: entry.metrics.instructionGlobalBytes || 0,
    instructionProjectBytes: entry.metrics.instructionProjectBytes || 0,
    instructionProjectCandidateBytes: entry.metrics.instructionProjectCandidateBytes || 0,
    instructionSelectedFileCount: entry.metrics.instructionSelectedFileCount || 0,
    instructionEmptyFileCount: entry.metrics.instructionEmptyFileCount || 0,
    instructionOverrideFileCount: entry.metrics.instructionOverrideFileCount || 0,
    instructionLargeFileCount: entry.metrics.instructionLargeFileCount || 0,
    instructionProjectDocMaxBytes: entry.metrics.instructionProjectDocMaxBytes || defaultProjectDocMaxBytes,
    instructionProjectNearCap: Boolean(entry.metrics.instructionProjectNearCap),
    instructionProjectOverCap: Boolean(entry.metrics.instructionProjectOverCap),
    instructionOverrideConfiguredCount: entry.metrics.instructionOverrideConfiguredCount || 0,
    instructionOverrideEffectiveCount: entry.metrics.instructionOverrideEffectiveCount || 0,
    instructionOverrideBytes: entry.metrics.instructionOverrideBytes || 0,
    compactOverrideBytes: entry.metrics.compactOverrideBytes || 0,
    developerInstructionChars: entry.metrics.developerInstructionChars || 0,
    compactPromptChars: entry.metrics.compactPromptChars || 0,
    modelInstructionFileBytes: entry.metrics.modelInstructionFileBytes || 0,
    compactPromptFileBytes: entry.metrics.compactPromptFileBytes || 0,
    instructionOverrideMissingFileCount: entry.metrics.instructionOverrideMissingFileCount || 0,
    developerInstructionsConfigured: Boolean(entry.metrics.developerInstructionsConfigured),
    modelInstructionsFileConfigured: Boolean(entry.metrics.modelInstructionsFileConfigured),
    compactPromptConfigured: Boolean(entry.metrics.compactPromptConfigured),
    compactPromptFileConfigured: Boolean(entry.metrics.compactPromptFileConfigured),
    hooksFeature: entry.metrics.hooksFeature !== false,
    hookCommandCount: entry.metrics.hookCommandCount || 0,
    hookTurnScopedCommandCount: entry.metrics.hookTurnScopedCommandCount || 0,
    hookBroadMatcherCount: entry.metrics.hookBroadMatcherCount || 0,
    memoryBytes: entry.metrics.memoryBytes || 0,
    memoryFiles: entry.metrics.memoryFiles || 0,
    memoriesUseMemories: Boolean(entry.metrics.memoriesUseMemories),
    memoriesGenerateMemories: Boolean(entry.metrics.memoriesGenerateMemories),
    skillCount: entry.metrics.skillCount || 0,
    skillUserManagedCount: entry.metrics.skillUserManagedCount || 0,
    skillSystemCount: entry.metrics.skillSystemCount || 0,
    skillPluginCount: entry.metrics.skillPluginCount || 0,
    skillUserCount: entry.metrics.skillUserCount || 0,
    skillRepoCount: entry.metrics.skillRepoCount || 0,
    skillEstimatedCatalogChars: entry.metrics.skillEstimatedCatalogChars || 0,
    skillDescriptionChars: entry.metrics.skillDescriptionChars || 0,
    skillLongDescriptionCount: entry.metrics.skillLongDescriptionCount || 0,
    skillLargeFileCount: entry.metrics.skillLargeFileCount || 0,
    skillCatalogOverBudget: Boolean(entry.metrics.skillCatalogOverBudget),
    skillCatalogTruncated: Boolean(entry.metrics.skillCatalogTruncated),
    customPromptCount: entry.metrics.customPromptCount || 0,
    customPromptBytes: entry.metrics.customPromptBytes || 0,
    customPromptMissingDescriptionCount: entry.metrics.customPromptMissingDescriptionCount || 0,
    customPromptPlaceholderCount: entry.metrics.customPromptPlaceholderCount || 0,
    customPromptNestedMarkdownCount: entry.metrics.customPromptNestedMarkdownCount || 0,
    managedConfigPresent: Boolean(entry.metrics.managedConfigPresent),
    managedConfigKeyCount: entry.metrics.managedConfigKeyCount || 0,
    managedRequirementKeyCount: entry.metrics.managedRequirementKeyCount || 0,
    managedSpeedKeyCount: entry.metrics.managedSpeedKeyCount || 0,
    managedRequirementSpeedKeyCount: entry.metrics.managedRequirementSpeedKeyCount || 0,
    managedConfigConflictCount: entry.metrics.managedConfigConflictCount || 0,
    managedDefaultConflictCount: entry.metrics.managedDefaultConflictCount || 0,
    managedRequirementConflictCount: entry.metrics.managedRequirementConflictCount || 0,
    managedMcpCount: entry.metrics.managedMcpCount || 0,
    managedMcpBlockedCount: entry.metrics.managedMcpBlockedCount || 0,
    managedHookCount: entry.metrics.managedHookCount || 0,
    managedFeaturePinCount: entry.metrics.managedFeaturePinCount || 0,
    commandRulesFeature: entry.metrics.commandRulesFeature !== false,
    commandRuleSourceCount: entry.metrics.commandRuleSourceCount || 0,
    commandRuleFileCount: entry.metrics.commandRuleFileCount || 0,
    commandRuleCount: entry.metrics.commandRuleCount || 0,
    commandRulePromptCount: entry.metrics.commandRulePromptCount || 0,
    commandRuleForbiddenCount: entry.metrics.commandRuleForbiddenCount || 0,
    commandRuleAllowCount: entry.metrics.commandRuleAllowCount || 0,
    commandRuleBroadCount: entry.metrics.commandRuleBroadCount || 0,
    commandRuleBroadPromptCount: entry.metrics.commandRuleBroadPromptCount || 0,
    commandRuleMissingJustificationCount: entry.metrics.commandRuleMissingJustificationCount || 0,
    commandRuleTestedCount: entry.metrics.commandRuleTestedCount || 0,
    commandRuleParseWarningCount: entry.metrics.commandRuleParseWarningCount || 0,
    commandRuleLargeFileCount: entry.metrics.commandRuleLargeFileCount || 0,
    commandRuleBytes: entry.metrics.commandRuleBytes || 0,
    networkSandboxLabel: entry.metrics.networkSandboxLabel || "Network off",
    networkSandboxTone: entry.metrics.networkSandboxTone || "low",
    networkSandboxMode: entry.metrics.networkSandboxMode || "workspace-write",
    networkCommandAccess: Boolean(entry.metrics.networkCommandAccess),
    networkCommandConfigured: Boolean(entry.metrics.networkCommandConfigured),
    networkProxyEnabled: Boolean(entry.metrics.networkProxyEnabled),
    networkProxyNoEffect: Boolean(entry.metrics.networkProxyNoEffect),
    networkUnrestrictedDirect: Boolean(entry.metrics.networkUnrestrictedDirect),
    networkPermissionsEnabled: Boolean(entry.metrics.networkPermissionsEnabled),
    networkDomainRuleCount: entry.metrics.networkDomainRuleCount || 0,
    networkDomainAllowCount: entry.metrics.networkDomainAllowCount || 0,
    networkDomainDenyCount: entry.metrics.networkDomainDenyCount || 0,
    networkGlobalAllow: Boolean(entry.metrics.networkGlobalAllow),
    networkLocalBindingAllowed: Boolean(entry.metrics.networkLocalBindingAllowed),
    networkDangerousSettingCount: entry.metrics.networkDangerousSettingCount || 0,
    networkWritableRootCount: entry.metrics.networkWritableRootCount || 0,
    networkTmpdirExcluded: Boolean(entry.metrics.networkTmpdirExcluded),
    networkSlashTmpExcluded: Boolean(entry.metrics.networkSlashTmpExcluded),
    webSearchMode: entry.metrics.webSearchMode || "cached",
    webSearchConfigured: Boolean(entry.metrics.webSearchConfigured),
    webSearchLive: Boolean(entry.metrics.webSearchLive),
    webSearchDisabled: Boolean(entry.metrics.webSearchDisabled),
    webSearchLegacyKeyCount: entry.metrics.webSearchLegacyKeyCount || 0,
    projectHasPackageJson: Boolean(entry.metrics.projectHasPackageJson),
    projectHasUsefulScripts: Boolean(entry.metrics.projectHasUsefulScripts),
    localEnvironmentConfigCount: entry.metrics.localEnvironmentConfigCount || 0,
    localEnvironmentCandidateFileCount: entry.metrics.localEnvironmentCandidateFileCount || 0,
    localEnvironmentSetupCount: entry.metrics.localEnvironmentSetupCount || 0,
    localEnvironmentActionCount: entry.metrics.localEnvironmentActionCount || 0,
    localEnvironmentPlatformSpecificCount: entry.metrics.localEnvironmentPlatformSpecificCount || 0,
    localEnvironmentParseWarningCount: entry.metrics.localEnvironmentParseWarningCount || 0,
    localEnvironmentHasSetupScript: Boolean(entry.metrics.localEnvironmentHasSetupScript),
    localEnvironmentHasActions: Boolean(entry.metrics.localEnvironmentHasActions),
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
        backgroundProcessCount: latest.backgroundProcessCount - oldest.backgroundProcessCount,
        backgroundRssBytes: latest.backgroundRssBytes - oldest.backgroundRssBytes,
        mcpEnabledCount: latest.mcpEnabledCount - oldest.mcpEnabledCount,
        mcpRequiredCount: latest.mcpRequiredCount - oldest.mcpRequiredCount,
        mcpMissingEnvVarCount: latest.mcpMissingEnvVarCount - oldest.mcpMissingEnvVarCount,
        customAgentCount: latest.customAgentCount - oldest.customAgentCount,
        customAgentInstructionBytes: latest.customAgentInstructionBytes - oldest.customAgentInstructionBytes,
        shellEnvVarCount: latest.shellEnvVarCount - oldest.shellEnvVarCount,
        shellEnvSecretLikeNameCount: latest.shellEnvSecretLikeNameCount - oldest.shellEnvSecretLikeNameCount,
        toolOutputTokenLimit: latest.toolOutputTokenLimit - oldest.toolOutputTokenLimit,
        responseHighVerbosity: Number(latest.responseHighVerbosity) - Number(oldest.responseHighVerbosity),
        responseDetailedSummary: Number(latest.responseDetailedSummary) - Number(oldest.responseDetailedSummary),
        responseRawReasoning: Number(latest.responseRawReasoning) - Number(oldest.responseRawReasoning),
        responseSummariesForced: Number(latest.responseSummariesForced) - Number(oldest.responseSummariesForced),
        responseConfiguredCount: latest.responseConfiguredCount - oldest.responseConfiguredCount,
        instructionTotalBytes: latest.instructionTotalBytes - oldest.instructionTotalBytes,
        instructionProjectCandidateBytes: latest.instructionProjectCandidateBytes - oldest.instructionProjectCandidateBytes,
        instructionSelectedFileCount: latest.instructionSelectedFileCount - oldest.instructionSelectedFileCount,
        instructionOverrideBytes: latest.instructionOverrideBytes - oldest.instructionOverrideBytes,
        compactOverrideBytes: latest.compactOverrideBytes - oldest.compactOverrideBytes,
        memoryBytes: latest.memoryBytes - oldest.memoryBytes,
        skillCount: latest.skillCount - oldest.skillCount,
        skillEstimatedCatalogChars: latest.skillEstimatedCatalogChars - oldest.skillEstimatedCatalogChars,
        skillLongDescriptionCount: latest.skillLongDescriptionCount - oldest.skillLongDescriptionCount,
        customPromptCount: latest.customPromptCount - oldest.customPromptCount,
        customPromptBytes: latest.customPromptBytes - oldest.customPromptBytes,
        managedConfigKeyCount: latest.managedConfigKeyCount - oldest.managedConfigKeyCount,
        managedRequirementKeyCount: latest.managedRequirementKeyCount - oldest.managedRequirementKeyCount,
        managedConfigConflictCount: latest.managedConfigConflictCount - oldest.managedConfigConflictCount,
        managedMcpBlockedCount: latest.managedMcpBlockedCount - oldest.managedMcpBlockedCount,
        commandRuleCount: latest.commandRuleCount - oldest.commandRuleCount,
        commandRulePromptCount: latest.commandRulePromptCount - oldest.commandRulePromptCount,
        commandRuleBroadPromptCount: latest.commandRuleBroadPromptCount - oldest.commandRuleBroadPromptCount,
        commandRuleParseWarningCount: latest.commandRuleParseWarningCount - oldest.commandRuleParseWarningCount,
        networkDomainRuleCount: latest.networkDomainRuleCount - oldest.networkDomainRuleCount,
        networkDangerousSettingCount: latest.networkDangerousSettingCount - oldest.networkDangerousSettingCount,
        networkWritableRootCount: latest.networkWritableRootCount - oldest.networkWritableRootCount,
        webSearchLive: Number(latest.webSearchLive) - Number(oldest.webSearchLive),
        webSearchDisabled: Number(latest.webSearchDisabled) - Number(oldest.webSearchDisabled),
        webSearchLegacyKeyCount: latest.webSearchLegacyKeyCount - oldest.webSearchLegacyKeyCount,
        localEnvironmentConfigCount: latest.localEnvironmentConfigCount - oldest.localEnvironmentConfigCount,
        localEnvironmentSetupCount: latest.localEnvironmentSetupCount - oldest.localEnvironmentSetupCount,
        localEnvironmentActionCount: latest.localEnvironmentActionCount - oldest.localEnvironmentActionCount,
        localEnvironmentPlatformSpecificCount: latest.localEnvironmentPlatformSpecificCount - oldest.localEnvironmentPlatformSpecificCount,
        localEnvironmentParseWarningCount: latest.localEnvironmentParseWarningCount - oldest.localEnvironmentParseWarningCount,
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
        backgroundProcessCount: latest.backgroundProcessCount - previous.backgroundProcessCount,
        mcpEnabledCount: latest.mcpEnabledCount - previous.mcpEnabledCount,
        mcpRequiredCount: latest.mcpRequiredCount - previous.mcpRequiredCount,
        customAgentCount: latest.customAgentCount - previous.customAgentCount,
        shellEnvVarCount: latest.shellEnvVarCount - previous.shellEnvVarCount,
        toolOutputTokenLimit: latest.toolOutputTokenLimit - previous.toolOutputTokenLimit,
        responseHighVerbosity: Number(latest.responseHighVerbosity) - Number(previous.responseHighVerbosity),
        responseDetailedSummary: Number(latest.responseDetailedSummary) - Number(previous.responseDetailedSummary),
        responseRawReasoning: Number(latest.responseRawReasoning) - Number(previous.responseRawReasoning),
        responseConfiguredCount: latest.responseConfiguredCount - previous.responseConfiguredCount,
        instructionTotalBytes: latest.instructionTotalBytes - previous.instructionTotalBytes,
        instructionProjectCandidateBytes: latest.instructionProjectCandidateBytes - previous.instructionProjectCandidateBytes,
        instructionOverrideBytes: latest.instructionOverrideBytes - previous.instructionOverrideBytes,
        skillCount: latest.skillCount - previous.skillCount,
        skillEstimatedCatalogChars: latest.skillEstimatedCatalogChars - previous.skillEstimatedCatalogChars,
        customPromptCount: latest.customPromptCount - previous.customPromptCount,
        managedConfigConflictCount: latest.managedConfigConflictCount - previous.managedConfigConflictCount,
        managedMcpBlockedCount: latest.managedMcpBlockedCount - previous.managedMcpBlockedCount,
        commandRulePromptCount: latest.commandRulePromptCount - previous.commandRulePromptCount,
        commandRuleBroadPromptCount: latest.commandRuleBroadPromptCount - previous.commandRuleBroadPromptCount,
        networkDomainRuleCount: latest.networkDomainRuleCount - previous.networkDomainRuleCount,
        networkDangerousSettingCount: latest.networkDangerousSettingCount - previous.networkDangerousSettingCount,
        webSearchLive: Number(latest.webSearchLive) - Number(previous.webSearchLive),
        webSearchDisabled: Number(latest.webSearchDisabled) - Number(previous.webSearchDisabled),
        webSearchLegacyKeyCount: latest.webSearchLegacyKeyCount - previous.webSearchLegacyKeyCount,
        localEnvironmentSetupCount: latest.localEnvironmentSetupCount - previous.localEnvironmentSetupCount,
        localEnvironmentActionCount: latest.localEnvironmentActionCount - previous.localEnvironmentActionCount,
        localEnvironmentParseWarningCount: latest.localEnvironmentParseWarningCount - previous.localEnvironmentParseWarningCount,
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
  const managedConfigSummary = scan.codexConfig?.managedConfig || emptyManagedConfigSummary();
  const commandRuleSummary = scan.codexConfig?.commandRules || emptyCommandRuleSummary(scan.codexConfig?.rulesFeature !== false);
  const networkSandbox = scan.codexConfig?.networkSandbox || emptyNetworkSandboxSummary();
  const currentProject = scan.codexConfig?.projectReadiness?.currentProject || null;
  const localEnvironment = currentProject?.localEnvironment || emptyLocalEnvironmentSummary({ hasCodexDir: Boolean(currentProject?.hasCodexDir) });
  const webSearchEffectiveMode = scan.codexConfig?.webSearchEffectiveMode || scan.codexConfig?.webSearchMode || "cached";
  const responseShapeSummary = scan.codexConfig?.responseShapeSummary || buildResponseShapeSummary({});

  const metrics = {
    scoreModel: "local-state-v6",
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
    backgroundProcessCount: scan.processes?.background?.processCount || 0,
    backgroundRssBytes: scan.processes?.background?.rssBytes || 0,
    backgroundCpuPercent: scan.processes?.background?.cpuPercent || 0,
    agentMaxThreads: scan.codexConfig?.agentMaxThreadsEffective ?? 6,
    agentMaxDepth: scan.codexConfig?.agentMaxDepthEffective ?? 1,
    customAgentCount: scan.codexConfig?.customAgents?.agentCount || 0,
    customAgentInvalidCount: scan.codexConfig?.customAgents?.invalidAgentCount || 0,
    customAgentBuiltInOverrideCount: scan.codexConfig?.customAgents?.builtInOverrideCount || 0,
    customAgentHighEffortCount: scan.codexConfig?.customAgents?.highEffortCount || 0,
    customAgentModelOverrideCount: scan.codexConfig?.customAgents?.modelOverrideCount || 0,
    customAgentSandboxOverrideCount: scan.codexConfig?.customAgents?.sandboxOverrideCount || 0,
    customAgentMcpServerCount: scan.codexConfig?.customAgents?.mcpServerCount || 0,
    customAgentRequiredMcpCount: scan.codexConfig?.customAgents?.requiredMcpCount || 0,
    customAgentMissingMcpEnvVarCount: scan.codexConfig?.customAgents?.missingMcpEnvVarCount || 0,
    customAgentInstructionBytes: scan.codexConfig?.customAgents?.totalDeveloperInstructionBytes || 0,
    approvalAutoReview: Boolean(scan.codexConfig?.approvalFlow?.autoReviewApplies),
    approvalInteractive: scan.codexConfig?.approvalFlow?.interactiveApprovals !== false,
    approvalGranularPolicy: Boolean(scan.codexConfig?.approvalFlow?.granularPolicy),
    mcpEnabledCount: scan.codexConfig?.mcpSummary?.enabledCount || 0,
    mcpRequiredCount: scan.codexConfig?.mcpSummary?.requiredCount || 0,
    mcpMissingEnvVarCount: scan.codexConfig?.mcpSummary?.missingEnvVarCount || 0,
    mcpStdioCount: scan.codexConfig?.mcpSummary?.stdioCount || 0,
    mcpHttpCount: scan.codexConfig?.mcpSummary?.httpCount || 0,
    mcpLongStartupTimeoutCount: scan.codexConfig?.mcpSummary?.longStartupTimeoutCount || 0,
    shellEnvVarCount: scan.codexConfig?.shellEnvironmentSummary?.envVarCount || 0,
    shellEnvSecretLikeNameCount: scan.codexConfig?.shellEnvironmentSummary?.secretLikeNameCount || 0,
    shellEnvTightPolicy: Boolean(scan.codexConfig?.shellEnvironmentSummary?.tightPolicy),
    shellEnvMissingPath: scan.codexConfig?.shellEnvironmentSummary?.pathAvailable === false,
    contextWindow: scan.codexConfig?.contextBudgetSummary?.contextWindow || 0,
    autoCompactTokenLimit: scan.codexConfig?.contextBudgetSummary?.autoCompactTokenLimit || 0,
    toolOutputTokenLimit: scan.codexConfig?.contextBudgetSummary?.toolOutputTokenLimit || 0,
    responseShapeTone: responseShapeSummary.tone || "low",
    responseVerbosity: responseShapeSummary.verbosity || "default",
    responseReasoningSummary: responseShapeSummary.reasoningSummary || "default",
    responseHighVerbosity: Boolean(responseShapeSummary.highVerbosity),
    responseLowVerbosity: Boolean(responseShapeSummary.lowVerbosity),
    responseDetailedSummary: Boolean(responseShapeSummary.detailedSummary),
    responseNoSummary: Boolean(responseShapeSummary.noSummary),
    responseRawReasoning: Boolean(responseShapeSummary.rawReasoning),
    responseSummariesForced: Boolean(responseShapeSummary.summariesForced),
    responseConfiguredCount: responseShapeSummary.configuredCount || 0,
    compactTooLate: Boolean(scan.codexConfig?.contextBudgetSummary?.compactTooLate),
    compactEarly: Boolean(scan.codexConfig?.contextBudgetSummary?.compactEarly),
    smallContextWindow: Boolean(scan.codexConfig?.contextBudgetSummary?.smallWindow),
    instructionTotalBytes: scan.codexConfig?.instructionStack?.totalBytes || 0,
    instructionGlobalBytes: scan.codexConfig?.instructionStack?.globalBytes || 0,
    instructionProjectBytes: scan.codexConfig?.instructionStack?.projectBytes || 0,
    instructionProjectCandidateBytes: scan.codexConfig?.instructionStack?.projectCandidateBytes || 0,
    instructionSelectedFileCount: scan.codexConfig?.instructionStack?.selectedFileCount || 0,
    instructionEmptyFileCount: scan.codexConfig?.instructionStack?.emptyFileCount || 0,
    instructionOverrideFileCount: scan.codexConfig?.instructionStack?.overrideFileCount || 0,
    instructionLargeFileCount: scan.codexConfig?.instructionStack?.largeFileCount || 0,
    instructionProjectDocMaxBytes: scan.codexConfig?.instructionStack?.projectDocMaxBytes || defaultProjectDocMaxBytes,
    instructionProjectNearCap: Boolean(scan.codexConfig?.instructionStack?.projectNearCap),
    instructionProjectOverCap: Boolean(scan.codexConfig?.instructionStack?.projectOverCap),
    instructionOverrideConfiguredCount: scan.codexConfig?.instructionOverrides?.configuredCount || 0,
    instructionOverrideEffectiveCount: scan.codexConfig?.instructionOverrides?.effectiveCount || 0,
    instructionOverrideBytes: scan.codexConfig?.instructionOverrides?.instructionOverrideBytes || 0,
    compactOverrideBytes: scan.codexConfig?.instructionOverrides?.compactOverrideBytes || 0,
    developerInstructionChars: scan.codexConfig?.instructionOverrides?.developerInstructionChars || 0,
    compactPromptChars: scan.codexConfig?.instructionOverrides?.compactPromptChars || 0,
    modelInstructionFileBytes: scan.codexConfig?.instructionOverrides?.modelInstructionFileBytes || 0,
    compactPromptFileBytes: scan.codexConfig?.instructionOverrides?.compactPromptFileBytes || 0,
    instructionOverrideMissingFileCount: scan.codexConfig?.instructionOverrides?.missingFileCount || 0,
    developerInstructionsConfigured: Boolean(scan.codexConfig?.instructionOverrides?.developerInstructionsConfigured),
    modelInstructionsFileConfigured: Boolean(scan.codexConfig?.instructionOverrides?.modelInstructionsFileConfigured),
    compactPromptConfigured: Boolean(scan.codexConfig?.instructionOverrides?.compactPromptConfigured),
    compactPromptFileConfigured: Boolean(scan.codexConfig?.instructionOverrides?.compactPromptFileConfigured),
    customPromptCount: scan.codexConfig?.customPrompts?.promptCount || 0,
    customPromptBytes: scan.codexConfig?.customPrompts?.totalBytes || 0,
    customPromptMissingDescriptionCount: scan.codexConfig?.customPrompts?.missingDescriptionCount || 0,
    customPromptPlaceholderCount: scan.codexConfig?.customPrompts?.placeholderCount || 0,
    customPromptNestedMarkdownCount: scan.codexConfig?.customPrompts?.nestedMarkdownCount || 0,
    managedConfigPresent: Boolean(managedConfigSummary.active),
    managedConfigKeyCount: managedConfigSummary.managedKeyCount || 0,
    managedRequirementKeyCount: managedConfigSummary.requirementKeyCount || 0,
    managedSpeedKeyCount: managedConfigSummary.managedSpeedKeyCount || 0,
    managedRequirementSpeedKeyCount: managedConfigSummary.requirementSpeedKeyCount || 0,
    managedConfigConflictCount: managedConfigSummary.conflictCount || 0,
    managedDefaultConflictCount: managedConfigSummary.managedDefaultConflictCount || 0,
    managedRequirementConflictCount: managedConfigSummary.requirementConflictCount || 0,
    managedMcpCount: managedConfigSummary.managedMcpCount || 0,
    managedMcpBlockedCount: managedConfigSummary.managedMcpBlockedCount || 0,
    managedHookCount: managedConfigSummary.managedHookCount || 0,
    managedFeaturePinCount: managedConfigSummary.featurePinCount || 0,
    commandRulesFeature: commandRuleSummary.rulesFeature !== false,
    commandRuleSourceCount: commandRuleSummary.activeSourceCount || 0,
    commandRuleFileCount: commandRuleSummary.fileCount || 0,
    commandRuleCount: commandRuleSummary.ruleCount || 0,
    commandRulePromptCount: commandRuleSummary.promptCount || 0,
    commandRuleForbiddenCount: commandRuleSummary.forbiddenCount || 0,
    commandRuleAllowCount: commandRuleSummary.allowCount || 0,
    commandRuleBroadCount: commandRuleSummary.broadRuleCount || 0,
    commandRuleBroadPromptCount: commandRuleSummary.broadPromptRuleCount || 0,
    commandRuleMissingJustificationCount: commandRuleSummary.missingJustificationCount || 0,
    commandRuleTestedCount: commandRuleSummary.testedRuleCount || 0,
    commandRuleParseWarningCount: commandRuleSummary.parseWarningCount || 0,
    commandRuleLargeFileCount: commandRuleSummary.largeFileCount || 0,
    commandRuleBytes: commandRuleSummary.totalBytes || 0,
    networkSandboxLabel: networkSandbox.label || "Network off",
    networkSandboxTone: networkSandbox.tone || "low",
    networkSandboxMode: networkSandbox.sandboxMode || "workspace-write",
    networkCommandAccess: Boolean(networkSandbox.commandNetworkAccess),
    networkCommandConfigured: Boolean(networkSandbox.commandNetworkConfigured),
    networkProxyEnabled: Boolean(networkSandbox.networkProxyEnabled),
    networkProxyNoEffect: Boolean(networkSandbox.networkProxyNoEffect),
    networkUnrestrictedDirect: Boolean(networkSandbox.unrestrictedDirectNetwork),
    networkPermissionsEnabled: Boolean(networkSandbox.permissionsNetworkEnabled),
    networkDomainRuleCount: networkSandbox.domainRuleCount || 0,
    networkDomainAllowCount: networkSandbox.domainAllowCount || 0,
    networkDomainDenyCount: networkSandbox.domainDenyCount || 0,
    networkGlobalAllow: Boolean(networkSandbox.globalAllow),
    networkLocalBindingAllowed: Boolean(networkSandbox.localBindingAllowed),
    networkDangerousSettingCount: networkSandbox.dangerousNetworkSettingCount || 0,
    networkWritableRootCount: networkSandbox.writableRootCount || 0,
    networkTmpdirExcluded: Boolean(networkSandbox.tmpdirExcluded),
    networkSlashTmpExcluded: Boolean(networkSandbox.slashTmpExcluded),
    webSearchMode: webSearchEffectiveMode,
    webSearchConfigured: Boolean(scan.codexConfig?.webSearchConfigured),
    webSearchLive: webSearchEffectiveMode === "live",
    webSearchDisabled: webSearchEffectiveMode === "disabled",
    webSearchLegacyKeyCount: scan.codexConfig?.webSearchLegacyKeyCount || 0,
    projectHasPackageJson: Boolean(currentProject?.hasPackageJson),
    projectHasUsefulScripts: Boolean(
      currentProject?.hasPackageJson &&
        (currentProject.hasDevScript ||
          currentProject.hasBuildScript ||
          currentProject.hasTestScript ||
          Object.values(currentProject.scripts || {}).some(scriptLooksUseful)),
    ),
    localEnvironmentConfigCount: localEnvironment.configFileCount || 0,
    localEnvironmentCandidateFileCount: localEnvironment.candidateFileCount || 0,
    localEnvironmentSetupCount: localEnvironment.setupScriptCount || 0,
    localEnvironmentActionCount: localEnvironment.actionCount || 0,
    localEnvironmentPlatformSpecificCount: localEnvironment.platformSpecificCount || 0,
    localEnvironmentParseWarningCount: localEnvironment.parseWarningCount || 0,
    localEnvironmentHasSetupScript: Boolean(localEnvironment.hasSetupScript),
    localEnvironmentHasActions: Boolean(localEnvironment.hasActions),
    hooksFeature: scan.codexConfig?.hookSummary?.hooksFeature !== false,
    hookCommandCount: scan.codexConfig?.hookSummary?.commandCount || 0,
    hookTurnScopedCommandCount: scan.codexConfig?.hookSummary?.turnScopedCommandCount || 0,
    hookBroadMatcherCount: scan.codexConfig?.hookSummary?.broadMatcherCount || 0,
    memoryBytes: scan.categories.memoryState?.bytes || 0,
    memoryFiles: scan.categories.memoryState?.fileCount || 0,
    memoriesUseMemories: Boolean(scan.codexConfig?.memoriesUseMemoriesEffective),
    memoriesGenerateMemories: Boolean(scan.codexConfig?.memoriesGenerateMemoriesEffective),
    skillCount: scan.skillCatalog?.skillCount || 0,
    skillUserManagedCount: scan.skillCatalog?.userManagedCount || 0,
    skillSystemCount: scan.skillCatalog?.systemSkillCount || 0,
    skillPluginCount: scan.skillCatalog?.pluginSkillCount || 0,
    skillUserCount: scan.skillCatalog?.userSkillCount || 0,
    skillRepoCount: scan.skillCatalog?.repoSkillCount || 0,
    skillEstimatedCatalogChars: scan.skillCatalog?.estimatedCatalogChars || 0,
    skillDescriptionChars: scan.skillCatalog?.descriptionChars || 0,
    skillLongDescriptionCount: scan.skillCatalog?.longDescriptionCount || 0,
    skillLargeFileCount: scan.skillCatalog?.largeSkillFileCount || 0,
    skillCatalogOverBudget: Boolean(scan.skillCatalog?.overBudget),
    skillCatalogTruncated: Boolean(scan.skillCatalog?.truncated),
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
