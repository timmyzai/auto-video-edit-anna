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
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import cliProgress from "cli-progress";
import notifier from "node-notifier";

import { detectDraftFolder, capcutBinPath } from "./lib/draft_folder.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const capcutBin = capcutBinPath();
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

  // capcut-cli's own addVideo() (called once per timeline item) copies the source into
  // the draft's assets folder. It used to SHA1-hash the entire source file twice on
  // every item after the first just to re-verify a same-named asset was still the same
  // content (capcut-cli/dist/factory.js: copyAssetDeduped -> sameContent -> fileSha1),
  // with no caching across items - since a rough cut's segments all share one source
  // clip by construction, that was O(segments x file size) of pure redundant disk I/O.
  // Patched locally (patches/capcut-cli+0.16.0.patch, kept in sync via `postinstall`)
  // to memoize the hash by resolved-path+size+mtime, so each unique source file gets
  // hashed once, not once per segment - collapses what was a 45-100+ minute compile on
  // real footage (three clips, ~5.6GB combined, 920 segments) down to about a minute.
  // The same patch adds an exact per-item progress counter (copyAssetDeduped fires once
  // per timeline item, a 1:1 mapping with segment count) written to ROUGH_CUT_PROGRESS_FILE
  // when that env var is set - a no-op for any other capcut-cli usage that doesn't set it.
  const progressFile = path.join(os.tmpdir(), `capcut-progress-${process.pid}.json`);
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

  const bar = new cliProgress.SingleBar({
    format: "Compiling draft |{bar}| {percentage}% | {value}/{total} segments | ETA: {eta_formatted}",
    stream: process.stderr,
    hideCursor: true,
  }, cliProgress.Presets.shades_classic);
  bar.start(totalSegments, 0);

  const pollTimer = setInterval(() => {
    try {
      const progress = JSON.parse(fs.readFileSync(progressFile, "utf-8"));
      bar.update(Math.min(progress.done, totalSegments));
    } catch {
      // Progress file may not exist yet (child hasn't started copying assets) or be
      // mid-write - both transient, just skip this tick.
    }
  }, 250);

  let result;
  try {
    result = await new Promise((resolvePromise) => {
      const child = spawn(q(capcutBin), ["compile", q(specPath), "--jianying", "--drafts", q(draftFolder), "-H"], {
        encoding: "utf-8",
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ROUGH_CUT_PROGRESS_FILE: progressFile },
      });
      let stdout = "", stderr = "";
      child.stdout.on("data", (d) => { stdout += d; });
      child.stderr.on("data", (d) => { stderr += d; });
      child.on("error", (error) => resolvePromise({ error, stdout, stderr, status: null }));
      child.on("close", (status) => resolvePromise({ status, stdout, stderr }));
    });
  } finally {
    clearInterval(pollTimer);
    fs.rmSync(specPath, { force: true });
    fs.rmSync(progressFile, { force: true });
  }

  if (result.error) {
    bar.stop();
    console.error("capcut compile failed to start.");
    throw result.error;
  }
  if (result.status !== 0) {
    bar.stop();
    console.error("capcut compile failed.");
    if (result.stdout) console.error(result.stdout);
    if (result.stderr) console.error(result.stderr);
    throw new Error(`capcut compile exited with code ${result.status}`);
  }
  bar.update(totalSegments);
  bar.stop();
  console.error(`Draft compiled (${totalSegments} segments).`);
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

main().catch((err) => {
  console.error(err.stack || err.message || err);
  process.exitCode = 1;
});
