#!/usr/bin/env node
// Mechanical half of the consolidated semantic-review workflow - enumerates
// every currently-kept meaningful dialogue cue (after classify.js's amplitude/
// VAD pass AND after apply_filler_exclusions.js/apply_repetition_decisions.js
// have already run, so keep_segments.json already reflects every mechanical
// decision) into one flat manifest for Claude to judge directly, rather than
// a scripted classifier attempting INCLUDE/EXCLUDE/REVIEW judgment itself.
//
// Deliberately ONE manifest, not chunked, by default - see CLAUDE.md's
// "Semantic review" section for why the old semantic_review_chunk_*.json
// approach (splitting a transcript into N overlapping pieces, each read by a
// separate agent) was retired as the default: most projects' full dialogue
// transcript fits comfortably in a single Sonnet turn, and each chunk/agent
// pays its own cold-start context tax regardless of the chunk's actual size -
// for a small-to-medium transcript, chunking costs MORE total tokens than one
// pass, not less. This script prints the manifest's total entry count and
// character count on write specifically so Claude can judge, case by case,
// whether a given transcript is "genuinely too large" for one pass - there is
// no hardcoded cue-count/char-count threshold here. If a transcript really is
// too large, the fallback is the same manual, ad hoc split Claude already did
// before this script existed (read the manifest, split it by hand into a
// couple of Read/Write passes or background Agents) - not new code, since
// baking in an arbitrary number now would be guessing, not measuring.
//
// Safe to re-run: any entry already decided (category/decision/reason all
// filled, for ANY of "include"/"exclude"/"review") is carried forward by cue
// identity (clip + rounded source-relative start/end) rather than being
// regenerated from scratch. Unlike build_repetition_manifest.js's mechanical
// detectors (cheap to redo, so only "cut" is worth persisting there), a
// semantic judgment from Claude is NOT cheap to reproduce - losing an
// "include" decision on every re-run would mean re-paying for it every time
// keep_segments.json changes for an unrelated reason. Only genuinely new cues
// (not present in the prior manifest under this key) get decision: null.
//
// Usage:
//   node silence_classifier/build_semantic_review_manifest.js --keep-segments keep_segments.json \
//     --dialogue-srt <raw-timeline srt> --raw-timeline-map sources.json \
//     --out projects/<name>/semantic_review.json
//
// Then: Claude reads this file directly (Read tool) and fills in "category"
// (a short free-text label - e.g. "false_start", "correction", "mistake",
// "irrelevant_chat", "production_speech", "continuity_context", or anything
// else that actually describes the cue - not a fixed enum) + "decision"
// ("include" | "exclude" | "review") + "reason" for every entry with
// decision: null, using the "context" field and its own judgment. REVIEW
// means genuinely uncertain - never auto-cut, see apply_semantic_decisions.js.
//
// Then: silence_classifier/apply_semantic_decisions.js applies every "exclude".
import fs from "node:fs";
import path from "node:path";

import { parseSrtFile } from "../lib/srt.js";
import { isMeaningfulCue } from "./dialogue_filter.js";
import { buildPieceBounds, indexBySourceClip, findPieceIndex, overlappingEntries, sourceClipKey } from "../lib/timeline.js";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, "").replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    out[key] = argv[i + 1];
  }
  if (!out.keepSegments || !out.dialogueSrt || !out.rawTimelineMap || !out.out) {
    throw new Error(
      "Usage: build_semantic_review_manifest.js --keep-segments <path> --dialogue-srt <raw-timeline srt> " +
      "--raw-timeline-map <path> --out <path>"
    );
  }
  return out;
}

// Rounded to match the millisecond precision keep_segments.json itself
// already stores (classify.js rounds to 3 decimals) - stable across re-runs
// of this script as long as the underlying span didn't actually change.
function cueKey(clip, srcStart, srcEnd) {
  return `${clip}|${srcStart.toFixed(3)}|${srcEnd.toFixed(3)}`;
}

