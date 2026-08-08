// A hardcoded guess at this path goes stale the moment Jianying changes its storage
// layout (confirmed firsthand: opening a newer Jianying build migrated this machine's
// real drafts folder out from under an earlier hardcoded constant here, with no error -
// the draft silently landed in an unindexed location instead). `capcut doctor` already
// does real Windows/Mac x CapCut/JianYing detection (checks which install actually has a
// live drafts folder), so ask it instead of guessing.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
