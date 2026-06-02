const $ = (selector) => document.querySelector(selector);

const elements = {
  refreshScan: $("#refreshScan"),
  lastScan: $("#lastScan"),
  totalCodexState: $("#totalCodexState"),
  totalCodexHint: $("#totalCodexHint"),
  activeSessionSize: $("#activeSessionSize"),
  activeSessionHint: $("#activeSessionHint"),
  logDbSize: $("#logDbSize"),
  logDbHint: $("#logDbHint"),
  likelyReclaim: $("#likelyReclaim"),
  likelyReclaimHint: $("#likelyReclaimHint"),
  targetList: $("#targetList"),
  largestFiles: $("#largestFiles"),
  operationLog: $("#operationLog"),
  safeSweep: $("#safeSweep"),
  optimizePolicies: [...document.querySelectorAll('input[name="optimizePolicy"]')],
  archiveDeleteControl: $("#archiveDeleteControl"),
  archiveDeleteDays: $("#archiveDeleteDays"),
  clearLog: $("#clearLog"),
  staleThreadHint: $("#staleThreadHint"),
  migrateHint: $("#migrateHint"),
  logHint: $("#logHint"),
  crashHint: $("#crashHint"),
  maintenanceHint: $("#maintenanceHint"),
  imageHint: $("#imageHint"),
  boostRing: $("#boostRing"),
  boostRingValue: $("#boostRingValue"),
  boostRingLabel: $("#boostRingLabel"),
  smartPlanSummary: $("#smartPlanSummary"),
  smartPlan: $("#smartPlan"),
  smartDecisionMode: $("#smartDecisionMode"),
  smartDecisionHeadline: $("#smartDecisionHeadline"),
  smartDecisionReason: $("#smartDecisionReason"),
  smartDiagnosis: $("#smartDiagnosis"),
  diagnosisCause: $("#diagnosisCause"),
  diagnosisConfidence: $("#diagnosisConfidence"),
  diagnosisAction: $("#diagnosisAction"),
  preflightStatus: $("#preflightStatus"),
  preflightLabel: $("#preflightLabel"),
  smartImpact: $("#smartImpact"),
  smartDeleteArmControl: $("#smartDeleteArmControl"),
  smartDeleteArm: $("#smartDeleteArm"),
  smartDeleteArmLabel: $("#smartDeleteArmLabel"),
  smartDeleteArmMeta: $("#smartDeleteArmMeta"),
  smartMoveHint: $("#smartMoveHint"),
  doctorSource: $("#doctorSource"),
  doctorHeadline: $("#doctorHeadline"),
  doctorQueue: $("#doctorQueue"),
  doctorList: $("#doctorList"),
  doctorProfiles: $("#doctorProfiles"),
  doctorConfig: $("#doctorConfig"),
  doctorWorkflow: $("#doctorWorkflow"),
  doctorFixKit: $("#doctorFixKit"),
  runOfficialDoctor: $("#runOfficialDoctor"),
  officialDoctor: $("#officialDoctor"),
  refitOutcome: $("#refitOutcome"),
  refitOutcomeTitle: $("#refitOutcomeTitle"),
  refitOutcomeActive: $("#refitOutcomeActive"),
  refitOutcomeLogs: $("#refitOutcomeLogs"),
  refitOutcomeThreads: $("#refitOutcomeThreads"),
  refitOutcomeScore: $("#refitOutcomeScore"),
  refreshRecovery: $("#refreshRecovery"),
  recoveryBackupCount: $("#recoveryBackupCount"),
  recoveryBackupSize: $("#recoveryBackupSize"),
  recoveryLatestBackup: $("#recoveryLatestBackup"),
  recoveryBackupList: $("#recoveryBackupList"),
  recoveryHistoryList: $("#recoveryHistoryList"),
  runBenchmark: $("#runBenchmark"),
  benchmarkScore: $("#benchmarkScore"),
  benchmarkRating: $("#benchmarkRating"),
  benchmarkMeaning: $("#benchmarkMeaning"),
  benchmarkGuidance: $("#benchmarkGuidance"),
  benchmarkProof: $("#benchmarkProof"),
  benchmarkHistory: $("#benchmarkHistory"),
  benchmarkBreakdown: $("#benchmarkBreakdown"),
  benchmarkScan: $("#benchmarkScan"),
  benchmarkState: $("#benchmarkState"),
  benchmarkDelta: $("#benchmarkDelta"),
  destructiveArm: $("#destructiveArm"),
  destructiveArmLabel: $("#destructiveArmLabel"),
  advancedMode: $("#advancedMode"),
  modeSwitch: $("#modeSwitch"),
  easyModeButton: $("#easyModeButton"),
  hardModeButton: $("#hardModeButton"),
  advancedDeck: $("#advancedDeck"),
  modeStatus: $("#modeStatus"),
};

let currentScan = null;
let lastRefitOutcome = null;
let busy = false;
const smartOptimizeLogDays = 7;

function isDeleteArmed() {
  return Boolean(elements.destructiveArm?.checked || elements.smartDeleteArm?.checked);
}

function deletePlanMeta(plan) {
  const decision = plan?.decision;
  const count = Number(decision?.destructiveSteps || 0);
  const bytes = Number(decision?.deletePreviewBytes || 0);
  if (!count) return "No deletes selected";
  const size = bytes > 0 ? `${formatBytes(bytes)} ` : "";
  return `${size}${count} delete action${count === 1 ? "" : "s"} locked`;
}

function renderDeleteArmState(plan = currentScan?.smartPlan) {
  const isArmed = isDeleteArmed();
  document.body.toggleAttribute("data-delete-armed", isArmed);
  if (elements.destructiveArmLabel) elements.destructiveArmLabel.textContent = isArmed ? "Deletes On" : "Deletes Off";
  if (elements.smartDeleteArmLabel) elements.smartDeleteArmLabel.textContent = isArmed ? "Allow Deletes" : "Keep Archived";
  if (elements.smartDeleteArmMeta) {
    elements.smartDeleteArmMeta.textContent = isArmed ? "Deletes are on" : deletePlanMeta(plan);
  }
  if (elements.smartDeleteArmControl) {
    const labels = plan?.decision?.destructiveStepLabels || [];
    elements.smartDeleteArmControl.title = labels.length
      ? `These stay locked until you allow deletes: ${labels.join(", ")}`
      : "No delete actions are selected.";
  }
}

