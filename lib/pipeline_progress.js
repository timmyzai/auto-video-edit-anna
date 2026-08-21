// Shared progress tracking for the autonomous rough-cut pipeline - ONE file
// per project (projects/<name>/pipeline_progress.json), every stage (both
// mechanical CLI scripts and Claude's own manual manifest-review passes)
// writes into the same file so a single `show_progress.js` call (or a
// direct read) shows the whole flow, not N different progress files with
// different shapes. Built because insert_rough_cut.js's own
// rough_cut_progress.json was a one-off, stage-blind mechanism - this
// replaces that pattern rather than adding a second one alongside it.
//
// CANONICAL_STAGES is the single source of truth for "what stages exist and
// in what order" - both rough-cut passes plus the content-aware add-on
// pipeline in between. A run declares which subset it actually uses via
// initPipeline()'s stageIds (e.g. a caption-free run skips every
// dialogue-aware stage entirely rather than showing them as perpetually
// "pending").
//
// CLI usage (each pipeline script calls these instead of hand-rolling
// progress JSON):
//   node lib/pipeline_progress.js init <path> --project <name> --stages id1,id2,...
//   node lib/pipeline_progress.js start <path> <stageId> [--total N] [--note "..."]
//   node lib/pipeline_progress.js update <path> <stageId> --done N [--total N] [--note "..."]
//   node lib/pipeline_progress.js complete <path> <stageId> [--note "..."]
//   node lib/pipeline_progress.js fail <path> <stageId> --error "..."
//   node lib/pipeline_progress.js skip <path> <stageId> [--note "..."]
//   node lib/pipeline_progress.js show <path>
import fs from "node:fs";
import { pathToFileURL } from "node:url";

export const CANONICAL_STAGES = [
  { id: "resolve_draft", label: "Resolve draft & sources", group: "rough_cut_1" },
  { id: "suggest_threshold", label: "Suggest per-clip thresholds", group: "rough_cut_1" },
  { id: "classify_amplitude", label: "Classify (sound-only)", group: "rough_cut_1" },
  { id: "insert_1", label: "Insert rough cut 1", group: "rough_cut_1" },
  { id: "export_captions", label: "Export auto-captions", group: "rough_cut_2" },
  { id: "classify_dialogue", label: "Classify (dialogue-aware)", group: "rough_cut_2" },
  { id: "filler_exclusion", label: "Apply filler exclusions", group: "rough_cut_2" },
  { id: "repetition_build", label: "Build repetition manifest", group: "rough_cut_2" },
  { id: "repetition_review", label: "Repetition review (judgment)", group: "rough_cut_2" },
  { id: "repetition_apply", label: "Apply repetition decisions", group: "rough_cut_2" },
  { id: "semantic_build", label: "Build semantic-review manifest", group: "rough_cut_2" },
  { id: "semantic_review", label: "Semantic review (judgment)", group: "rough_cut_2" },
  { id: "semantic_apply", label: "Apply semantic decisions", group: "rough_cut_2" },
  { id: "qa_report", label: "QA transcript report", group: "rough_cut_2" },
  { id: "rebuild_raw_map", label: "Rebuild raw-timeline-map", group: "rough_cut_2" },
  { id: "insert_2", label: "Insert rough cut 2", group: "rough_cut_2" },
];
const STAGE_BY_ID = new Map(CANONICAL_STAGES.map((s) => [s.id, s]));

function nowIso() {
  return new Date().toISOString();
}

export function loadProgress(path) {
  return JSON.parse(fs.readFileSync(path, "utf-8"));
}

// Used internally by every mutating call (start/update/complete/fail/skip)
// so a script run standalone - without an earlier init call from
// list_draft_sources.js - still gets a working progress file instead of an
// ENOENT crash. Project name defaults to the progress file's own parent
// directory name (projects/<name>/pipeline_progress.json), which is always
// the actual project name in this codebase's layout.
function loadOrCreateProgress(path) {
  if (fs.existsSync(path)) return loadProgress(path);
  const inferredProject = path.split(/[\\/]/).filter(Boolean).slice(-2, -1)[0] || "unknown";
  return { project: inferredProject, startedAt: nowIso(), updatedAt: nowIso(), stages: [] };
}

