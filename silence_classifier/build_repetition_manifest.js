#!/usr/bin/env node
// Mechanical half of the repetition-review workflow - mirrors
// jianying/subtitles/build_action_manifest.js's pattern (mechanical extraction
// -> Claude fills in judgment -> mechanical apply). Detects repeated/duplicate
// cue patterns in the currently-kept transcript and writes a manifest for
// Claude to classify directly, rather than trying to encode the judgment as
// rules.
//
// Repetition isn't a lexical property the way filler is - dialogue_filter.js's
// isMeaningfulCue can decide "啊" carries no content on its own, no context
// needed. But the SAME repeated-word shape can be a genuine stutter worth
// trimming, deliberate emphasis worth keeping ("对对对" = "yes yes yes", a
// completely normal way to express strong agreement in Chinese), onomatopoeia
// (“嘟嘟嘟” = a beeping sound - that's descriptive content, not noise), or
// laughter. A rules-only pass at this (see CLAUDE.md for the study) produced
// too many false positives/wrong calls to act on directly - a prefix/overlap
// heuristic that was tried and dropped flagged mostly normal speech
// continuing into more content, not real redundancy. This detects three
// patterns that turned out to have a clean, checkable signal:
//
//   exact_duplicate    - the same cue text appears 2+ times back-to-back in
//                        the kept transcript
//   intra_cue_repeat   - the same 1-3 character unit repeats 3+ times within
//                        ONE cue's text (digit runs like "2,000"'s "00" are
//                        excluded - that's number formatting, not a speech
//                        pattern)
//   isolated_quiet     - a short kept span (<=3s), acoustically quiet
//                        (RMS<=2.5% of full scale), surrounded by cut gaps of
//                        1.5s+ on both sides - a brief island of content with
//                        no surrounding conversation flow. Confirmed on real
//                        footage that this bucket splits cleanly: some have NO
//                        transcribed content at all (pure amplitude blips,
//                        <0.2s - safe to cut) while others carry real,
//                        substantive content despite being quiet and isolated
//                        (keep) - the acoustic signal alone can't tell those
//                        apart, same reasoning gap as the other two patterns.
//
// Safe to re-run against the same --out path across sessions: prior "cut"
// decisions are carried forward automatically (see loadPriorCutEntries) even
// though a fresh scan can no longer find their now-removed spans - losing
// that record would make qa_transcript_report.js's --repetition-manifest
// cross-check misreport already-applied, legitimate cuts as unexplained
// FLAGGED bugs (confirmed the hard way: overwriting mid-session made 28
// already-explained cuts reappear as flagged). "keep" decisions are NOT
// carried forward - only "cut" ones need to survive, since a "keep" that's
// still relevant gets rediscovered by the fresh scan anyway.
//
// Usage:
//   node silence_classifier/build_repetition_manifest.js --keep-segments keep_segments.json \
//     --dialogue-srt <raw-timeline SRT> --raw-timeline-map sources.json \
//     --out projects/<name>/repetition_manifest.json \
//     [--isolation-gap-s 1.5] [--max-duration-s 3] [--quiet-rms-pct 2.5]
//
// Then: Claude reads the manifest directly (Read tool) and fills in
// "decision" ("keep" or "cut") + "reason" for every entry, using the context
// field and its own judgment - this is deliberately not scripted. Past a few
// hundred entries, delegate to a handful of background Agents instead of
// holding it all in one session's context, same scale guidance as
// action-summary.
//
// Then: silence_classifier/apply_repetition_decisions.js applies every "cut".
import fs from "node:fs";
import path from "node:path";

import { parseSrtFile } from "../lib/srt.js";
import { loadPcmFloat32, VAD_SAMPLE_RATE } from "./extract_audio.js";
import { buildPieceBounds, findPieceIndex, indexBySourceClip, overlappingEntries, sourceClipKey } from "../lib/timeline.js";

const DIGIT_RUN_RE = /^[\d,.]+$/;
const REPEAT_RE = /(.{1,3})\1{2,}/u;

function parseArgs(argv) {
  const out = { isolationGapS: "1.5", maxDurationS: "3", quietRmsPct: "2.5" };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, "").replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    out[key] = argv[i + 1];
  }
  if (!out.keepSegments || !out.dialogueSrt || !out.rawTimelineMap || !out.out) {
    throw new Error(
      "Usage: build_repetition_manifest.js --keep-segments <path> --dialogue-srt <raw-timeline srt> " +
      "--raw-timeline-map <path> --out <path> [--isolation-gap-s 1.5] [--max-duration-s 3] [--quiet-rms-pct 2.5]"
    );
  }
  out.isolationGapS = Number(out.isolationGapS);
  out.maxDurationS = Number(out.maxDurationS);
  out.quietRmsPct = Number(out.quietRmsPct);
  return out;
}