function loadPriorDecided(outPath) {
  if (!fs.existsSync(outPath)) return new Map();
  let prior;
  try {
    prior = JSON.parse(fs.readFileSync(outPath, "utf-8"));
  } catch {
    return new Map(); // unreadable/corrupt prior manifest - don't block a fresh run over it
  }
  const byKey = new Map();
  for (const entry of prior) {
    if (entry.decision === null || entry.decision === undefined) continue;
    byKey.set(cueKey(entry.clip, entry.srcStart, entry.srcEnd), entry);
  }
  return byKey;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  const clips = JSON.parse(fs.readFileSync(args.keepSegments, "utf-8"));
  const { pieces } = buildPieceBounds(clips);
  const keptBySource = indexBySourceClip(pieces);

  const { rawTimeline } = JSON.parse(fs.readFileSync(args.rawTimelineMap, "utf-8"));
  const cues = parseSrtFile(args.dialogueSrt);

  const priorDecided = loadPriorDecided(args.out);

  const manifest = [];
  let carriedForward = 0;

  cues.forEach((cue, i) => {
    if (!isMeaningfulCue(cue.text)) return;
    const rawIdx = findPieceIndex(rawTimeline, cue.start);
    const rawSeg = rawTimeline[rawIdx];
    const srcStart = rawSeg.sourceStart + Math.max(0, cue.start - rawSeg.timelineStart);
    const srcEnd = rawSeg.sourceStart + Math.max(0, cue.end - rawSeg.timelineStart);
    const clipKey = sourceClipKey(rawSeg.sourceClip);
    const clipName = path.basename(rawSeg.sourceClip);

    const keptMatches = overlappingEntries(keptBySource.get(clipKey), srcStart, srcEnd);
    if (keptMatches.length === 0) return; // already cut by an earlier deterministic pass - nothing to judge

    const first = keptMatches[0], last = keptMatches[keptMatches.length - 1];
    const cutStart = first.entry.timelineStart + (first.overlapStart - first.entry.sourceStart);
    const cutEnd = last.entry.timelineStart + (last.overlapEnd - last.entry.sourceStart);
    const context = `...${cues[i - 1]?.text ?? ""} [${cue.text}] ${cues[i + 1]?.text ?? ""}...`;

    const key = cueKey(clipName, srcStart, srcEnd);
    const prior = priorDecided.get(key);
    if (prior) {
      manifest.push({ ...prior, id: 0, clip: clipName, srcStart, srcEnd, cutStart, cutEnd, text: cue.text, context });
      carriedForward++;
    } else {
      manifest.push({
        id: 0,
        text: cue.text,
        clip: clipName,
        srcStart, srcEnd, cutStart, cutEnd,
        context,
        category: null,
        decision: null,
        reason: null,
      });
    }
  });

  manifest.sort((a, b) => a.cutStart - b.cutStart);
  manifest.forEach((entry, idx) => { entry.id = idx + 1; }); // renumber - prior entries' old ids may collide with fresh ones

  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, JSON.stringify(manifest, null, 2), "utf-8");

  const freshCount = manifest.length - carriedForward;
  const totalChars = manifest.reduce((s, e) => s + e.text.length, 0);
  console.error(
    `Wrote ${args.out} (${manifest.length} kept meaningful cue(s): ${carriedForward} already decided and carried ` +
    `forward, ${freshCount} fresh - need a decision). Manifest text totals ${totalChars} character(s).`
  );
  if (freshCount > 0) {
    console.error(
      `Next: read this file directly and fill in "category" + "decision" ("include"|"exclude"|"review") + "reason" ` +
      `for every entry with decision: null. Use judgment on whether ${freshCount} fresh entries / ${totalChars} ` +
      `characters is small enough for one pass (usually yes) or genuinely needs a manual split.`
    );
  } else {
    console.error("Nothing new to decide - every kept meaningful cue already has a carried-forward decision.");
  }
}

main();
