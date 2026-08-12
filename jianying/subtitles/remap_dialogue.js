#!/usr/bin/env node
// Mechanical, no AI: remaps meaningful dialogue cues from the raw (pre-cut)
// timeline onto the final cut timeline, using the same content-aware
// meaningfulness filter classify.js already applied when deciding what to
// keep (silence_classifier/dialogue_filter.js) - so what lands in the final
// dialogue track is exactly consistent with what was kept, by construction.
// Filler-only cues are dropped, not carried forward.
//
// Safe by construction: every meaningful cue's raw-timeline span was unioned
// into keep_segments.json's underlying keep-spans back in classify.js, so it
// should always land inside some kept piece - this script's job is finding
// which one(s) and computing the new position, not deciding what survives.
// A cue that unexpectedly doesn't match any kept piece gets a loud warning,
// not a silent drop - silent data loss here is exactly what this feature
// exists to prevent.
//
// Usage:
//   node subtitles/remap_dialogue.js --keep-segments keep_segments.json \
//     --dialogue-srt <cleaned raw-timeline SRT> \
//     --raw-timeline-map <path, from list_draft_sources.js's stdout> \
//     --out output/dialogue_final.srt
import fs from "node:fs";

import { parseSrtFile, writeSrtFile } from "../../lib/srt.js";
import { buildPieceBounds } from "../../lib/timeline.js";
import { meaningfulCueSourceSpans } from "../../silence_classifier/dialogue_filter.js";

function parseArgs(argv) {
  const out = { out: "output/dialogue_final.srt" };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, "").replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    out[key] = argv[i + 1];
  }
  if (!out.keepSegments || !out.dialogueSrt || !out.rawTimelineMap) {
    throw new Error(
      "Usage: remap_dialogue.js --keep-segments <path> --dialogue-srt <raw-timeline srt> " +
      "--raw-timeline-map <path> [--out <path>]"
    );
  }
  return out;
}

// Groups cut-timeline `pieces` (from lib/timeline.js's buildPieceBounds) by
// sourceClip, sorted by sourceStart, so a (sourceClip, sourceRelativeTime)
// range can be matched against the right kept piece(s) directly instead of a
// global linear scan. Pieces for one clip are NOT necessarily contiguous in
// source time (that's the whole point of cutting), so this can't reuse
// lib/timeline.js's findPieceIndex, which assumes one global sorted timeline.
function indexPiecesBySource(pieces) {
  const bySource = new Map();
  for (const piece of pieces) {
    if (!bySource.has(piece.sourceClip)) bySource.set(piece.sourceClip, []);
    bySource.get(piece.sourceClip).push(piece);
  }
  for (const arr of bySource.values()) arr.sort((a, b) => a.sourceStart - b.sourceStart);
  return bySource;
}

// Finds every kept piece overlapping [chunkStart, chunkEnd) for a clip - a
// meaningful chunk normally lands entirely within one piece (its full span
// was unioned into the keep-spans before merge/pad in classify.js, so
// mergeSpans should have folded it into one contiguous span), but this
// doesn't assume that - it returns every overlapping piece so a chunk that
// somehow still straddles two kept pieces still produces cues for all of it,
// rather than silently dropping the part outside whichever piece was found
// first.
function overlappingPieces(clipPieces, chunkStart, chunkEnd) {
  if (!clipPieces) return [];
  return clipPieces
    .map((piece) => ({
      piece,
      overlapStart: Math.max(piece.sourceStart, chunkStart),
      overlapEnd: Math.min(piece.sourceEnd, chunkEnd),
    }))
    .filter(({ overlapStart, overlapEnd }) => overlapEnd > overlapStart);
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  const clips = JSON.parse(fs.readFileSync(args.keepSegments, "utf-8"));
  const { pieces } = buildPieceBounds(clips);
  const piecesBySource = indexPiecesBySource(pieces);

  const { rawTimeline } = JSON.parse(fs.readFileSync(args.rawTimelineMap, "utf-8"));
  const dialogueCues = parseSrtFile(args.dialogueSrt);
  const meaningfulChunks = meaningfulCueSourceSpans(dialogueCues, rawTimeline);

  const outCues = [];
  let unmatched = 0;

  for (const chunk of meaningfulChunks) {
    const clipPieces = piecesBySource.get(chunk.sourceClip);
    const matches = overlappingPieces(clipPieces, chunk.sourceStart, chunk.sourceEnd);
    if (matches.length === 0) {
      unmatched++;
      console.error(
        `WARNING: meaningful cue "${dialogueCues[chunk.cueIndex].text}" ` +
        `(${chunk.sourceClip}@${chunk.sourceStart.toFixed(2)}-${chunk.sourceEnd.toFixed(2)}s) ` +
        `didn't land inside any kept piece - this shouldn't happen if classify.js was run with the same ` +
        `--dialogue-srt/--raw-timeline-map. Dropped from the final dialogue track.`
      );
      continue;
    }
    for (const { piece, overlapStart, overlapEnd } of matches) {
      outCues.push({
        start: piece.timelineStart + (overlapStart - piece.sourceStart),
        end: piece.timelineStart + (overlapEnd - piece.sourceStart),
        text: dialogueCues[chunk.cueIndex].text,
      });
    }
  }

  outCues.sort((a, b) => a.start - b.start);

  writeSrtFile(outCues, args.out);
  console.error(
    `Wrote ${outCues.length} dialogue cues to ${args.out} ` +
    `(${dialogueCues.length} raw cues in, ${dialogueCues.length - meaningfulChunks.length ? "some" : "none"} filtered as filler, ${unmatched} unmatched).`
  );
}

main();
