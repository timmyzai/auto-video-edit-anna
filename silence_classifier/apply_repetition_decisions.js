#!/usr/bin/env node
// Mechanical apply half of the repetition-review workflow - takes a manifest
// Claude has filled in (decision: "keep"|"cut" per entry, from
// build_repetition_manifest.js) and removes the "cut" spans from
// keep_segments.json's keep_seconds.
//
// For exact_duplicate AND paraphrase_repeat, "cut" keeps the FIRST occurrence
// and removes the rest - never drops every occurrence of something that was
// actually said, since the point of this whole pipeline is never silently
// losing content entirely. Trimming a redundant repeat down to one instance
// is an edit; deleting the moment happened at all is not what "cut" means
// here. paraphrase_repeat entries (same claim restated in different words,
// not literally identical text - see build_repetition_manifest.js's
// detectParaphraseCandidates) get the identical treatment because the
// underlying edit decision is the same: multiple distinct-worded cues
// asserting one fact, only the first needs to survive.
// For intra_cue_repeat, "cut" removes that cue's entire kept span - there's
// no sub-cue-level word timing in an SRT to trim just the repeated portion
// out of the middle of one cue.
//
// --dialogue-srt/--raw-timeline-map are optional: when both are given, a
// second pass prunes any near-zero-duration sliver that subtractSpan leaves
// stranded at the edge of a kept piece (its cut boundary lands a hair short
// of the piece's own edge) and that overlaps no meaningful dialogue cue -
// these never went through classify.js's min_segment_duration_ms floor,
// since that only ran once, at classify-time, before any of these cuts
// existed. Confirmed on real footage: 98 such slivers (14.1s, mostly
// under 0.15s each, RMS near 0%) survived a round of repetition/paraphrase
// cuts undetected until an explicit RMS scan found them. Omit both flags to
// skip this pass entirely (unchanged behavior, e.g. for a project with no
// dialogue SRT).
//
// Usage:
//   node silence_classifier/apply_repetition_decisions.js --manifest repetition_manifest.json \
//     --keep-segments keep_segments.json --out keep_segments.json \
//     [--dialogue-srt <raw-timeline srt> --raw-timeline-map sources.json --min-segment-duration-ms 1200]
import fs from "node:fs";
import path from "node:path";

import { parseSrtFile } from "../lib/srt.js";
import { meaningfulCueSourceSpans } from "./dialogue_filter.js";
import { filterShortSpans } from "./classify.js";
import { subtractSpan, sourceClipKey } from "../lib/timeline.js";

function parseArgs(argv) {
  const out = { minSegmentDurationMs: "1200" };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, "").replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    out[key] = argv[i + 1];
  }
  if (!out.manifest || !out.keepSegments || !out.out) {
    throw new Error(
      "Usage: apply_repetition_decisions.js --manifest <path> --keep-segments <path> --out <path> " +
      "[--dialogue-srt <raw-timeline srt> --raw-timeline-map <path> --min-segment-duration-ms 1200]"
    );
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(fs.readFileSync(args.manifest, "utf-8"));
  const clips = JSON.parse(fs.readFileSync(args.keepSegments, "utf-8"));

  const unclassified = manifest.filter((m) => m.decision !== "keep" && m.decision !== "cut");
  if (unclassified.length > 0) {
    throw new Error(
      `${unclassified.length} manifest entries have no valid decision ("keep" or "cut") - ` +
      `classify all of them before applying. First unclassified: id ${unclassified[0].id} ("${unclassified[0].text}").`
    );
  }

  let cutCount = 0, cutDurationS = 0, keptCount = 0;
  for (const entry of manifest) {
    if (entry.decision !== "cut") {
      keptCount++;
      continue;
    }
    const keepsFirstOnly = entry.pattern === "exact_duplicate" || entry.pattern === "paraphrase_repeat";
    const toCut = keepsFirstOnly ? entry.occurrences.slice(1) : entry.occurrences;
    for (const occ of toCut) {
      const clip = clips.find((c) => path.basename(c.clip) === occ.clip);
      if (!clip) {
        console.error(`WARNING: clip "${occ.clip}" (manifest id ${entry.id}) not found in ${args.keepSegments} - skipping, keep_segments.json may be stale relative to this manifest.`);
        continue;
      }
      clip.keep_seconds = subtractSpan(clip.keep_seconds, occ.srcStart, occ.srcEnd);
      cutCount++;
      cutDurationS += occ.srcEnd - occ.srcStart;
    }
  }

  if (args.dialogueSrt && args.rawTimelineMap) {
    const { rawTimeline } = JSON.parse(fs.readFileSync(args.rawTimelineMap, "utf-8"));
    const cues = parseSrtFile(args.dialogueSrt);
    const minDurationS = Number(args.minSegmentDurationMs) / 1000;

    const protectedByClip = new Map();
    for (const c of meaningfulCueSourceSpans(cues, rawTimeline)) {
      const key = sourceClipKey(c.sourceClip);
      if (!protectedByClip.has(key)) protectedByClip.set(key, []);
      protectedByClip.get(key).push([c.sourceStart, c.sourceEnd]);
    }
    let sliverCount = 0, sliverDurationS = 0;
    for (const clip of clips) {
      const before = clip.keep_seconds;
      const after = filterShortSpans(before, minDurationS, protectedByClip.get(sourceClipKey(clip.clip)) || []);
      sliverCount += before.length - after.length;
      sliverDurationS += before.reduce((s, [a, b]) => s + (b - a), 0) - after.reduce((s, [a, b]) => s + (b - a), 0);
      clip.keep_seconds = after;
    }
    if (sliverCount > 0) {
      console.error(`Pruned ${sliverCount} sub-${minDurationS}s unprotected sliver(s) left over from the cuts above (${sliverDurationS.toFixed(2)}s).`);
    }
  }

  fs.writeFileSync(args.out, JSON.stringify(clips, null, 2), "utf-8");
  console.error(`Applied ${cutCount} cut(s) (${cutDurationS.toFixed(1)}s removed), kept ${keptCount} entries as-is. Wrote ${args.out}.`);
}

main();