function saveProgress(path, progress) {
  progress.updatedAt = nowIso();
  fs.mkdirSync(pathDirname(path), { recursive: true });
  fs.writeFileSync(path, JSON.stringify(progress, null, 2), "utf-8");
}

// Dependency-free dirname (avoids pulling in "node:path" just for this) -
// works on both "/" and "\" separators since progress file paths cross the
// jianying/ (Windows-path-heavy) and silence_classifier/ (POSIX-style)
// callers.
function pathDirname(p) {
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return idx === -1 ? "." : p.slice(0, idx);
}

// Creates a fresh progress file listing exactly the stages this run will
// use, in canonical order, all "pending". Safe to call again at the start
// of a genuinely new run (e.g. rough cut 2 after rough cut 1 already
// finished) - deliberately overwrites rather than merges, since a fresh
// `init` call means "here is the new plan," not "add to the old one."
export function initPipeline(path, projectName, stageIds) {
  const unknown = stageIds.filter((id) => !STAGE_BY_ID.has(id));
  if (unknown.length > 0) {
    throw new Error(`Unknown stage id(s): ${unknown.join(", ")} - must be one of ${CANONICAL_STAGES.map((s) => s.id).join(", ")}`);
  }
  const stages = stageIds.map((id) => ({
    id,
    label: STAGE_BY_ID.get(id).label,
    group: STAGE_BY_ID.get(id).group,
    status: "pending",
    startedAt: null,
    completedAt: null,
    chunksDone: null,
    chunksTotal: null,
    estimatedFinishAt: null,
    note: null,
    error: null,
  }));
  const progress = { project: projectName, startedAt: nowIso(), updatedAt: nowIso(), stages };
  fs.mkdirSync(pathDirname(path), { recursive: true });
  fs.writeFileSync(path, JSON.stringify(progress, null, 2), "utf-8");
  return progress;
}

// Additive version of initPipeline: adds any of stageIds not already present
// (in canonical order, appended after whatever's already there), leaving
// existing stages' status/history untouched. This is what most scripts call
// defensively at startup rather than initPipeline - e.g. classify.js's
// --dialogue-srt branch appending the rough-cut-2 stages onto a file
// list_draft_sources.js already started for rough cut 1, without wiping
// rough cut 1's completed timestamps.
export function ensureStagesPresent(path, projectName, stageIds) {
  const progress = fs.existsSync(path) ? loadProgress(path) : { project: projectName, startedAt: nowIso(), updatedAt: nowIso(), stages: [] };
  const present = new Set(progress.stages.map((s) => s.id));
  for (const id of stageIds) {
    if (present.has(id)) continue;
    const meta = STAGE_BY_ID.get(id);
    if (!meta) throw new Error(`Unknown stage id: ${id}`);
    progress.stages.push({
      id,
      label: meta.label,
      group: meta.group,
      status: "pending",
      startedAt: null,
      completedAt: null,
      chunksDone: null,
      chunksTotal: null,
      estimatedFinishAt: null,
      note: null,
      error: null,
    });
  }
  saveProgress(path, progress);
  return progress;
}

function findStage(progress, stageId, path) {
  const stage = progress.stages.find((s) => s.id === stageId);
  if (!stage) {
    // A script run standalone (outside a full pipeline init) shouldn't hard
    // fail just because its stage wasn't pre-declared - append it so
    // progress is still visible, same discipline as classify.js's own
    // "don't error, do something reasonable" defaults elsewhere.
    const meta = STAGE_BY_ID.get(stageId);
    const appended = {
      id: stageId,
      label: meta ? meta.label : stageId,
      group: meta ? meta.group : "unknown",
      status: "pending",
      startedAt: null,
      completedAt: null,
      chunksDone: null,
      chunksTotal: null,
      estimatedFinishAt: null,
      note: null,
      error: null,
    };
    progress.stages.push(appended);
    return appended;
  }
  return stage;
}

