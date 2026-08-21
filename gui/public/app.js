// Vanilla JS, no framework/build step. Drives the 4-step core rough-cut flow
// by calling the /api/* endpoints in gui/routes/api.js and reflecting
// gui/lib/pipeline_progress.js's own status vocabulary directly - no
// client-invented states.
const STAGE_KEYS = ["resolve_draft", "suggest_threshold", "classify_amplitude", "insert"];
const STATUS_TEXT = {
  pending: "pending",
  in_progress: "running…",
  completed: "done",
  failed: "failed",
  skipped: "skipped",
};

let currentProject = null;
let currentEventSource = null;
let activeOutputStage = null;
let progressTimer = null;
let jianyingTimer = null;

function enc(name) {
  return encodeURIComponent(name);
}

async function api(path, opts) {
  const res = await fetch(`/api${path}`, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts && opts.headers) },
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    // no body
  }
  if (!res.ok) {
    throw new Error((body && body.error) || `${res.status} ${res.statusText}`);
  }
  return body;
}

function outputEl(stageKey) {
  return document.querySelector(`[data-output="${stageKey}"]`);
}

function errorBox(stageKey) {
  let box = document.getElementById(`error-${stageKey}`);
  if (!box) {
    box = document.createElement("div");
    box.id = `error-${stageKey}`;
    box.className = "error-box hidden";
    const out = outputEl(stageKey);
    out.parentNode.insertBefore(box, out);
  }
  return box;
}

function showBanner(message) {
  let banner = document.getElementById("banner");
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "banner";
    banner.className = "warning";
    document.body.insertBefore(banner, document.getElementById("project-picker"));
  }
  banner.textContent = message;
  banner.classList.remove("hidden");
  clearTimeout(showBanner._t);
  showBanner._t = setTimeout(() => banner.classList.add("hidden"), 6000);
}

function appendOutput(stageKey, text) {
  const el = outputEl(stageKey);
  if (!el) return;
  el.textContent += text;
  el.scrollTop = el.scrollHeight;
}

// stdout-only buffer per stage, kept separate from the combined stdout+stderr
// display text above - suggest_threshold.js has no file output, only a
// printed result, and stderr (RMS stats) can interleave with it unpredictably,
// so parsing "the last line of the combined log" isn't reliable.
const stdoutByStage = {};

function clearOutput(stageKey) {
  const el = outputEl(stageKey);
  if (el) el.textContent = "";
  stdoutByStage[stageKey] = "";
  const box = errorBox(stageKey);
  box.classList.add("hidden");
  box.textContent = "";
}

// ---- Project picker / resume ----

async function refreshProjectList() {
  const { projects } = await api("/projects");
  const list = document.getElementById("resume-list");
  list.innerHTML = "";
  if (projects.length === 0) return;
  const heading = document.createElement("div");
  heading.className = "hint";
  heading.textContent = "Resume an existing project:";
  list.appendChild(heading);
  for (const p of projects) {
    const row = document.createElement("div");
    row.className = "resume-item";
    row.textContent = `${p.name} — ${p.stagesDone}/${p.stagesTotal} stages done`;
    row.addEventListener("click", () => {
      document.getElementById("draft-name-input").value = p.name;
      openProject(p.name);
    });
    list.appendChild(row);
  }
}

async function openProject(name) {
  if (!name || !name.trim()) return;
  currentProject = name.trim();
  await api("/projects", { method: "POST", body: JSON.stringify({ draftName: currentProject }) });
  document.getElementById("steps").classList.remove("hidden");
  document.getElementById("track-ambiguity-warning").classList.add("hidden");
  document.getElementById("results-summary").classList.add("hidden");
  document.getElementById("insert-complete").classList.add("hidden");
  for (const key of STAGE_KEYS) clearOutput(key);
  await refreshProgress();
  await refreshSources().catch(() => {});
  await refreshKeepSegments().catch(() => {});
  await refreshJianyingStatus().catch(() => {});
  startPolling();
}

// ---- Progress polling ----

function findStage(progress, key) {
  if (!progress) return null;
  if (key === "insert") return progress.stages.find((s) => s.id === "insert_1" || s.id === "insert_2");
  return progress.stages.find((s) => s.id === key);
}

