#!/usr/bin/env node
// Builds the action-caption manifest: one entry per kept span with an
// extracted representative frame + the dialogue text overlapping that span
// (for caption context - see subtitles/PIPELINE_PLAN.md for why action
// captions need to be dialogue-driven, not just visual). Captions themselves
// are filled in afterward directly by the Claude Code session reading each
// entry's frame + transcript excerpt (or, at large span counts, a handful of
// background Agents) - this script only does the mechanical part.
//
// Takes a cut-timeline-timed dialogue SRT directly (whatever the user
// exported from Jianying's own auto-caption re-run on the cut sequence,
// since dialogue export/translate/reimport is a manual step now - see
// CLAUDE.md's "Subtitles" section) - no remapping needed here, unlike the
// earlier design this replaces (subtitles/generate_subtitles.js), which took
// a raw Whisper transcript and had to do its own timeline math.
//
// Usage:
//   node subtitles/build_action_manifest.js --keep-segments keep_segments.json \
//     --dialogue-srt <cut-timeline srt> --out caption_manifest.json \
//     --frames-dir caption_frames
import fs from "node:fs";
import path from "node:path";
import ora from "ora";

import { parseSrtFile } from "../../lib/srt.js";
import { buildPieceBounds } from "../../lib/timeline.js";
import { buildCaptionManifest } from "./build_caption_manifest.js";

function parseArgs(argv) {
  const out = {
    out: "caption_manifest.json",
    framesDir: "caption_frames",
  };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, "").replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    out[key] = argv[i + 1];
  }
  if (!out.keepSegments || !out.dialogueSrt) {
    throw new Error(
      "Usage: build_action_manifest.js --keep-segments <path> --dialogue-srt <cut-timeline srt> " +
      "[--out <path>] [--frames-dir <dir>]"
    );
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const clips = JSON.parse(fs.readFileSync(args.keepSegments, "utf-8"));
  if (clips.length === 0) throw new Error(`No clips found in ${args.keepSegments}`);

  const { pieces, totalSeconds } = buildPieceBounds(clips);
  console.error(`Timeline: ${totalSeconds.toFixed(1)}s across ${pieces.length} kept spans.`);

  const cues = fs.existsSync(args.dialogueSrt) ? parseSrtFile(args.dialogueSrt) : [];
  console.error(`${cues.length} dialogue cues loaded from ${args.dialogueSrt}.`);

  const spinner = ora(`Building caption manifest for ${pieces.length} spans...`).start();
  const manifest = await buildCaptionManifest(pieces, cues, args.framesDir, {
    onProgress: (done, total) => {
      spinner.text = `Extracting frames... ${done}/${total}`;
    },
  });
  spinner.succeed(`Manifest built (${manifest.length} spans, frames in ${args.framesDir}).`);

  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, JSON.stringify(manifest, null, 2), "utf-8");
  console.error(`Wrote ${args.out}`);
  console.error(
    `Next: read each entry's "framePath" (+ "transcriptExcerpt" for context) and fill in "caption" ` +
    `directly (few-shot primed on real after.mp4-style captions), then run manifest_to_srt.js.`
  );
}

main().catch((err) => {
  console.error(err.stack || err.message || err);
  process.exitCode = 1;
});
