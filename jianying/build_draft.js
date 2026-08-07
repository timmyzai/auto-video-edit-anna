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
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DRAFT_FOLDER = path.join(
  os.homedir(), "AppData", "Local", "JianyingPro", "User Data", "Projects", "com.lveditor.draft"
);

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
  const draftFolder = args.draftFolder || DEFAULT_DRAFT_FOLDER;
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

  const capcutBin = path.join(__dirname, "..", "node_modules", ".bin", process.platform === "win32" ? "capcut.cmd" : "capcut");
  try {
    const result = execFileSync(capcutBin, ["compile", specPath, "--jianying", "--drafts", draftFolder, "-H"], {
      encoding: "utf-8",
      shell: true,
    });
    console.error(result);
  } finally {
    fs.rmSync(specPath, { force: true });
  }

  console.error(`\nSaved draft '${args.draftName}' in ${draftFolder}`);
  console.error(`${totalSegments} segments, ${cumulative.toFixed(2)}s total. Open Jianying to preview before exporting.`);
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

main();