function estimateFinish(startedAtIso, done, total) {
  if (!startedAtIso || !done || !total || done <= 0 || total <= done) return null;
  const startedMs = new Date(startedAtIso).getTime();
  const elapsedMs = Date.now() - startedMs;
  const ratePerUnit = elapsedMs / done;
  const remainingMs = ratePerUnit * (total - done);
  return new Date(Date.now() + remainingMs).toISOString();
}

export function startStage(path, stageId, { total, note } = {}) {
  const progress = loadOrCreateProgress(path);
  const stage = findStage(progress, stageId, path);
  stage.status = "in_progress";
  stage.startedAt = stage.startedAt || nowIso();
  if (total !== undefined) stage.chunksTotal = total;
  if (note !== undefined) stage.note = note;
  saveProgress(path, progress);
  return stage;
}

export function updateStageProgress(path, stageId, { done, total, note } = {}) {
  const progress = loadOrCreateProgress(path);
  const stage = findStage(progress, stageId, path);
  if (stage.status === "pending") {
    stage.status = "in_progress";
    stage.startedAt = stage.startedAt || nowIso();
  }
  if (done !== undefined) stage.chunksDone = done;
  if (total !== undefined) stage.chunksTotal = total;
  if (note !== undefined) stage.note = note;
  stage.estimatedFinishAt = estimateFinish(stage.startedAt, stage.chunksDone, stage.chunksTotal);
  saveProgress(path, progress);
  return stage;
}

export function completeStage(path, stageId, { note } = {}) {
  const progress = loadOrCreateProgress(path);
  const stage = findStage(progress, stageId, path);
  stage.status = "completed";
  stage.startedAt = stage.startedAt || nowIso();
  stage.completedAt = nowIso();
  if (stage.chunksTotal != null) stage.chunksDone = stage.chunksTotal;
  stage.estimatedFinishAt = null;
  if (note !== undefined) stage.note = note;
  stage.error = null;
  saveProgress(path, progress);
  return stage;
}

export function failStage(path, stageId, error) {
  const progress = loadOrCreateProgress(path);
  const stage = findStage(progress, stageId, path);
  stage.status = "failed";
  stage.completedAt = nowIso();
  stage.error = error instanceof Error ? error.message : String(error);
  saveProgress(path, progress);
  return stage;
}

// Convenience wrapper most CLI scripts use instead of calling
// start/complete/fail individually - `fn` is the script's actual work
// (sync or async); its return value is passed through unchanged so this
// slots in around an existing main() call with a minimal diff. `fn`
// receives no arguments - a script needing to report chunk progress mid-run
// still calls updateStageProgress(path, stageId, {...}) directly from
// inside its own loop, this wrapper only owns the start/complete/fail edges.
export function withStage(path, stageId, fn, { total, note } = {}) {
  startStage(path, stageId, { total, note });
  try {
    const result = fn();
    if (result && typeof result.then === "function") {
      return result
        .then((value) => {
          completeStage(path, stageId);
          return value;
        })
        .catch((err) => {
          failStage(path, stageId, err);
          throw err;
        });
    }
    completeStage(path, stageId);
    return result;
  } catch (err) {
    failStage(path, stageId, err);
    throw err;
  }
}