// A "cut" decision's occurrences are gone from keep_segments.json once
// applied, so a fresh scan can never rediscover them - re-running this
// script from scratch would otherwise silently lose the historical record
// that qa_transcript_report.js's --repetition-manifest needs to tell "cut on
// purpose, already accounted for" apart from "genuinely unexplained,
// investigate this". Confirmed the hard way: overwriting the manifest
// mid-session made 28 already-explained deliberate cuts reappear as FLAGGED.
// "keep" decisions are NOT carried forward - if they're still relevant,
// fresh detection finds them again naturally (same text/pattern still
// present in the data); carrying them forward too would either duplicate a
// fresh finding or accumulate stale entries once the surrounding context
// has changed.
function loadPriorCutEntries(outPath) {
  if (!fs.existsSync(outPath)) return [];
  try {
    const prior = JSON.parse(fs.readFileSync(outPath, "utf-8"));
    return prior.filter((e) => e.decision === "cut");
  } catch {
    return []; // unreadable/corrupt prior manifest - don't block a fresh run over it
  }
}

function rmsPct(samples, sampleRate, startS, endS) {
  const startIdx = Math.max(0, Math.floor(startS * sampleRate));
  const endIdx = Math.min(samples.length, Math.ceil(endS * sampleRate));
  if (endIdx <= startIdx) return 0;
  let sumSq = 0;
  for (let i = startIdx; i < endIdx; i++) sumSq += samples[i] * samples[i];
  return Math.sqrt(sumSq / (endIdx - startIdx)) * 100;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  const clips = JSON.parse(fs.readFileSync(args.keepSegments, "utf-8"));
  const { pieces } = buildPieceBounds(clips);
  const keptBySource = indexBySourceClip(pieces);

  const { rawTimeline } = JSON.parse(fs.readFileSync(args.rawTimelineMap, "utf-8"));
  const cues = parseSrtFile(args.dialogueSrt);

  // Every currently-kept cue, in chronological cut-timeline order, with full
  // span info (not just text) - same span math as qa_transcript_report.js.
  const keptCues = [];
  cues.forEach((cue, i) => {
    const rawIdx = findPieceIndex(rawTimeline, cue.start);
    const rawSeg = rawTimeline[rawIdx];
    const srcStart = rawSeg.sourceStart + Math.max(0, cue.start - rawSeg.timelineStart);
    const srcEnd = rawSeg.sourceStart + Math.max(0, cue.end - rawSeg.timelineStart);
    const clipKey = sourceClipKey(rawSeg.sourceClip);
    const keptMatches = overlappingEntries(keptBySource.get(clipKey), srcStart, srcEnd);
    if (keptMatches.length === 0) return;
    const first = keptMatches[0], last = keptMatches[keptMatches.length - 1];
    keptCues.push({
      text: cue.text,
      clip: path.basename(rawSeg.sourceClip),
      srcStart, srcEnd,
      cutStart: first.entry.timelineStart + (first.overlapStart - first.entry.sourceStart),
      cutEnd: last.entry.timelineStart + (last.overlapEnd - last.entry.sourceStart),
      prevText: cues[i - 1]?.text ?? null,
      nextText: cues[i + 1]?.text ?? null,
    });
  });
  keptCues.sort((a, b) => a.cutStart - b.cutStart);

  // Carry forward prior "cut" decisions first (see loadPriorCutEntries) -
  // their ids get renumbered below along with everything else.
  const manifest = loadPriorCutEntries(args.out);
  const priorCarriedForward = manifest.length;
  let id = 1;

  // exact_duplicate: same text, back-to-back
  let i = 0;
  while (i < keptCues.length) {
    let j = i + 1;
    while (j < keptCues.length && keptCues[j].text === keptCues[i].text) j++;
    if (j - i >= 2) {
      manifest.push({
        id: id++,
        pattern: "exact_duplicate",
        text: keptCues[i].text,
        occurrences: keptCues.slice(i, j).map((c) => ({
          clip: c.clip, srcStart: c.srcStart, srcEnd: c.srcEnd, cutStart: c.cutStart, cutEnd: c.cutEnd,
        })),
        context: `...${keptCues[i].prevText ?? ""} [${keptCues[i].text} x${j - i}] ${keptCues[j - 1].nextText ?? ""}...`,
        decision: null,
        reason: null,
      });
    }
    i = j;
  }

  // intra_cue_repeat: same short unit repeated 3+ times within one cue
  for (const c of keptCues) {
    const m = c.text.match(REPEAT_RE);
    if (m && !DIGIT_RUN_RE.test(m[1])) {
      manifest.push({
        id: id++,
        pattern: "intra_cue_repeat",
        text: c.text,
        repeatedUnit: m[1],
        occurrences: [{ clip: c.clip, srcStart: c.srcStart, srcEnd: c.srcEnd, cutStart: c.cutStart, cutEnd: c.cutEnd }],
        context: `...${c.prevText ?? ""} [${c.text}] ${c.nextText ?? ""}...`,
        decision: null,
        reason: null,
      });
    }
  }

  // isolated_quiet: short, quiet, surrounded by cut gaps on both sides -
  // needs an audio decode per clip (the other two patterns are pure text).
  for (const clipEntry of clips) {
    const spans = clipEntry.keep_seconds;
    const { samples, sampleRate } = loadPcmFloat32(clipEntry.clip, VAD_SAMPLE_RATE);
    const clipName = path.basename(clipEntry.clip);
    const rawEntry = rawTimeline.find((e) => path.resolve(e.sourceClip) === path.resolve(clipEntry.clip));
    const rawOffset = rawEntry ? rawEntry.timelineStart - rawEntry.sourceStart : 0;

    for (let i = 0; i < spans.length; i++) {
      const [a, b] = spans[i];
      if (b - a > args.maxDurationS) continue;
      const gapBefore = i > 0 ? a - spans[i - 1][1] : Infinity;
      const gapAfter = i < spans.length - 1 ? spans[i + 1][0] - b : Infinity;
      if (gapBefore < args.isolationGapS || gapAfter < args.isolationGapS) continue;
      const rms = rmsPct(samples, sampleRate, a, b);
      if (rms > args.quietRmsPct) continue;

      const rawA = a + rawOffset, rawB = b + rawOffset;
      const overlappingCues = cues.filter((c) => c.start < rawB && c.end > rawA);
      const text = overlappingCues.length > 0 ? overlappingCues.map((c) => c.text).join(" / ") : "(no transcribed content)";
      const pieceMatches = overlappingEntries(keptBySource.get(sourceClipKey(clipEntry.clip)), a, b);
      const cutStart = pieceMatches.length > 0 ? pieceMatches[0].entry.timelineStart + (pieceMatches[0].overlapStart - pieceMatches[0].entry.sourceStart) : null;
      const cutEnd = pieceMatches.length > 0 ? pieceMatches[pieceMatches.length - 1].entry.timelineStart + (pieceMatches[pieceMatches.length - 1].overlapEnd - pieceMatches[pieceMatches.length - 1].entry.sourceStart) : null;

      manifest.push({
        id: id++,
        pattern: "isolated_quiet",
        text,
        rmsPct: +rms.toFixed(2),
        durationS: +(b - a).toFixed(2),
        gapBeforeS: gapBefore === Infinity ? null : +gapBefore.toFixed(2),
        gapAfterS: gapAfter === Infinity ? null : +gapAfter.toFixed(2),
        occurrences: [{ clip: clipName, srcStart: a, srcEnd: b, cutStart, cutEnd }],
        context: `isolated span, ${(b - a).toFixed(2)}s, RMS ${rms.toFixed(2)}%, gap before/after ${gapBefore === Infinity ? "clip start" : gapBefore.toFixed(1) + "s"}/${gapAfter === Infinity ? "clip end" : gapAfter.toFixed(1) + "s"}: "${text}"`,
        decision: null,
        reason: null,
      });
    }
  }

  manifest.sort((a, b) => (a.occurrences[0].cutStart ?? 0) - (b.occurrences[0].cutStart ?? 0));
  manifest.forEach((entry, idx) => { entry.id = idx + 1; }); // renumber - prior entries' old ids may collide with fresh ones

  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, JSON.stringify(manifest, null, 2), "utf-8");

  const freshCount = manifest.length - priorCarriedForward;
  const exactCount = manifest.filter((m) => m.pattern === "exact_duplicate" && m.decision !== "cut").length;
  const intraCount = manifest.filter((m) => m.pattern === "intra_cue_repeat" && m.decision !== "cut").length;
  const isolatedCount = manifest.filter((m) => m.pattern === "isolated_quiet" && m.decision !== "cut").length;
  console.error(`Wrote ${args.out} (${manifest.length} total entries: ${priorCarriedForward} prior "cut" decisions carried forward for the record, ${freshCount} fresh - of the fresh ones, ${exactCount} exact-duplicate groups, ${intraCount} intra-cue-repeat cues, ${isolatedCount} isolated-quiet spans still need a decision)`);
  console.error(`Next: read this file directly and fill in "decision" ("keep" or "cut") + "reason" for every entry with decision: null.`);
}

main();