function setDeleteArmed(nextArmed, { log = false } = {}) {
  [elements.destructiveArm, elements.smartDeleteArm].filter(Boolean).forEach((input) => {
    input.checked = nextArmed;
  });
  renderDeleteArmState();
  if (currentScan?.smartPlan) renderSmartDecision(currentScan.smartPlan);
  if (log) {
    logOperation(
      nextArmed ? "Deletes armed" : "Deletes locked",
      nextArmed
        ? "Delete actions are allowed for this session."
        : "Delete actions are locked again.",
      nextArmed ? "success" : "info",
    );
  }
}

function renderMode() {
  if (!elements.advancedMode || !elements.advancedDeck || !elements.modeStatus) return;
  const isHardMode = elements.advancedMode.checked;
  document.body.toggleAttribute("data-hard-mode", isHardMode);
  elements.advancedDeck.hidden = !isHardMode;
  elements.modeStatus.textContent = isHardMode ? "Hard Mode" : "Easy Mode";
  elements.easyModeButton?.setAttribute("aria-pressed", String(!isHardMode));
  elements.hardModeButton?.setAttribute("aria-pressed", String(isHardMode));
}

function setHardMode(nextMode) {
  if (!elements.advancedMode || elements.advancedMode.checked === nextMode) return;
  elements.advancedMode.checked = nextMode;
  elements.advancedMode.dispatchEvent(new Event("change", { bubbles: true }));
}

function getPolicy() {
  return elements.optimizePolicies.find((input) => input.checked)?.value || "safe";
}

function renderPolicyState() {
  const policy = getPolicy();
  document.body.dataset.optimizePolicy = policy;
  const isSafe = policy === "safe";
  if (elements.archiveDeleteControl && elements.archiveDeleteDays) {
    elements.archiveDeleteControl.toggleAttribute("aria-disabled", isSafe);
    elements.archiveDeleteDays.disabled = isSafe;
  }
  if (elements.smartDeleteArmControl) {
    elements.smartDeleteArmControl.hidden = isSafe;
  }
}

function smartMoveCountForPlan(plan) {
  const decision = plan?.decision;
  if (decision) {
    return Number(decision.nonDestructiveSteps || 0) + (isDeleteArmed() ? Number(decision.destructiveSteps || 0) : 0);
  }
  return plan?.steps?.filter((step) => step.id !== "speedCheck" && !step.disabled && (!step.confirmRequired || isDeleteArmed())).length || 0;
}

function renderBoost(plan, { safeReclaim = 0, totalState = 0 } = {}) {
  const smartMoveCount = smartMoveCountForPlan(plan);
  const boostRatio = totalState > 0 ? Math.min(99, Math.round((safeReclaim / totalState) * 100)) : 0;
  const ringDegrees = smartMoveCount ? Math.min(360, Math.max(72, smartMoveCount * 84)) : boostRatio * 3.6;
  elements.boostRing?.style.setProperty("--boost", `${ringDegrees}deg`);
  if (elements.boostRingValue) elements.boostRingValue.textContent = smartMoveCount ? `${smartMoveCount}` : `${boostRatio}%`;
  if (elements.boostRingLabel) elements.boostRingLabel.textContent = smartMoveCount ? "moves" : "ready";
  if (elements.safeSweep) {
    elements.safeSweep.textContent = smartMoveCount > 0 ? `Run ${smartMoveCount} Step${smartMoveCount === 1 ? "" : "s"}` : "Smart Optimize";
  }
  renderSmartMoveHint(plan);
}

function shortMoveLabel(step, plan = null) {
  if (step.id === "archiveStaleThreads") return `Archive ${plan?.archiveChoice?.days || plan?.days || ""}d`.trim();
  return (
    {
      migrateArchivedSessions: "Move archived",
      pruneLogs: "Prune logs",
      vacuumState: "Compact DB",
      deleteArchivedTranscripts: "Delete old archived",
      deleteMaintenanceArchives: "Delete old backups",
      archiveGeneratedImages: "Move images",
      deleteCrashDumps: "Clear crashes",
      cleanBrowserCaches: "Clean caches",
    }[step.id] || step.label
  );
}

