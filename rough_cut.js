#!/usr/bin/env node
// One-command daily entry point: raw footage folder in, Jianying draft out.
// Chains classify.js -> qa_check.js -> jianying/build_draft.js, self-heals the
// ffmpeg-on-PATH friction winget leaves behind, and checks Jianying is closed
// up front instead of failing partway through a multi-minute build.
//
// Usage:
//   node rough_cut.js --raw "C:\path\to\footage folder" [--draft-name "My Rough Cut"] [--config config/rough_cut_config.json]
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, "").replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    out[key] = argv[i + 1];
  }
  if (!out.raw) {
    throw new Error(
      'Usage: rough_cut.js --raw "<folder of source clips>" [--draft-name "<name>"] [--config <path>]'
    );
  }
  return out;
}

// winget's PATH update only takes effect in brand-new processes; a long-lived shell
// (or this script run right after a fresh ffmpeg install) can still miss it. Try PATH
// first, fall back to winget's known install layout, so daily use never needs a manual
// "restart your terminal" step just to find ffmpeg.
function ensureFfmpegOnPath() {
  const probe = spawnSync("ffmpeg", ["-version"], { stdio: "ignore", shell: true });
  if (probe.status === 0) return;

  if (process.platform !== "win32") {
    throw new Error("ffmpeg/ffprobe not found on PATH. Install ffmpeg and try again.");
  }
  const pkgRoot = path.join(
    process.env.LOCALAPPDATA || "",
    "Microsoft", "WinGet", "Packages"
  );
  if (!fs.existsSync(pkgRoot)) {
    throw new Error("ffmpeg/ffprobe not found on PATH, and no winget package dir to fall back to. Install ffmpeg (winget install ffmpeg) and try again.");
  }
  const ffmpegPkg = fs.readdirSync(pkgRoot).find((d) => d.startsWith("Gyan.FFmpeg"));
  if (!ffmpegPkg) {
    throw new Error("ffmpeg/ffprobe not found on PATH. Install ffmpeg (winget install ffmpeg) and try again.");
  }
  const buildDir = fs.readdirSync(path.join(pkgRoot, ffmpegPkg)).find((d) => d.startsWith("ffmpeg-"));
  const binDir = path.join(pkgRoot, ffmpegPkg, buildDir, "bin");
  if (!fs.existsSync(path.join(binDir, "ffmpeg.exe"))) {
    throw new Error(`Expected ffmpeg.exe under ${binDir} but didn't find it. Install ffmpeg (winget install ffmpeg) and try again.`);
  }
  process.env.PATH = `${binDir};${process.env.PATH}`;
  console.error(`(ffmpeg wasn't on PATH yet this session - using ${binDir})`);
}

// build_draft.js already refuses to run with a clear error while Jianying is open, but
// that's discovered only after classify+QA already ran (multi-minute jobs on real
// footage) - check up front so a closed-Jianying mistake costs seconds, not minutes.
function ensureJianyingClosed() {
  if (process.platform !== "win32") return;
  const result = spawnSync("tasklist", ["/FI", "IMAGENAME eq JianyingPro.exe", "/NH"], { encoding: "utf-8" });
  if (result.stdout && result.stdout.includes("JianyingPro.exe")) {
    throw new Error("JianyingPro is currently running. Close it, then run this again - capcut-cli refuses to write a draft while it's open.");
  }
}

function run(label, cmd, args) {
  console.error(`\n=== ${label} ===`);
  // No shell:true here - spawnSync handles a direct executable + array args correctly
  // on Windows without it, and shell:true would need every space-containing path
  // (e.g. process.execPath under "C:\Program Files\nodejs\") manually re-quoted, which
  // is exactly the footgun documented in jianying/build_draft.js.
  const result = spawnSync(cmd, args, { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`${label} failed (exit ${result.status})`);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const rawDir = path.resolve(args.raw);
  if (!fs.existsSync(rawDir) || !fs.statSync(rawDir).isDirectory()) {
    throw new Error(`--raw folder not found: ${rawDir}`);
  }
  const configPath = path.resolve(args.config || path.join(__dirname, "config", "rough_cut_config.json"));
  const draftName = args.draftName || path.basename(rawDir);

  const keepSegmentsPath = path.join(__dirname, "keep_segments.json");
  const qaPassedPath = path.join(__dirname, "keep_segments.qa-passed.json");

  ensureFfmpegOnPath();
  ensureJianyingClosed();

  const node = process.execPath;
  run("1/3 Classifying silence/voice", node, [
    path.join(__dirname, "silence_classifier", "classify.js"),
    "--config", configPath,
    "--raw-dir", rawDir,
    "--out", keepSegmentsPath,
  ]);

  run("2/3 QA pass", node, [
    path.join(__dirname, "silence_classifier", "qa_check.js"),
    "--keep-segments", keepSegmentsPath,
    "--config", configPath,
  ]);

  run(`3/3 Building Jianying draft "${draftName}"`, node, [
    path.join(__dirname, "jianying", "build_draft.js"),
    "--keep-segments", qaPassedPath,
    "--draft-name", draftName,
  ]);

  console.error(`\nDone. Restart Jianying (if it was already running) and open "${draftName}" to review and export.`);
}

main();