function renderProgressBar(stageKey, stage) {
  const bar = document.querySelector(`[data-progress="${stageKey}"]`);
  if (!bar) return;
  if (!stage || stage.chunksTotal == null || stage.chunksTotal <= 0) {
    bar.classList.add("hidden");
    return;
  }
  bar.classList.remove("hidden");
  const done = stage.chunksDone || 0;
  const total = stage.chunksTotal;
  const pct = Math.min(100, Math.round((done / total) * 100));
  bar.querySelector(".progress-fill").style.width = `${pct}%`;
  let label = `${done}/${total} (${pct}%)`;
  if (stage.status === "in_progress" && stage.estimatedFinishAt) {
    const eta = new Date(stage.estimatedFinishAt);
    label += ` — ETA ${eta.toLocaleTimeString()}`;
  }
  bar.querySelector(".progress-label").textContent = label;
}

let anyRunning = false;

async function refreshProgress() {
  let progress = null;
  try {
    progress = await api(`/projects/${enc(currentProject)}/progress`);
  } catch {
    progress = null; // nothing has run yet - every stage stays "not started"
  }
  anyRunning = false;
  for (const key of STAGE_KEYS) {
    const stage = findStage(progress, key);
    const badge = document.querySelector(`[data-badge="${key}"]`);
    if (!stage) {
      badge.textContent = "not started";
      badge.removeAttribute("data-status");
    } else {
      badge.textContent = STATUS_TEXT[stage.status] || stage.status;
      badge.setAttribute("data-status", stage.status);
      if (stage.status === "in_progress") anyRunning = true;
      if (stage.status === "failed") {
        const box = errorBox(key);
        box.textContent = stage.error || "Failed - see output below for details.";
        box.classList.remove("hidden");
      }
    }
    renderProgressBar(key, stage);
  }
  updateButtonStates();
}

function startPolling() {
  stopPolling();
  progressTimer = setInterval(() => refreshProgress().catch(() => {}), 1500);
  jianyingTimer = setInterval(() => refreshJianyingStatus().catch(() => {}), 3000);
}

function stopPolling() {
  if (progressTimer) clearInterval(progressTimer);
  if (jianyingTimer) clearInterval(jianyingTimer);
}

// ---- Sources / thresholds ----

let lastSourceFiles = [];

async function refreshSources() {
  const sources = await api(`/projects/${enc(currentProject)}/sources`);
  lastSourceFiles = sources.sourceFiles;
  renderThresholdInputs(sources.sourceFiles, sources.sourceFiles.map(() => ""));
  updateButtonStates();
  return sources;
}

function renderThresholdInputs(sourceFiles, values) {
  const container = document.getElementById("threshold-inputs");
  container.innerHTML = "";
  sourceFiles.forEach((file, i) => {
    const row = document.createElement("div");
    row.className = "threshold-row";
    const name = document.createElement("span");
    name.className = "clip-name";
    name.textContent = file;
    name.title = file;
    const input = document.createElement("input");
    input.type = "number";
    input.step = "0.1";
    input.min = "0";
    input.style.width = "5em";
    input.dataset.thresholdIndex = String(i);
    if (values[i] !== "" && values[i] != null) input.value = values[i];
    input.addEventListener("input", updateButtonStates);
    row.appendChild(name);
    row.appendChild(input);
    container.appendChild(row);
  });
}

function readThresholds() {
  return Array.from(document.querySelectorAll("#threshold-inputs input")).map((i) => Number(i.value));
}

// ---- Results summary ----

async function refreshKeepSegments() {
  const summary = await api(`/projects/${enc(currentProject)}/keep-segments`);
  const div = document.getElementById("results-summary");
  div.classList.remove("hidden");
  document.getElementById("results-numbers").innerHTML = `
    ${summary.clipCount} clip(s), ${summary.segmentCount} segment(s)<br/>
    Kept ${summary.totalKeptS.toFixed(1)}s of ${summary.totalRawS.toFixed(1)}s raw
    (${((summary.totalKeptS / summary.totalRawS) * 100 || 0).toFixed(1)}%)<br/>
    Average segment length: ${summary.avgSegmentS.toFixed(2)}s
  `;
  document.getElementById("fragmented-warning").classList.toggle("hidden", summary.avgSegmentS >= 1.0);
  updateButtonStates();
  return summary;
}

// ---- Jianying status ----

async function refreshJianyingStatus() {
  const { running } = await api(`/projects/${enc(currentProject)}/jianying-status`);
  const el = document.getElementById("jianying-status");
  if (running) {
    el.textContent = "Jianying is currently running — close it, then refresh.";
    el.classList.remove("hidden");
  } else {
    el.textContent = "Jianying: closed ✓";
    el.classList.add("hidden");
  }
  updateButtonStates(running);
  return running;
}

// ---- Button enablement ----

let lastJianyingRunning = true;