function renderSmartMoveHint(plan) {
  if (!elements.smartMoveHint) return;
  const steps = plan?.steps?.filter((step) => step.id !== "speedCheck" && !step.disabled) || [];
  const runnable = steps.filter((step) => !step.confirmRequired || isDeleteArmed());
  const locked = steps.filter((step) => step.confirmRequired && !isDeleteArmed());
  const nowLabels = runnable.slice(0, 4).map((step) => shortMoveLabel(step, plan));
  const lockedCount = locked.length;
  const lockedBytes = Number(plan?.decision?.deletePreviewBytes || 0);
  const lockedText = lockedCount
    ? `Deletes locked: ${lockedBytes > 0 ? `${formatBytes(lockedBytes)} ` : ""}${lockedCount} action${lockedCount === 1 ? "" : "s"}`
    : "Deletes locked: none";
  elements.smartMoveHint.textContent = nowLabels.length ? `Ready: ${nowLabels.join(" / ")}. ${lockedText}` : lockedText;
  elements.smartMoveHint.title = [
    runnable.length ? `Ready now: ${runnable.map((step) => step.label).join(", ")}` : "No steps are ready right now.",
    locked.length ? `Locked until you allow deletes: ${locked.map((step) => step.label).join(", ")}` : "No delete actions are locked.",
  ].join(" ");
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${value >= 10 || exponent === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[exponent]}`;
}

function formatCount(value, noun) {
  const count = Number(value || 0);
  return `${count.toLocaleString()} ${noun}${count === 1 ? "" : "s"}`;
}

function formatDate(value) {
  if (!value) return "--";
  return new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatMs(ms) {
  if (!Number.isFinite(ms)) return "--";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

function formatSigned(value, suffix = "") {
  if (!Number.isFinite(value)) return "--";
  const rounded = Math.round(value);
  const sign = rounded > 0 ? "+" : "";
  return `${sign}${rounded}${suffix}`;
}

function formatByteDelta(delta) {
  if (!Number.isFinite(delta) || delta === 0) return "0 B";
  const sign = delta > 0 ? "+" : "-";
  return `${sign}${formatBytes(Math.abs(delta))}`;
}

function policyLabel(value) {
  return (
    {
      auto: "Auto",
      safe: "Safe",
      reclaim: "Recover Space",
      max: "Full Pass",
    }[value] || "Safe"
  );
}

function shortActionLabel(value, diagnosis = null) {
  const base = String(value || "Run Speed Check")
    .replace("Archive stale active threads", "Archive stale")
    .replace("Archive stale threads", "Archive stale")
    .replace("Move archived transcripts", "Move archived")
    .replace("Move old generated images", "Move images")
    .replace("Prune and compact logs", "Prune logs")
    .replace("Compact state database", "Compact DB")
    .replace("Optimize state database", "Compact DB")
    .replace("Delete old archived history", "Delete old archived")
    .replace("Delete archived history", "Delete old archived")
    .replace("Delete old Refit backups", "Delete old backups")
    .replace("Delete maintenance archives", "Delete old backups")
    .replace("Clean rebuildable caches", "Clean caches")
    .replace("Clear crash reports", "Clear crashes");
  return diagnosis?.archiveDays && /Archive stale/i.test(base) ? `${base} ${diagnosis.archiveDays}d` : base;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) =>
    ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[char],
  );
}

function setBusy(nextBusy, label = "Working") {
  busy = nextBusy;
  document.body.toggleAttribute("data-busy", busy);
  document.querySelectorAll("button").forEach((button) => {
    button.disabled = busy;
  });
  if (busy) {
    elements.lastScan.textContent = label;
  } else if (currentScan?.generatedAt) {
    elements.lastScan.textContent = `Scanned ${formatDate(currentScan.generatedAt)}`;
  }
}

function logOperation(title, detail, tone = "info") {
  const item = document.createElement("article");
  item.className = `log-item ${tone}`;
  item.innerHTML = `
    <span>${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}</span>
    <strong>${title}</strong>
    <p>${detail}</p>
  `;
  elements.operationLog.prepend(item);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || `Request failed: ${response.status}`);
  }
  return payload;
}

function renderTarget(target) {
  const status = target.exists ? `${formatBytes(target.bytes)} / ${formatCount(target.fileCount, "file")}` : "Missing";
  const risk = target.risk || "scan";
  const hot = target.hotspots?.length
    ? `<ul>${target.hotspots.map((hotspot) => `<li>${hotspot}</li>`).join("")}</ul>`
    : "<ul><li>No major hotspot in this bucket.</li></ul>";

  return `
    <article class="target-card ${risk}">
      <div>
        <span>${target.label}</span>
        <strong>${status}</strong>
        <small>${target.path}</small>
      </div>
      ${hot}
    </article>
  `;
}

function renderLargestFiles(files) {
  if (!files?.length) {
    elements.largestFiles.innerHTML = `<tr><td colspan="4">No large session files found.</td></tr>`;
    return;
  }

  elements.largestFiles.innerHTML = files
    .map(
      (file) => `
        <tr>
          <td><code>${file.name}</code></td>
          <td>${formatBytes(file.bytes)}</td>
          <td>${formatDate(file.mtime)}</td>
          <td>${file.bucket}</td>
        </tr>
      `,
    )
    .join("");
}

function renderCodexDoctor(doctor) {
  if (!doctor || !elements.doctorList) return;
  if (elements.doctorSource) elements.doctorSource.textContent = doctor.docsSource || "Codex settings and local state";
  if (elements.doctorHeadline) elements.doctorHeadline.textContent = doctor.headline || "Codex Doctor is checking the biggest speed levers.";
  if (elements.doctorQueue) {
    const recommendations = doctor.recommendations || [];
    elements.doctorQueue.innerHTML = recommendations.length
      ? recommendations
          .slice(0, 3)
          .map(
            (item) => `
              <article class="${escapeHtml(item.tone || "low")}" title="${escapeHtml(item.detail || "")}">
                <span>${escapeHtml(item.label || "Next Move")}</span>
                <strong>${escapeHtml(item.value || "--")}</strong>
                <small>${escapeHtml(item.action || item.detail || "")}</small>
              </article>
            `,
          )
          .join("")
      : `<article><span>Next Move</span><strong>Waiting</strong><small>Run a scan to rank speed wins.</small></article>`;
  }
  const cards = doctor.cards || [];
  elements.doctorList.innerHTML = cards.length
    ? cards
        .slice(0, 4)
        .map(
          (card) => `
            <article class="${escapeHtml(card.tone || "low")}" title="${escapeHtml(card.detail || "")}">
              <span>${escapeHtml(card.label || "Check")}</span>
              <strong>${escapeHtml(card.value || "--")}</strong>
              <small>${escapeHtml(card.next || card.detail || "")}</small>
            </article>
          `,
        )
        .join("")
    : `<article><span>Codex Doctor</span><strong>Waiting</strong><small>Run a scan to see what needs attention.</small></article>`;
  if (elements.doctorProfiles) {
    const profiles = doctor.profiles || [];
    elements.doctorProfiles.innerHTML = profiles.length
      ? profiles
          .slice(0, 3)
          .map(
            (profile) => `
              <article class="${escapeHtml(profile.tone || "low")}" title="${escapeHtml(profile.detail || "")}">
                <span>${escapeHtml(profile.label || "Profile")}</span>
                <strong>${escapeHtml(profile.value || "--")}</strong>
                <small>${escapeHtml(profile.action || profile.detail || "")}</small>
              </article>
            `,
          )
          .join("")
      : `<article><span>Speed Profile</span><strong>Waiting</strong><small>Run a scan to match settings to task size.</small></article>`;
  }
  if (elements.doctorConfig) {
    const advice = doctor.configAdvice || [];
    elements.doctorConfig.innerHTML = advice.length
      ? advice
          .slice(0, 4)
          .map(
            (item) => `
              <article class="${escapeHtml(item.tone || "low")}" title="${escapeHtml(item.detail || "")}">
                <span>${escapeHtml(item.label || "Config")}</span>
                <strong>${escapeHtml(item.value || "--")}</strong>
                <small>${escapeHtml(item.action || item.detail || "")}</small>
              </article>
            `,
          )
          .join("")
      : `<article><span>Config</span><strong>Waiting</strong><small>Run a scan to check durable speed settings.</small></article>`;
  }
  if (elements.doctorWorkflow) {
    const advice = doctor.workflowAdvice || [];
    elements.doctorWorkflow.innerHTML = advice.length
      ? advice
          .slice(0, 4)
          .map(
            (item) => `
              <article class="${escapeHtml(item.tone || "low")}" title="${escapeHtml(item.detail || "")}">
                <span>${escapeHtml(item.label || "Workflow")}</span>
                <strong>${escapeHtml(item.value || "--")}</strong>
                <small>${escapeHtml(item.action || item.detail || "")}</small>
              </article>
            `,
          )
          .join("")
      : `<article><span>Workflow</span><strong>Waiting</strong><small>Run a scan to check concurrency and tool surface.</small></article>`;
  }
  if (elements.doctorFixKit) {
    const fixes = doctor.fixKit || [];
    elements.doctorFixKit.innerHTML = fixes.length
      ? fixes
          .slice(0, 4)
          .map((fix) => {
            const snippet = fix.snippet ? escapeHtml(fix.snippet) : "";
            const copyValue = fix.snippet ? encodeURIComponent(fix.snippet) : "";
            const copyButton = fix.snippet
              ? `<button class="copy-fix" type="button" data-copy="${copyValue}">Copy</button>`
              : "";
            return `
              <article class="${escapeHtml(fix.tone || "low")}" title="${escapeHtml(fix.detail || "")}">
                <div>
                  <span>${escapeHtml(fix.label || "Fix")}</span>
                  <strong>${escapeHtml(fix.value || "--")}</strong>
                  <small>${escapeHtml(fix.action || fix.detail || "")}</small>
                </div>
                ${snippet ? `<pre><code>${snippet}</code></pre>` : ""}
                ${!snippet && fix.detail ? `<p>${escapeHtml(fix.detail)}</p>` : ""}
                ${copyButton}
              </article>
            `;
          })
          .join("")
      : `<article><span>Fix Kit</span><strong>Waiting</strong><small>Run a scan to build next steps.</small></article>`;
  }
}

function renderOfficialDoctor(report) {
  if (!elements.officialDoctor) return;
  elements.officialDoctor.hidden = false;
  const counts = report.counts || {};
  const findings = report.findings || [];
  const fixes = report.fixes || [];
  const issueCount = findings.length;
  const countLine = `${counts.ok || 0} ok / ${counts.warning || 0} warn / ${counts.fail || 0} fail`;
  elements.officialDoctor.innerHTML = `
    <article class="${escapeHtml(report.tone || "low")}">
      <span>Official Doctor</span>
      <strong>${escapeHtml(report.status || "unknown")}</strong>
      <small>${escapeHtml(report.codexVersion ? `Codex ${report.codexVersion} • ${countLine}` : countLine)}</small>
    </article>
    <article>
      <span>Last Run</span>
      <strong>${escapeHtml(formatDate(report.generatedAt))}</strong>
      <small>${escapeHtml(`${Math.round(Number(report.durationMs || 0) / 1000)}s • ${report.command || "codex doctor --json"}`)}</small>
    </article>
    ${
      issueCount
        ? findings
            .slice(0, 4)
            .map(
              (finding) => `
                <article class="${escapeHtml(finding.tone || "medium")}" title="${escapeHtml(finding.remediation || "")}">
                  <span>${escapeHtml(finding.label || finding.category || "Finding")}</span>
                  <strong>${escapeHtml(finding.value || finding.status || "--")}</strong>
                  <small>${escapeHtml(finding.summary || finding.remediation || "Codex Doctor found something to inspect.")}</small>
                </article>
              `,
            )
            .join("")
        : `<article class="low"><span>Findings</span><strong>Clear</strong><small>${escapeHtml(report.headline || "No official Doctor findings need attention.")}</small></article>`
    }
    ${
      fixes.length
        ? fixes
            .slice(0, 3)
            .map((fix) => {
              const snippet = fix.snippet ? escapeHtml(fix.snippet) : "";
              const copyValue = fix.snippet ? encodeURIComponent(fix.snippet) : "";
              return `
                <article class="official-fix ${escapeHtml(fix.tone || "medium")}" title="${escapeHtml(fix.detail || "")}">
                  <div>
                    <span>${escapeHtml(fix.label || "Fix")}</span>
                    <strong>${escapeHtml(fix.value || "--")}</strong>
                    <small>${escapeHtml(fix.action || fix.detail || "")}</small>
                  </div>
                  ${snippet ? `<pre><code>${snippet}</code></pre>` : ""}
                  ${copyValue ? `<button class="copy-fix" type="button" data-copy="${copyValue}">Copy</button>` : ""}
                </article>
              `;
            })
            .join("")
        : ""
    }
  `;
}

function renderScan(scan) {
  currentScan = scan;
  const totalState =
    (scan.categories.codexHome?.bytes || 0) +
    (scan.categories.codexChromium?.bytes || 0) +
    (scan.categories.codexDesktop?.bytes || 0);

  const safeReclaim =
    (scan.categories.activeStaleSessions?.bytes || 0) +
    (scan.categories.crashDumps?.bytes || 0) +
    (scan.categories.browserCaches?.bytes || 0) +
    (scan.categories.archivedSessionsInActiveTree?.bytes || 0);

  elements.lastScan.textContent = `Scanned ${formatDate(scan.generatedAt)}`;
  elements.totalCodexState.textContent = formatBytes(totalState);
  elements.totalCodexHint.textContent = `${formatCount(scan.state?.threads?.total, "thread")} tracked`;
  elements.activeSessionSize.textContent = formatBytes(scan.categories.activeSessions?.bytes);
  elements.activeSessionHint.textContent = `${formatCount(scan.categories.activeSessions?.oversized50mb, "file")} over 50 MB`;
  elements.logDbSize.textContent = formatBytes(scan.logs?.bytes);
  elements.logDbHint.textContent = scan.logs?.walBytes
    ? `${formatBytes(scan.logs.walBytes)} waiting in WAL`
    : "WAL is quiet";
  elements.likelyReclaim.textContent = formatBytes(safeReclaim);
  elements.likelyReclaimHint.textContent = "Move, compact, or clear safely";

  renderBoost(scan.smartPlan, { safeReclaim, totalState });
  renderSmartPlan(scan.smartPlan);
  renderPreflight(scan.preflight);
  renderCodexDoctor(scan.codexDoctor);

  const staleDays = scan.state?.threads?.staleCutoffDays || scan.smartPlan?.days || 5;
  const staleThreads = scan.state?.threads?.activeStale ?? scan.state?.threads?.activeOlder7d;
  elements.staleThreadHint.textContent = `${formatCount(staleThreads, "thread")} active older than ${staleDays} days`;
  const archivedFiles = scan.categories.archivedSessionsInActiveTree?.fileCount || 0;
  const stalePointers = scan.categories.archivedSessionsInActiveTree?.missingFileCount || 0;
  elements.migrateHint.textContent = archivedFiles
    ? `${formatCount(archivedFiles, "archived transcript")} can move out of active sessions`
    : `${formatCount(stalePointers, "stale archived pointer")} with no file to move`;
  elements.crashHint.textContent = `${formatCount(scan.categories.crashDumps?.fileCount, "dump")} / ${formatBytes(scan.categories.crashDumps?.bytes)}`;
  elements.maintenanceHint.textContent = `${formatBytes(scan.categories.maintenanceArchive?.bytes)} in old backup bundles`;
  elements.imageHint.textContent = `${formatBytes(scan.categories.generatedImages?.bytes)} kept on disk; old items move, never delete`;

  elements.targetList.innerHTML = [
    scan.categories.activeSessions,
    scan.categories.sessionMedia,
    scan.categories.taskClarity,
    scan.categories.turnTelemetry,
    scan.categories.activeStaleSessions,
    scan.categories.archivedSessionsInActiveTree,
    scan.categories.archivedSessions,
    scan.categories.archivedDeleteCandidates,
    scan.categories.maintenanceArchive,
    scan.categories.generatedImages,
    scan.categories.generatedImagesArchive,
    scan.categories.codexWorktrees,
    scan.categories.memoryState,
    scan.categories.logs,
    scan.categories.crashDumps,
    scan.categories.browserCaches,
    scan.categories.codexChromium,
  ]
    .filter(Boolean)
    .map(renderTarget)
    .join("");

  renderLargestFiles(scan.largestSessionFiles);
}

function renderPreflight(preflight) {
  if (!elements.preflightStatus || !elements.preflightLabel) return;
  const status = preflight?.status || "unknown";
  elements.preflightStatus.dataset.status = status;
  elements.preflightStatus.title = preflight?.detail || "Run safety could not be checked.";
  elements.preflightLabel.textContent = preflight?.label || "Unknown";
}

function renderBenchmark(benchmark) {
  if (!benchmark?.metrics) return;
  const { metrics } = benchmark;
  elements.benchmarkScore.textContent = `${metrics.score}`;
  elements.benchmarkScore.title = Number.isFinite(metrics.liveScore)
    ? `Local score ${metrics.score}; live timing score ${metrics.liveScore}`
    : "Stable local-state score";
  elements.benchmarkRating.textContent = benchmark.rating || "Measured";
  if (elements.benchmarkMeaning) {
    elements.benchmarkMeaning.textContent = benchmark.meaning || "Speed check complete.";
  }
  elements.benchmarkScan.textContent = formatMs(metrics.scanMs);
  elements.benchmarkState.textContent = formatMs(metrics.stateQueryMs);
  elements.benchmarkDelta.textContent = benchmark.deltas
    ? `Score ${formatSigned(benchmark.deltas.score)}`
    : "Baseline";
  elements.benchmarkDelta.title =
    Number.isFinite(metrics.liveScore) && metrics.liveScore !== metrics.score
      ? `Live timing score: ${metrics.liveScore} (${benchmark.liveRating || "measured"})`
      : "Stable local-state score delta";
  if (elements.benchmarkGuidance) {
    const guidance = benchmark.guidance?.length ? benchmark.guidance : ["No major slowdown signal found."];
    elements.benchmarkGuidance.innerHTML = guidance
      .slice(0, 3)
      .map((item) => `<span>${escapeHtml(item)}</span>`)
      .join("");
  }
  renderScoreBreakdown(metrics.scoreBreakdown);
  if (benchmark.history) renderBenchmarkHistory(benchmark.history);
}

function renderScoreBreakdown(scoreBreakdown) {
  if (!elements.benchmarkBreakdown) return;
  const components = scoreBreakdown?.components || [];
  elements.benchmarkBreakdown.innerHTML = components.length
    ? components
        .slice(0, 4)
        .map(
          (component) => `
            <article title="${escapeHtml(component.detail || "")}">
              <strong>-${escapeHtml(String(component.points))}</strong>
              <span>${escapeHtml(component.label || "Driver")}</span>
              <small>${escapeHtml(component.value || "")}</small>
            </article>
          `,
        )
        .join("")
    : `<span>Run a check to see score drivers.</span>`;
}

function renderBenchmarkHistory(history) {
  if (!elements.benchmarkProof && !elements.benchmarkHistory) return;
  const latest = history?.latest;
  const best = history?.best;
  const deltas = history?.deltas;
  const previousDeltas = history?.previousDeltas;
  if (elements.benchmarkProof) {
    if (!latest) {
      elements.benchmarkProof.innerHTML = `<span>No saved checks yet.</span>`;
    } else if (!deltas) {
      elements.benchmarkProof.innerHTML = `
        <span>Baseline ${escapeHtml(String(latest.score))}/100</span>
        <span>Best ${escapeHtml(String(best?.score ?? latest.score))}/100</span>
        <span>${escapeHtml(formatDate(latest.generatedAt))}</span>
      `;
    } else {
      elements.benchmarkProof.innerHTML = `
        <span>Trend ${escapeHtml(formatSigned(deltas.score))}</span>
        <span>Best ${escapeHtml(String(best?.score ?? latest.score))}/100</span>
        <span>Proc ${escapeHtml(formatSigned(deltas.processCount || 0))}</span>
        <span>Active ${escapeHtml(formatByteDelta(deltas.activeSessionBytes || 0))}</span>
      `;
    }
    elements.benchmarkProof.title = history?.summary || "Speed proof is based on saved local benchmark checks.";
  }
  if (elements.benchmarkHistory) {
    const entries = history?.entries || [];
    elements.benchmarkHistory.innerHTML = entries.length
      ? entries
          .slice(0, 4)
          .map(
            (entry, index) => `
              <article title="${escapeHtml(formatDate(entry.generatedAt))}">
                <strong>${escapeHtml(String(entry.score))}</strong>
                <span>${escapeHtml(index === 0 && previousDeltas ? formatSigned(previousDeltas.score) : entry.rating || "Check")}</span>
                <small>${escapeHtml(formatMs(entry.scanMs))} scan / ${escapeHtml(formatMs(entry.stateQueryMs))} state</small>
              </article>
            `,
          )
          .join("")
      : `<span>No saved speed checks yet.</span>`;
  }
  if (latest?.scoreBreakdown) renderScoreBreakdown(latest.scoreBreakdown);
}

function renderRefitOutcome(outcome, benchmark = null) {
  if (!outcome || !elements.refitOutcome) return;
  lastRefitOutcome = outcome;
  elements.refitOutcome.hidden = false;
  elements.refitOutcomeTitle.textContent = outcome.headline || "Refit complete";
  elements.refitOutcomeActive.textContent = formatByteDelta(outcome.deltas?.activeSessionBytes || 0);
  const logDelta = (outcome.deltas?.logBytes || 0) + (outcome.deltas?.logWalBytes || 0);
  elements.refitOutcomeLogs.textContent = formatByteDelta(logDelta);
  const threadDelta = outcome.deltas?.activeStaleThreads || 0;
  elements.refitOutcomeThreads.textContent =
    threadDelta === 0 ? "0" : `${threadDelta > 0 ? "+" : ""}${threadDelta.toLocaleString()}`;
  if (benchmark?.metrics) {
    const scoreDelta = benchmark.deltas ? formatSigned(benchmark.deltas.score) : "Baseline";
    elements.refitOutcomeScore.textContent = `${benchmark.metrics.score} (${scoreDelta})`;
  } else {
    elements.refitOutcomeScore.textContent = "Checking...";
  }
}

function renderRecovery(recovery) {
  if (!recovery || !elements.recoveryBackupList) return;
  elements.recoveryBackupCount.textContent = formatCount(recovery.backupCount || 0, "bundle");
  elements.recoveryBackupSize.textContent = formatBytes(recovery.backupBytes || 0);
  elements.recoveryLatestBackup.textContent = recovery.latestBackup ? formatDate(recovery.latestBackup.modifiedAt) : "No backups";

  const backups = recovery.backups || [];
  elements.recoveryBackupList.innerHTML = backups.length
    ? backups
        .slice(0, 4)
        .map(
          (backup) => `
            <article title="${escapeHtml(backup.path)}">
              <strong>${escapeHtml(backup.kind)} / ${escapeHtml(formatBytes(backup.bytes))}</strong>
              <small>${escapeHtml(backup.name)}</small>
              <small>${escapeHtml(formatDate(backup.modifiedAt))} / ${formatCount(backup.fileCount, "file")}</small>
            </article>
          `,
        )
        .join("")
    : `<span>No backup bundles found.</span>`;

  const history = recovery.history || [];
  elements.recoveryHistoryList.innerHTML = history.length
    ? history
        .slice(0, 4)
        .map(
          (entry) => `
            <article title="${escapeHtml(entry.summary || "")}">
              <strong>${escapeHtml(entry.action || "Action")}</strong>
              <small>${escapeHtml(formatDate(entry.at))}</small>
              <small>${escapeHtml(entry.summary || "No summary recorded.")}</small>
            </article>
          `,
        )
        .join("")
    : `<span>No runs recorded yet.</span>`;
}

async function refreshRecovery({ log = false } = {}) {
  try {
    const recovery = await api("/api/recovery");
    renderRecovery(recovery);
    if (log) logOperation("Recovery scan", "Backup list is current.", "success");
    return recovery;
  } catch (error) {
    if (elements.recoveryBackupList) elements.recoveryBackupList.innerHTML = `<span>Recovery scan failed.</span>`;
    logOperation("Recovery scan failed", error.message, "danger");
    return null;
  }
}

async function refreshBenchmarkHistory() {
  try {
    const history = await api("/api/benchmark-history?limit=12");
    renderBenchmarkHistory(history);
    return history;
  } catch (error) {
    if (elements.benchmarkProof) elements.benchmarkProof.innerHTML = `<span>Proof history unavailable.</span>`;
    if (elements.benchmarkHistory) elements.benchmarkHistory.innerHTML = `<span>Benchmark history unavailable.</span>`;
    return null;
  }
}

function renderSmartPlan(plan) {
  if (!elements.smartPlan) return;
  const steps = plan?.steps?.filter((step) => step.id !== "speedCheck") || [];
  if (elements.smartPlanSummary) {
    elements.smartPlanSummary.textContent = plan?.summary || "Picks useful cleanup from the current scan.";
  }
  renderSmartDecision(plan);
  if (!steps.length) {
    elements.smartPlan.innerHTML = `<span>Nothing urgent</span>`;
    return;
  }
  elements.smartPlan.innerHTML = steps
    .slice(0, 4)
    .map(
      (step) =>
        `<span class="${step.impact || "medium"}${step.disabled ? " disabled" : ""}" title="${escapeHtml(step.reason || step.label)}" data-reason="${escapeHtml(step.reason || step.label)}">${escapeHtml(step.label)}</span>`,
    )
    .join("");
}

function renderSmartDecision(plan) {
  const decision = plan?.decision;
  if (!decision) return;
  const diagnosis = decision.diagnosis || plan.diagnosis;
  const suggested = policyLabel(decision.suggestedPolicy);
  const selected = policyLabel(decision.selectedPolicy || plan.policy);
  const effective = policyLabel(decision.effectivePolicy || plan.effectivePolicy || decision.suggestedPolicy);
  const isAuto = (decision.selectedPolicy || plan.policy) === "auto";
  if (elements.smartDecisionMode) {
    elements.smartDecisionMode.textContent = isAuto
      ? `Auto: ${effective}`
      : decision.suggestedPolicy === decision.selectedPolicy
        ? `${selected} is best`
        : `Suggest ${suggested}`;
  }
  if (elements.smartDecisionHeadline) {
    elements.smartDecisionHeadline.textContent = decision.headline || plan.title || "Ready to optimize";
  }
  if (elements.smartDecisionReason) {
    const suggestedReason = decision.suggestedReason || "Auto chose from the current scan.";
    const deleteNote =
      decision.deleteRequiresArm && !/locked|deletes are on/i.test(suggestedReason)
        ? " Delete actions stay locked until you allow them."
        : "";
    elements.smartDecisionReason.textContent = isAuto
      ? `${suggestedReason}${deleteNote}`
      : decision.suggestedPolicy === decision.selectedPolicy
        ? suggestedReason || "Current mode matches the scan."
        : `${suggestedReason || "The scan found a better default."} Current mode: ${selected}.`;
  }
  if (diagnosis) {
    if (elements.smartDiagnosis) {
      elements.smartDiagnosis.dataset.confidence = String(diagnosis.confidence || "low").toLowerCase();
      elements.smartDiagnosis.title = diagnosis.detail || "";
    }
    if (elements.diagnosisCause) elements.diagnosisCause.textContent = diagnosis.primaryCause || "Scanning";
    if (elements.diagnosisConfidence) {
      elements.diagnosisConfidence.textContent = diagnosis.confidence
        ? `${diagnosis.confidence} / ${diagnosis.severity || "Measured"}`
        : "--";
    }
    if (elements.diagnosisAction) {
      elements.diagnosisAction.textContent = shortActionLabel(diagnosis.nextAction, diagnosis);
      elements.diagnosisAction.title = diagnosis.archiveReason || diagnosis.nextAction || "Run a speed check";
    }
  }
  if (elements.smartImpact) {
    elements.smartImpact.innerHTML = (decision.impacts || [])
      .map(
        (impact) => `
          <span class="${impact.tone || "low"}" title="${escapeHtml(impact.detail || "")}">
            <strong>${escapeHtml(impact.label)}</strong>
            ${escapeHtml(impact.value)}
          </span>
        `,
      )
      .join("");
  }
  if (elements.smartDeleteArmControl) {
    elements.smartDeleteArmControl.hidden = !(plan.destructive && plan.policy !== "safe");
  }
  renderBoost(plan);
  renderDeleteArmState();
}

async function refreshScan({ log = true, manageBusy = true } = {}) {
  if (manageBusy) setBusy(true, "Scanning local Codex data");
  try {
    const scan = await api(`/api/scan?${scanParams()}`);
    renderScan(scan);
    if (log) logOperation("Scan complete", "The dashboard is up to date.", "success");
    return scan;
  } catch (error) {
    logOperation("Scan failed", error.message, "danger");
    elements.lastScan.textContent = "Scan failed";
    return null;
  } finally {
    if (manageBusy) setBusy(false);
  }
}

async function runBenchmark({ fromAction = false } = {}) {
  const ownsBusy = !busy;
  if (ownsBusy) setBusy(true, "Running speed check");
  try {
    const benchmark = await api("/api/benchmark", { method: "POST" });
    renderBenchmark(benchmark);
    if (!benchmark.history) await refreshBenchmarkHistory();
    const delta = benchmark.deltas ? ` ${formatSigned(benchmark.deltas.score)} since prior check.` : " Baseline saved.";
    const guidance = benchmark.guidance?.[0] ? ` ${benchmark.guidance[0]}` : "";
    logOperation(
      fromAction ? "Speed check after refit" : "Speed check",
      `Readiness ${benchmark.metrics.score}/100 (${benchmark.rating}).${delta}${guidance}`,
      benchmark.metrics.score >= 72 ? "success" : "info",
    );
    return benchmark;
  } catch (error) {
    logOperation("Speed check failed", error.message, "danger");
    return null;
  } finally {
    if (ownsBusy) {
      setBusy(false);
      if (currentScan) elements.lastScan.textContent = `Scanned ${formatDate(currentScan.generatedAt)}`;
    }
  }
}

function getNumber(id) {
  return Number($(id).value || 0);
}

function scanParams() {
  const params = new URLSearchParams({
    policy: getPolicy(),
    days: "auto",
    logDays: String(smartOptimizeLogDays),
    deleteDays: String(getNumber("#archiveDeleteDays") || 30),
  });
  return params.toString();
}

function optionsForAction(action) {
  const options = {};
  if (action === "archiveStaleThreads") options.days = getNumber("#archiveDays");
  if (action === "deleteArchivedTranscripts") options.days = getNumber("#deleteArchivedDays");
  if (action === "pruneLogs") {
    options.days = getNumber("#logDays");
    options.backup = $("#backupLogs").checked;
  }
  if (action === "deleteCrashDumps") options.days = getNumber("#crashDays");
  if (action === "deleteMaintenanceArchives") options.days = getNumber("#maintenanceDays");
  if (action === "archiveGeneratedImages") options.days = getNumber("#imageDays");
  return options;
}

function actionLabel(action) {
  return {
    archiveStaleThreads: "Archive stale threads",
    migrateArchivedSessions: "Move archived transcripts",
    deleteArchivedTranscripts: "Delete old archived conversations",
    pruneLogs: "Prune old logs",
    vacuumState: "Compact state database",
    deleteCrashDumps: "Clear crash reports",
    cleanBrowserCaches: "Clean browser caches",
    deleteMaintenanceArchives: "Delete old Refit backups",
    archiveGeneratedImages: "Move generated images",
    safeSweep: "Smart Optimize",
  }[action];
}

async function runAction(action, options = {}) {
  if (busy) return;

  const button = document.querySelector(`[data-action="${action}"]`);
  const requiredConfirm = button?.dataset.confirm;
  if (requiredConfirm) {
    if (!elements.destructiveArm?.checked) {
      logOperation("Deletes are off", `Allow deletes before running ${actionLabel(action)}.`, "danger");
      return;
    }
    options.confirm = requiredConfirm;
  }

  setBusy(true, `${actionLabel(action)} running`);
  try {
    const result = await api("/api/action", {
      method: "POST",
      body: JSON.stringify({ action, options }),
    });
    logOperation(actionLabel(action), result.summary || "Done.", "success");
    if (result.details?.length) {
      result.details.forEach((detail) => logOperation("Detail", detail, "info"));
    }
    await refreshScan({ log: false, manageBusy: false });
    if (result.outcome) renderRefitOutcome(result.outcome);
    await refreshRecovery();
    if (action === "safeSweep") {
      const benchmark = await runBenchmark({ fromAction: true });
      if (result.outcome) renderRefitOutcome(result.outcome, benchmark);
    }
  } catch (error) {
    logOperation(actionLabel(action), error.message, "danger");
  } finally {
    setBusy(false);
  }
}

async function copyDoctorSnippet(button) {
  const text = decodeURIComponent(button.dataset.copy || "");
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    const originalText = button.textContent;
    button.textContent = "Copied";
    logOperation("Copied Fix Kit snippet", "Snippet copied to the clipboard.", "success");
    setTimeout(() => {
      button.textContent = originalText;
    }, 1400);
  } catch (error) {
    logOperation("Copy failed", error.message || "Clipboard access was not available.", "danger");
  }
}

async function runOfficialDoctor() {
  if (busy) return;
  setBusy(true, "Official Codex Doctor running");
  if (elements.runOfficialDoctor) elements.runOfficialDoctor.textContent = "Running";
  try {
    const result = await api("/api/official-doctor", { method: "POST" });
    renderOfficialDoctor(result);
    logOperation("Official Doctor", result.headline || "Codex Doctor finished.", result.tone === "high" ? "danger" : "info");
  } catch (error) {
    logOperation("Official Doctor", error.message, "danger");
    if (elements.officialDoctor) {
      elements.officialDoctor.hidden = false;
      elements.officialDoctor.innerHTML = `
        <article class="high">
          <span>Official Doctor</span>
          <strong>Failed</strong>
          <small>${escapeHtml(error.message)}</small>
        </article>
      `;
    }
  } finally {
    if (elements.runOfficialDoctor) elements.runOfficialDoctor.textContent = "Run Official Doctor";
    setBusy(false);
  }
}

elements.refreshScan.addEventListener("click", refreshScan);
elements.safeSweep.addEventListener("click", () =>
  runAction("safeSweep", {
    days: "auto",
    logDays: smartOptimizeLogDays,
    policy: getPolicy(),
    deleteDays: getNumber("#archiveDeleteDays") || 30,
    ...(getPolicy() === "safe" || !isDeleteArmed() ? {} : { confirm: "DELETE" }),
  }),
);
elements.optimizePolicies.forEach((input) => {
  input.addEventListener("change", () => {
    renderPolicyState();
    refreshScan();
  });
});
$("#safeSweepDays")?.addEventListener("change", refreshScan);
elements.archiveDeleteDays?.addEventListener("change", refreshScan);
elements.clearLog.addEventListener("click", () => elements.operationLog.replaceChildren());
elements.runBenchmark?.addEventListener("click", () => runBenchmark());
elements.runOfficialDoctor?.addEventListener("click", runOfficialDoctor);
elements.refreshRecovery?.addEventListener("click", () => refreshRecovery({ log: true }));
elements.easyModeButton?.addEventListener("click", () => setHardMode(false));
elements.hardModeButton?.addEventListener("click", () => setHardMode(true));
elements.advancedMode?.addEventListener("change", () => {
  renderMode();
  if (elements.advancedMode.checked) refreshRecovery();
  logOperation(
    elements.advancedMode.checked ? "Hard Mode" : "Easy Mode",
    elements.advancedMode.checked
      ? "Manual controls are visible."
      : "Manual controls are hidden.",
    "info",
  );
});
elements.destructiveArm?.addEventListener("change", () => setDeleteArmed(elements.destructiveArm.checked, { log: true }));
elements.smartDeleteArm?.addEventListener("change", () => setDeleteArmed(elements.smartDeleteArm.checked, { log: true }));

document.querySelectorAll("[data-action]").forEach((button) => {
  button.addEventListener("click", () => runAction(button.dataset.action, optionsForAction(button.dataset.action)));
});

document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-copy]");
  if (!button) return;
  event.preventDefault();
  copyDoctorSnippet(button);
});

window.codexRefit?.onRescan(() => refreshScan());

renderPolicyState();
renderMode();
renderDeleteArmState();
refreshScan();
refreshRecovery();
refreshBenchmarkHistory();
