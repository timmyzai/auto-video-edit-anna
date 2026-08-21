// A hardcoded guess at this path goes stale the moment Jianying changes its storage
// layout (confirmed firsthand: opening a newer Jianying build migrated this machine's
// real drafts folder out from under an earlier hardcoded constant here, with no error -
// the draft silently landed in an unindexed location instead). `capcut doctor` already
// does real Windows/Mac x CapCut/JianYing detection (checks which install actually has a
// live drafts folder), so ask it instead of guessing.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Every generated artifact for one draft (sources.json, keep_segments.json,
// rough_cut_progress.json, subtitle/caption files) lives under one folder per
// project instead of scattered at the repo root - draft names are already
// real Windows folder names (Jianying uses them as its own draft-folder names
// verbatim), so no sanitizing is needed, just reuse the name directly.
export function projectDir(draftName) {
  const dir = path.resolve(path.join(__dirname, "..", "..", "projects", draftName));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Confirmed by hitting it directly: capcut-cli refuses to write a draft while
// Jianying has it open, so callers that mutate a draft (build_draft.js,
// insert_rough_cut.js's own caller, this repo's GUI dashboard) need to check
// first rather than let a multi-minute job fail partway through. Returns a
// boolean rather than throwing so callers can decide what to do with the
// result (rough_cut.js throws immediately; the GUI reports it and disables a
// button instead of crashing a request handler).
export function isJianyingRunning() {
  if (process.platform !== "win32") return false;
  const result = spawnSync("tasklist", ["/FI", "IMAGENAME eq JianyingPro.exe", "/NH"], { encoding: "utf-8" });
  return Boolean(result.stdout && result.stdout.includes("JianyingPro.exe"));
}

export function capcutBinPath() {
  return path.join(__dirname, "..", "..", "node_modules", ".bin", process.platform === "win32" ? "capcut.cmd" : "capcut");
}

export function detectDraftFolder(capcutBin = capcutBinPath()) {
  const result = spawnSync(`"${capcutBin}"`, ["doctor"], {
    encoding: "utf-8",
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    throw new Error(
      `capcut doctor produced unparseable output (exit ${result.status}): ${result.stdout || result.stderr}`
    );
  }
  const draftChecks = (report.checks || []).filter((c) => c.name === "draft-dir");
  const found = draftChecks.find((c) => c.status === "ok");
  if (!found) {
    const detail = draftChecks.map((c) => c.detail).join("; ") || "no draft-dir checks reported";
    throw new Error(
      `Could not auto-detect a Jianying/CapCut drafts folder (${detail}). ` +
      `Open Jianying or CapCut once to initialize it, or pass --draft-folder explicitly.`
    );
  }
  const match = found.detail.match(/found \((.+)\)$/);
  if (!match) {
    throw new Error(`capcut doctor reported the drafts folder as found but detail didn't include a path: ${found.detail}`);
  }
  return match[1];
}