function updateButtonStates(jianyingRunningOverride) {
  if (jianyingRunningOverride !== undefined) lastJianyingRunning = jianyingRunningOverride;
  const busy = anyRunning;

  document.getElementById("resolve-draft-btn").disabled = busy;
  document.getElementById("suggest-threshold-btn").disabled = busy || lastSourceFiles.length === 0;
  document.getElementById("classify-btn").disabled =
    busy || lastSourceFiles.length === 0 || readThresholds().some((n) => !(n >= 0));

  const reviewed = document.getElementById("reviewed-checkbox").checked;
  const resultsShown = !document.getElementById("results-summary").classList.contains("hidden");
  document.getElementById("insert-btn").disabled = busy || !resultsShown || !reviewed || lastJianyingRunning;
}

// ---- Running a step ----

function attachStream(stageKey) {
  if (currentEventSource) currentEventSource.close();
  activeOutputStage = stageKey;
  const es = new EventSource(`/api/projects/${enc(currentProject)}/stream`);
  es.addEventListener("chunk", (e) => {
    const { stream, text } = JSON.parse(e.data);
    appendOutput(activeOutputStage, text);
    if (stream === "stdout") stdoutByStage[activeOutputStage] = (stdoutByStage[activeOutputStage] || "") + text;
  });
  es.addEventListener("end", async () => {
    es.close();
    await refreshProgress().catch(() => {});
    if (stageKey === "resolve_draft") {
      await refreshSources().catch(() => {});
      await checkTrackAmbiguity().catch(() => {});
    } else if (stageKey === "suggest_threshold") {
      applySuggestedThresholds();
    } else if (stageKey === "classify_amplitude") {
      await refreshKeepSegments().catch(() => {});
    } else if (stageKey === "insert") {
      await refreshProgress().catch(() => {});
      const badge = document.querySelector('[data-badge="insert"]');
      if (badge.getAttribute("data-status") === "completed") {
        document.getElementById("insert-complete").classList.remove("hidden");
      }
    }
  });
  currentEventSource = es;
}

async function checkTrackAmbiguity() {
  const { trackAmbiguity } = await api(`/projects/${enc(currentProject)}/warnings`);
  document.getElementById("track-ambiguity-warning").classList.toggle("hidden", !trackAmbiguity);
}

// suggest_threshold.js has no file output, only a printed result: one
// suggested value per --files entry, comma-separated if more than one, as
// its last stdout write. Parse that (stdout-only, see stdoutByStage above)
// and pre-fill step 3's threshold inputs.
function applySuggestedThresholds() {
  const lines = (stdoutByStage.suggest_threshold || "").trim().split("\n").filter(Boolean);
  const last = lines[lines.length - 1] || "";
  const nums = last.split(",").map((s) => Number(s.trim()));
  if (nums.length === lastSourceFiles.length && nums.every((n) => Number.isFinite(n))) {
    renderThresholdInputs(lastSourceFiles, nums);
    updateButtonStates();
  }
}

async function runStep(stageKey, endpoint, body) {
  clearOutput(stageKey);
  try {
    await api(`/projects/${enc(currentProject)}/${endpoint}`, { method: "POST", body: JSON.stringify(body || {}) });
  } catch (e) {
    showBanner(e.message);
    return;
  }
  attachStream(stageKey);
  anyRunning = true;
  updateButtonStates();
}

// ---- Wiring ----

document.getElementById("open-project-btn").addEventListener("click", () => {
  openProject(document.getElementById("draft-name-input").value).catch((e) => showBanner(e.message));
});
document.getElementById("draft-name-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("open-project-btn").click();
});

document.getElementById("resolve-draft-btn").addEventListener("click", () => {
  const trackIndexRaw = document.getElementById("track-index-input").value;
  runStep("resolve_draft", "resolve-draft", {
    trackIndex: trackIndexRaw === "" ? undefined : Number(trackIndexRaw),
  });
});

document.getElementById("suggest-threshold-btn").addEventListener("click", async () => {
  await runStep("suggest_threshold", "suggest-threshold", {});
});

document.getElementById("classify-btn").addEventListener("click", () => {
  runStep("classify_amplitude", "classify", { thresholds: readThresholds() });
});

document.getElementById("reviewed-checkbox").addEventListener("change", () => updateButtonStates());

document.getElementById("insert-btn").addEventListener("click", () => {
  runStep("insert", "insert", {
    force: document.getElementById("force-checkbox").checked,
    dryRun: document.getElementById("dry-run-checkbox").checked,
  });
});

refreshProjectList().catch(() => {});