// For a stage this particular run never uses (e.g. the dialogue-aware
// stages on a caption-free run) - marked distinctly from "completed" so the
// display doesn't imply work happened.
export function skipStage(path, stageId, note) {
  const progress = loadOrCreateProgress(path);
  const stage = findStage(progress, stageId, path);
  stage.status = "skipped";
  stage.completedAt = nowIso();
  if (note !== undefined) stage.note = note;
  saveProgress(path, progress);
  return stage;
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "-";
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m${String(sec).padStart(2, "0")}s`;
  return `${sec}s`;
}

function formatClock(iso) {
  if (!iso) return "-";
  const d = new Date(iso);
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

const STATUS_ICON = { pending: "◻", in_progress: "⏳", completed: "✅", failed: "❌", skipped: "➖" };

export function renderProgress(progress) {
  const lines = [];
  const totalElapsedMs = Date.now() - new Date(progress.startedAt).getTime();
  lines.push(`Pipeline: ${progress.project}`);
  lines.push(`Started: ${formatClock(progress.startedAt)}  (running ${formatDuration(totalElapsedMs)})`);
  lines.push("");
  let lastGroup = null;
  for (const [i, s] of progress.stages.entries()) {
    if (s.group !== lastGroup) {
      lines.push(`-- ${s.group} --`);
      lastGroup = s.group;
    }
    const icon = STATUS_ICON[s.status] || "?";
    let progressStr = "";
    if (s.chunksTotal != null && s.chunksTotal > 0) {
      const pct = Math.round(((s.chunksDone || 0) / s.chunksTotal) * 100);
      progressStr = `${s.chunksDone || 0}/${s.chunksTotal} (${pct}%)`;
    }
    let timing = "";
    if (s.status === "completed" && s.startedAt && s.completedAt) {
      timing = `done in ${formatDuration(new Date(s.completedAt) - new Date(s.startedAt))}, finished ${formatClock(s.completedAt)}`;
    } else if (s.status === "in_progress") {
      const elapsed = s.startedAt ? formatDuration(Date.now() - new Date(s.startedAt).getTime()) : "-";
      timing = s.estimatedFinishAt
        ? `elapsed ${elapsed}, ETA ${formatClock(s.estimatedFinishAt)}`
        : `elapsed ${elapsed}, ETA unknown`;
    } else if (s.status === "failed") {
      timing = `FAILED: ${s.error || "unknown error"}`;
    } else if (s.status === "skipped") {
      timing = "skipped" + (s.note ? ` (${s.note})` : "");
    }
    const label = `${i + 1}. ${s.label}`.padEnd(34);
    lines.push(`  ${icon} ${label} ${progressStr.padEnd(16)} ${timing}${s.note && s.status === "in_progress" ? `  [${s.note}]` : ""}`);
  }
  const done = progress.stages.filter((s) => s.status === "completed" || s.status === "skipped").length;
  lines.push("");
  lines.push(`${done}/${progress.stages.length} stages done.`);
  return lines.join("\n");
}

// --- CLI ---
function parseFlags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      out[key] = argv[i + 1];
      i++;
    }
  }
  return out;
}

function runCli() {
  const [, , cmd, path, stageIdOrNothing, ...rest] = process.argv;
  if (!cmd) {
    console.error(
      "Usage: node lib/pipeline_progress.js <init|start|update|complete|fail|skip|show> <path> [stageId] [--flags]"
    );
    process.exit(1);
  }
  if (cmd === "init") {
    const flags = parseFlags([stageIdOrNothing, ...rest]);
    const stageIds = (flags.stages || "").split(",").map((s) => s.trim()).filter(Boolean);
    initPipeline(path, flags.project || "unknown", stageIds);
    console.error(`Initialized ${path} with ${stageIds.length} stage(s).`);
    return;
  }
  if (cmd === "show") {
    console.log(renderProgress(loadProgress(path)));
    return;
  }
  const flags = parseFlags(rest);
  if (cmd === "start") {
    startStage(path, stageIdOrNothing, {
      total: flags.total !== undefined ? Number(flags.total) : undefined,
      note: flags.note,
    });
  } else if (cmd === "update") {
    updateStageProgress(path, stageIdOrNothing, {
      done: flags.done !== undefined ? Number(flags.done) : undefined,
      total: flags.total !== undefined ? Number(flags.total) : undefined,
      note: flags.note,
    });
  } else if (cmd === "complete") {
    completeStage(path, stageIdOrNothing, { note: flags.note });
  } else if (cmd === "fail") {
    failStage(path, stageIdOrNothing, flags.error || "unknown error");
  } else if (cmd === "skip") {
    skipStage(path, stageIdOrNothing, flags.note);
  } else {
    console.error(`Unknown command: ${cmd}`);
    process.exit(1);
  }
  console.log(renderProgress(loadProgress(path)));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli();
}
