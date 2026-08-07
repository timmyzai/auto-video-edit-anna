#!/usr/bin/env node
// Build a Jianying/CapCut draft (project) from a keep_segments.json produced by
// silence_classifier/classify.js. Each kept span becomes one video segment on a
// single track, placed back-to-back. Node.js port of the original Python
// build_draft.py (pyJianYingDraft) - uses capcut-cli's `compile` command instead,
// which writes the same draft_content.json/draft_meta_info.json format Jianying
// itself writes. Verified byte-identical output (same duration, same content at
// matching timestamps) against the pyJianYingDraft version before switching.
//
// Usage:
//   node jianying/build_draft.js --keep-segments keep_segments.json --draft-name "My Rough Cut"
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import ora from "ora";
import notifier from "node-notifier";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// A hardcoded guess at this path goes stale the moment Jianying changes its storage
// layout (confirmed firsthand: opening a newer Jianying build migrated this machine's
// real drafts folder out from under an earlier hardcoded constant here, with no error -
// the draft silently landed in an unindexed location instead). `capcut doctor` already
// does real Windows/Mac x CapCut/JianYing detection (checks which install actually has a
// live drafts folder), so ask it instead of guessing.
function detectDraftFolder(capcutBin) {
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

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, "").replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    out[key] = argv[i + 1];
  }
  if (!out.keepSegments || !out.draftName) {
    throw new Error("Usage: build_draft.js --keep-segments <path> --draft-name <name> [--draft-folder <dir>] [--fps <n>]");
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const capcutBin = path.join(__dirname, "..", "node_modules", ".bin", process.platform === "win32" ? "capcut.cmd" : "capcut");
  const draftFolder = args.draftFolder || detectDraftFolder(capcutBin);
  const fps = args.fps ? Number(args.fps) : 30;

  const clips = JSON.parse(fs.readFileSync(args.keepSegments, "utf-8"));
  if (clips.length === 0) throw new Error(`No clips found in ${args.keepSegments}`);

  const tracks = [];
  let cumulative = 0;
  let totalSegments = 0;

  for (const clipEntry of clips) {
    const sourceVideo = path.resolve(clipEntry.clip);
    console.error(`Source: ${sourceVideo} (${clipEntry.keep_seconds.length} segments)`);

    // ffprobe (classify.js's duration_s) and capcut-cli's own ffprobe-backed duration
    // check can still disagree by a few ms on some containers - clamp defensively
    // rather than let a borderline segment throw "duration exceeds source duration".
    const materialDuration = clipEntry.duration_s;
    const items = [];
    for (const [inS, outS] of clipEntry.keep_seconds) {
      const clampedOutS = materialDuration ? Math.min(outS, materialDuration) : outS;
      const dur = clampedOutS - inS;
      if (dur <= 0) continue;
      items.push({
        path: sourceVideo,
        start: round3(cumulative),
        duration: round3(dur),
        sourceStart: round3(inS),
      });
      cumulative += dur;
      totalSegments++;
    }
    tracks.push({ type: "video", name: "main_video", items });
  }

  const spec = { name: args.draftName, fps, tracks };

  const specPath = path.join(os.tmpdir(), `capcut-spec-${process.pid}.json`);
  fs.writeFileSync(specPath, JSON.stringify(spec, null, 2));

  const draftPath = path.join(draftFolder, args.draftName);
  if (fs.existsSync(draftPath)) {
    fs.rmSync(draftPath, { recursive: true, force: true });
  }

  // Despite only assembling JSON at the spec level, capcut-cli's own addVideo() (called
  // once per timeline item) copies the source into the draft's assets folder, and -
  // confirmed by profiling against a real 540MB source with 68 kept segments (~2 minutes
  // real time) - on every item after the first it SHA1-hashes the ENTIRE source file
  // twice to verify a same-named asset already there is still the same content
  // (capcut-cli/dist/factory.js: copyAssetDeduped -> sameContent -> fileSha1), with no
  // caching across items in the same run. A rough cut's segments all share one source
  // clip by construction, so this is the dominant cost, not an edge case - runtime scales
  // with segments x source-file-size, not just segment count. No CLI flag skips it
  // (checked `compile`'s usage: only --out/--drafts/--check/--plan/--template/--quiet
  // exist) - this is capcut-cli's own behavior, not something our spec can opt out of.
  // The spinner is a "don't assume this is stuck" signal for what can be a genuinely
  // multi-minute wait on real footage, not decoration for what only looked fast on small
  // synthetic test inputs.
  //
  // spawnSync (not execFileSync) with stdio explicitly piped: execFileSync's default
  // stdio inherits the child's stderr LIVE into our own stderr - confirmed by testing -
  // which is the exact stream ora is mid-render on. capcut-cli writes a status line to
  // its own stderr on success, and that write landing between the spinner's start and
  // its cursor-controlled succeed/fail redraw corrupts the terminal line. Capturing both
  // streams (spawnSync always returns them, success or failure - unlike execFileSync,
  // which only returns stdout on success) and printing them ourselves after the spinner
  // has resolved avoids that.
  const spinner = ora({
    text: `Compiling draft (${totalSegments} segments)... this can take several minutes for many segments from one large source file`,
    stream: process.stderr,
  }).start();
  // shell:true does NOT quote array args for you on Windows - it just joins them with
  // spaces before handing the line to cmd.exe. Confirmed by direct reproduction: an
  // unquoted --drafts value containing a space ("...\JianyingPro\User Data\Projects\...")
  // silently split at the space, so capcut-cli's arg parser only ever saw
  // "...\JianyingPro\User" as the --drafts value and wrote the draft there instead of the
  // intended com.lveditor.draft folder - with no error, since the leftover
  // "Data\Projects\..." token just looked like an unrecognized positional arg. Quoting
  // every path-bearing argument ourselves is required, not optional, whenever shell:true
  // is combined with real Windows paths (which routinely contain spaces, e.g. "Program
  // Files" or, as here, "User Data").
  const q = (s) => `"${s}"`;
  let result;
  try {
    result = spawnSync(q(capcutBin), ["compile", q(specPath), "--jianying", "--drafts", q(draftFolder), "-H"], {
      encoding: "utf-8",
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } finally {
    fs.rmSync(specPath, { force: true });
  }

  if (result.error) {
    spinner.fail("capcut compile failed to start.");
    throw result.error;
  }
  if (result.status !== 0) {
    spinner.fail("capcut compile failed.");
    if (result.stdout) console.error(result.stdout);
    if (result.stderr) console.error(result.stderr);
    throw new Error(`capcut compile exited with code ${result.status}`);
  }
  spinner.succeed(`Draft compiled (${totalSegments} segments).`);
  if (result.stderr) console.error(result.stderr);
  console.error(result.stdout);

  // Report capcut-cli's own resolved draft_path rather than assuming it matches the
  // --drafts folder we passed in - now that argument quoting is fixed above they should
  // always agree, but this is what actually caught the quoting bug in the first place
  // (a truncated --drafts value silently produced a different, wrong draft_path with no
  // error), so it stays as a cheap correctness check rather than trusting our own input.
  let savedIn = draftFolder;
  try {
    const parsed = JSON.parse(result.stdout);
    if (parsed.draft_path) savedIn = path.dirname(parsed.draft_path);
  } catch {
    // Unparseable stdout (e.g. --jianying warnings prepended some other line) - fall
    // back to the requested folder rather than fail a successful build over this.
  }

  console.error(`\nSaved draft '${args.draftName}' in ${savedIn}`);
  console.error(`${totalSegments} segments, ${cumulative.toFixed(2)}s total. Open Jianying to preview before exporting.`);

  notifyDone("Draft ready", `'${args.draftName}' — ${totalSegments} segments, ${cumulative.toFixed(0)}s. Open Jianying to review and export.`);
}

// Best-effort OS toast - a missing/blocked notifier backend must never turn an
// otherwise-successful build into a failed one, so failures here are logged, not thrown.
function notifyDone(title, message) {
  try {
    notifier.notify({ title, message, sound: true }, (err) => {
      if (err) console.error(`(notification failed: ${err.message})`);
    });
  } catch (err) {
    console.error(`(notification failed: ${err.message})`);
  }
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

main();
