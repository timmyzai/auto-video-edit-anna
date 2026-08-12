#!/usr/bin/env node
// Mechanical, no AI: turns a filled caption manifest (subtitles/build_action_manifest.js's
// output, with "caption" filled in per subtitles/PIPELINE_PLAN.md) into a
// single-line-per-cue SRT - one cue per kept span, timed to that span's
// position on the cut timeline. This is its own, separate text track
// (imported via jianying/add_subtitles.js with a distinct track name) rather
// than merged with dialogue - dialogue is its own track already, imported
// manually by the user, matching how the after.mp4 reference actually
// renders (two independent caption tracks, not one merged two-line box).
// Supersedes subtitles/merge_captions.js's two-line-merge design.
//
// Usage:
//   node subtitles/manifest_to_srt.js --keep-segments keep_segments.json \
//     --manifest caption_manifest.json --out action_captions.srt
import fs from "node:fs";

import { buildPieceBounds } from "../../lib/timeline.js";
import { writeSrtFile } from "../../lib/srt.js";

function parseArgs(argv) {
  const out = { out: "action_captions.srt" };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, "").replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    out[key] = argv[i + 1];
  }
  if (!out.keepSegments || !out.manifest) {
    throw new Error(
      "Usage: manifest_to_srt.js --keep-segments <path> --manifest <caption_manifest.json> [--out <path>]"
    );
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const clips = JSON.parse(fs.readFileSync(args.keepSegments, "utf-8"));
  const { pieces } = buildPieceBounds(clips);

  const manifest = JSON.parse(fs.readFileSync(args.manifest, "utf-8"));
  const captionByPieceIdx = new Map(manifest.map((m) => [m.pieceIdx, m.caption]));

  let blank = 0;
  const cues = pieces
    .map((piece) => {
      const caption = captionByPieceIdx.get(piece.pieceIdx) || "";
      if (!caption) blank++;
      return { start: piece.timelineStart, end: piece.timelineEnd, text: caption };
    })
    .filter((cue) => cue.text); // no empty SRT cues - a blank caption just means no text track entry for that span

  writeSrtFile(cues, args.out);
  console.error(`Wrote ${cues.length} action-caption cues to ${args.out}.`);
  if (blank > 0) {
    console.error(`(${blank}/${pieces.length} spans have no caption - left out of the SRT rather than emitted blank.)`);
  }
}

main();
