#!/usr/bin/env node
// Applies every filler-only cue currently kept (dialogue_filter.js's
// isMeaningfulCue) as a cut directly against keep_segments.json - the same
// spans qa_transcript_report.js lists under excluded_review.txt's
// "Candidates to exclude" section.
//
// Unlike the repetition workflow (build_repetition_manifest.js /
// apply_repetition_decisions.js), this is mechanical, not a judgment call:
// isMeaningfulCue already decided these carry no lexical content (see its
// own header for what counts as filler and why single CJK characters aren't
// automatically included), and that classification has been directly
// verified against this project's real transcript multiple times. There's
// nothing left to review case-by-case - if you want to keep a specific
// filler occurrence anyway (e.g. for comedic timing), remove that line from
// excluded_review.txt's exclude-candidates section before running this, or
// just don't run this and cut selectively by hand.
//
// Usage:
//   node silence_classifier/apply_filler_exclusions.js --keep-segments keep_segments.json \
//     --dialogue-srt <raw-timeline SRT> --raw-timeline-map sources.json \
//     --out keep_segments.json
import fs from "node:fs";

import { parseSrtFile } from "../lib/srt.js";
import { isMeaningfulCue, meaningfulCueSourceSpans } from "./dialogue_filter.js";
import { filterShortSpans } from "./classify.js";
import { buildPieceBounds, findPieceIndex, indexBySourceClip, overlappingEntries, sourceClipKey, subtractSpan } from "../lib/timeline.js";

const MIN_SEGMENT_DURATION_S = 1.2; // matches config's default min_segment_duration_ms

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, "").replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    out[key] = argv[i + 1];
  }
  if (!out.keepSegments || !out.dialogueSrt || !out.rawTimelineMap || !out.out) {
    throw new Error(
      "Usage: apply_filler_exclusions.js --keep-segments <path> --dialogue-srt <raw-timeline srt> " +
      "--raw-timeline-map <path> --out <path>"
    );
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  const clips = JSON.parse(fs.readFileSync(args.keepSegments, "utf-8"));
  const { pieces } = buildPieceBounds(clips);
  const keptBySource = indexBySourceClip(pieces);
  const clipsByKey = new Map(clips.map((c) => [sourceClipKey(c.clip), c]));

  const { rawTimeline } = JSON.parse(fs.readFileSync(args.rawTimelineMap, "utf-8"));
  const cues = parseSrtFile(args.dialogueSrt);

  let cutCount = 0, cutDurationS = 0;
  const textCounts = new Map();

  for (const cue of cues) {
    if (isMeaningfulCue(cue.text)) continue;
    const rawIdx = findPieceIndex(rawTimeline, cue.start);
    const rawSeg = rawTimeline[rawIdx];
    const srcStart = rawSeg.sourceStart + Math.max(0, cue.start - rawSeg.timelineStart);
    const srcEnd = rawSeg.sourceStart + Math.max(0, cue.end - rawSeg.timelineStart);
    const clipKey = sourceClipKey(rawSeg.sourceClip);
    const clip = clipsByKey.get(clipKey);
    if (!clip) continue;

    const matches = overlappingEntries(keptBySource.get(clipKey), srcStart, srcEnd);
    for (const { overlapStart, overlapEnd } of matches) {
      clip.keep_seconds = subtractSpan(clip.keep_seconds, overlapStart, overlapEnd);
      cutCount++;
      cutDurationS += overlapEnd - overlapStart;
      textCounts.set(cue.text, (textCounts.get(cue.text) ?? 0) + 1);
    }
  }

  // subtractSpan can leave a near-zero-duration sliver stranded at the edge
  // of a kept piece when a cut's boundary lands a hair short of the piece's
  // own edge - these never went through classify.js's min_segment_duration_ms
  // floor (that only ran once, at classify-time, before any of these cuts
  // existed), so they'd otherwise sit in keep_segments.json as literal
  // fractions of a second of near-silence forever. Safe to re-prune here:
  // any span still overlapping a meaningful cue is protected exactly as it
  // was during the original classify.js filter, so this only ever removes
  // artifacts, never content.
  const protectedByClip = new Map();
  for (const c of meaningfulCueSourceSpans(cues, rawTimeline)) {
    const key = sourceClipKey(c.sourceClip);
    if (!protectedByClip.has(key)) protectedByClip.set(key, []);
    protectedByClip.get(key).push([c.sourceStart, c.sourceEnd]);
  }
  let sliverCount = 0, sliverDurationS = 0;
  for (const clip of clips) {
    const before = clip.keep_seconds;
    const after = filterShortSpans(before, MIN_SEGMENT_DURATION_S, protectedByClip.get(sourceClipKey(clip.clip)) || []);
    sliverCount += before.length - after.length;
    sliverDurationS += before.reduce((s, [a, b]) => s + (b - a), 0) - after.reduce((s, [a, b]) => s + (b - a), 0);
    clip.keep_seconds = after;
  }

  fs.writeFileSync(args.out, JSON.stringify(clips, null, 2), "utf-8");

  const byText = [...textCounts.entries()].sort((a, b) => b[1] - a[1]);
  console.error(`Cut ${cutCount} filler occurrence(s) (${cutDurationS.toFixed(1)}s removed) across ${byText.length} distinct word(s)/sound(s):`);
  for (const [text, count] of byText) console.error(`  "${text}" x${count}`);
  if (sliverCount > 0) {
    console.error(`Pruned ${sliverCount} sub-${MIN_SEGMENT_DURATION_S}s unprotected sliver(s) left over from the cuts above (${sliverDurationS.toFixed(2)}s).`);
  }
  console.error(`Wrote ${args.out}.`);
}

main();
