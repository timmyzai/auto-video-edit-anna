#!/usr/bin/env node
// Mechanical apply half of the consolidated semantic-review workflow - takes
// a manifest Claude has filled in (category/decision/reason per entry, from
// build_semantic_review_manifest.js) and applies it to keep_segments.json.
//
// Only three decision values are valid, matching the workflow's three states:
//   "include" - no-op, the cue stays exactly as already kept.
//   "exclude" - cut: the entry's single span is removed from keep_seconds.
//   "review"  - NEVER cut. Left in keep_segments.json untouched. The
//               manifest itself (any entry with decision: "review") IS the
//               review list - no separate output file, so there's nothing
//               that can drift out of sync with it.
// Unlike apply_repetition_decisions.js's exact_duplicate/paraphrase_repeat
// patterns, every entry here is exactly one cue / one span - there's no
// "keep the first occurrence, cut the rest" concept to special-case.
//
// --dialogue-srt/--raw-timeline-map are optional, same as
// apply_repetition_decisions.js and apply_filler_exclusions.js: when given, a
// second pass prunes any near-zero-duration sliver left stranded at the edge
// of a kept piece by the excludes above (see those scripts' own header
// comments for why this class of artifact exists and why it's safe to
// auto-prune - identical mechanism here, just triggered by this script's own
// cuts instead of repetition/filler ones).
//
// Usage:
//   node silence_classifier/apply_semantic_decisions.js --manifest semantic_review.json \
//     --keep-segments keep_segments.json --out keep_segments.json \
//     [--dialogue-srt <raw-timeline srt> --raw-timeline-map sources.json --min-segment-duration-ms 1200]
import fs from "node:fs";
import path from "node:path";

import { parseSrtFile } from "../lib/srt.js";
import { meaningfulCueSourceSpans } from "./dialogue_filter.js";
import { filterShortSpans } from "./classify.js";
import { subtractSpan, sourceClipKey } from "../lib/timeline.js";

const VALID_DECISIONS = new Set(["include", "exclude", "review"]);

function parseArgs(argv) {
  const out = { minSegmentDurationMs: "1200" };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, "").replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    out[key] = argv[i + 1];
  }
  if (!out.manifest || !out.keepSegments || !out.out) {
    throw new Error(
      "Usage: apply_semantic_decisions.js --manifest <path> --keep-segments <path> --out <path> " +
      "[--dialogue-srt <raw-timeline srt> --raw-timeline-map <path> --min-segment-duration-ms 1200]"
    );
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(fs.readFileSync(args.manifest, "utf-8"));
  const clips = JSON.parse(fs.readFileSync(args.keepSegments, "utf-8"));

  const invalid = manifest.filter((m) => !VALID_DECISIONS.has(m.decision));
  if (invalid.length > 0) {
    throw new Error(
      `${invalid.length} manifest entries have no valid decision ("include"|"exclude"|"review") - ` +
      `classify all of them before applying. First invalid: id ${invalid[0].id} ("${invalid[0].text}").`
    );
  }

  let excludeCount = 0, excludeDurationS = 0, includeCount = 0;
  const reviewEntries = [];

  for (const entry of manifest) {
    if (entry.decision === "include") {
      includeCount++;
      continue;
    }
    if (entry.decision === "review") {
      reviewEntries.push(entry);
      continue;
    }
    const clip = clips.find((c) => path.basename(c.clip) === entry.clip);
    if (!clip) {
      console.error(`WARNING: clip "${entry.clip}" (manifest id ${entry.id}) not found in ${args.keepSegments} - skipping, keep_segments.json may be stale relative to this manifest.`);
      continue;
    }
    clip.keep_seconds = subtractSpan(clip.keep_seconds, entry.srcStart, entry.srcEnd);
    excludeCount++;
    excludeDurationS += entry.srcEnd - entry.srcStart;
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
      console.error(`Pruned ${sliverCount} sub-${minDurationS}s unprotected sliver(s) left over from the excludes above (${sliverDurationS.toFixed(2)}s).`);
    }
  }

  fs.writeFileSync(args.out, JSON.stringify(clips, null, 2), "utf-8");
  console.error(`Excluded ${excludeCount} cue(s) (${excludeDurationS.toFixed(1)}s removed), included ${includeCount} as-is. Wrote ${args.out}.`);

  if (reviewEntries.length > 0) {
    console.error(`\n${reviewEntries.length} entries marked REVIEW - left in the cut untouched, not auto-excluded:`);
    for (const r of reviewEntries) {
      console.error(`  [${r.clip} @ ${r.srcStart.toFixed(2)}-${r.srcEnd.toFixed(2)}s] "${r.text}" - ${r.reason ?? "(no reason given)"}`);
    }
    console.error(`See "${args.manifest}" (entries with decision: "review") for the full list with context.`);
  }
}

main();
