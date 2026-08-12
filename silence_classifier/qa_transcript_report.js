#!/usr/bin/env node
// Transcript-aware QA pass over keep_segments.json, run BEFORE insert_rough_cut.js
// so a human (or Claude) can review/adjust the actual cut decision, not just the
// result. Exactly two files, named for what they mean, not for the mechanism:
//
//   excluded_review.txt - candidates to CUT: filler-only cues (dialogue_filter.js's
//                  isMeaningfulCue - non-lexical interjections only, see its own
//                  header for why single-character CJK words are NOT automatically
//                  filler) that are currently kept anyway, because they were audible
//                  enough to clear the amplitude/VAD threshold on their own despite
//                  carrying no real content. Grouped by cue text with counts (e.g.
//                  "哦" x107) rather than one line per occurrence - almost all filler
//                  collapses into a handful of known interjections, and a flat list
//                  of hundreds of near-identical lines is unreviewable. Also carries
//                  a loud, separate warning section (checked first, printed first)
//                  for the one case that's a bug rather than an editorial call: a
//                  MEANINGFUL cue landing in a cut span, which should be structurally
//                  impossible given the safety net (it unions every meaningful cue's
//                  span into keep_seconds already) - a stale keep_segments.json vs.
//                  this SRT, a raw-timeline-map mismatch, a rounding artifact at a
//                  file boundary, etc.
//   included_review.txt - the readable SCRIPT of the resulting video: every
//                  meaningful cue currently kept, in chronological cut-timeline
//                  order. This is deliberately NOT a diagnostic dump - it's meant to
//                  be read start to end like a transcript, so reviewing it means
//                  reading the actual planned video, not decoding a report format.
//
// Filler that's correctly and uncontroversially cut (not kept, not flagged) isn't
// written to a file at all - there's nothing to review about a call that was made
// correctly, only a count in the console summary, so both files stay focused on
// what actually needs a decision.
//
// A cue whose kept span is itself split into multiple disjoint pieces - e.g. a
// brief amplitude dip lands a real cut in the middle of one continuous utterance -
// is reported as ONE occurrence noting the split, not once per piece: what matters
// for review is "this cue", not how many fragments the underlying audio happened
// to land in.
//
// Both files give clip name + exact source-relative timecodes in
// keep_segments.json's own coordinate system where relevant, so a fix (add or
// remove a [start, end] pair from keep_seconds) can be applied directly by hand -
// deliberately not a separate edit-format/round-trip, to keep this fast.
//
// Pure JSON/SRT text processing, no audio decode - sub-second even on a
// multi-thousand-cue transcript.
//
// Usage:
//   node silence_classifier/qa_transcript_report.js --keep-segments keep_segments.json \
//     --dialogue-srt <raw-timeline SRT> --raw-timeline-map sources.json \
//     [--out-dir projects/<name>] [--repetition-manifest repetition_manifest.json]
//
// --repetition-manifest is optional context, not a requirement: once
// build_repetition_manifest.js/apply_repetition_decisions.js have deliberately
// cut some meaningful cues (real content, trimmed for redundancy - see that
// pair's own header), those cues WILL show up as "meaningful content in a cut
// span" here, because they are - that's no longer a bug signature on its own.
// Passing the filled manifest back in lets this script tell "explained by a
// deliberate repetition-trim decision" apart from "genuinely unexplained,
// investigate this", instead of the FLAGGED section crying wolf on every
// intentional edit.
import fs from "node:fs";
import path from "node:path";

import { parseSrtFile, toSrtTime } from "../lib/srt.js";
import { isMeaningfulCue } from "./dialogue_filter.js";
import { buildPieceBounds, findPieceIndex, indexBySourceClip, overlappingEntries, sourceClipKey } from "../lib/timeline.js";

const MAX_EXAMPLES_PER_GROUP = 2;

function parseArgs(argv) {
  const out = { outDir: "." };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, "").replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    out[key] = argv[i + 1];
  }
  if (!out.keepSegments || !out.dialogueSrt || !out.rawTimelineMap) {
    throw new Error(
      "Usage: qa_transcript_report.js --keep-segments <path> --dialogue-srt <raw-timeline srt> " +
      "--raw-timeline-map <path> [--out-dir <dir>] [--repetition-manifest <path>]"
    );
  }
  return out;
}

// Spans that build_repetition_manifest.js/apply_repetition_decisions.js
// deliberately cut (real content, trimmed for redundancy) - see that pair's
// own "cut" semantics: exact_duplicate cuts every occurrence except the
// first, intra_cue_repeat cuts the entire single occurrence.
function loadDeliberateCutSpans(manifestPath) {
  if (!manifestPath) return [];
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  const spans = [];
  for (const entry of manifest) {
    if (entry.decision !== "cut") continue;
    const toCut = entry.pattern === "exact_duplicate" ? entry.occurrences.slice(1) : entry.occurrences;
    for (const occ of toCut) spans.push(occ);
  }
  return spans;
}

// The complement of keep_seconds within [0, durationS] - what got cut, in the
// clip's own source-relative time. Sorted/non-overlapping by construction
// (classify.js's mergeSpans already guarantees keep_seconds is).
function excludedSpans(keepSeconds, durationS) {
  const gaps = [];
  let cursor = 0;
  for (const [s, e] of keepSeconds) {
    if (s > cursor) gaps.push([cursor, s]);
    cursor = Math.max(cursor, e);
  }
  if (cursor < durationS) gaps.push([cursor, durationS]);
  return gaps;
}

// Groups occurrences by cue text, sorted by frequency (most common first) -
// almost all filler is a handful of known interjections repeated many times,
// so this is what turns an unreviewable flat list into a scannable summary.
function groupByText(occurrences) {
  const groups = new Map();
  for (const occ of occurrences) {
    if (!groups.has(occ.text)) groups.set(occ.text, []);
    groups.get(occ.text).push(occ);
  }
  return [...groups.entries()]
    .map(([text, occs]) => ({ text, count: occs.length, examples: occs.slice(0, MAX_EXAMPLES_PER_GROUP) }))
    .sort((a, b) => b.count - a.count || a.text.localeCompare(b.text));
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  const clips = JSON.parse(fs.readFileSync(args.keepSegments, "utf-8"));
  const { pieces } = buildPieceBounds(clips);
  const keptBySource = indexBySourceClip(pieces);

  const excludedPieces = clips.flatMap((c) =>
    excludedSpans(c.keep_seconds, c.duration_s).map(([sourceStart, sourceEnd]) => ({
      sourceClip: path.resolve(c.clip),
      sourceStart,
      sourceEnd,
    }))
  );
  const excludedBySource = indexBySourceClip(excludedPieces);

  const { rawTimeline } = JSON.parse(fs.readFileSync(args.rawTimelineMap, "utf-8"));
  const cues = parseSrtFile(args.dialogueSrt);
  const deliberateCutSpans = loadDeliberateCutSpans(args.repetitionManifest);
  const isDeliberateCut = (clip, srcStart, srcEnd) =>
    deliberateCutSpans.some((s) => s.clip === clip && s.srcStart < srcEnd && s.srcEnd > srcStart);

  const excludeCandidates = [];  // filler-only, currently kept - candidates to CUT
  const fullTranscript = [];     // meaningful, currently kept - the resulting video's script
  const flaggedBug = [];         // meaningful, landed in a CUT span, and NOT explained by a deliberate repetition-trim - investigate
  const explainedCuts = [];      // meaningful, landed in a CUT span, but a deliberate repetition-trim decision explains it
  let filterCorrectlyCutCount = 0;

  cues.forEach((cue, i) => {
    const meaningful = isMeaningfulCue(cue.text);
    const rawIdx = findPieceIndex(rawTimeline, cue.start);
    const rawSeg = rawTimeline[rawIdx];
    const srcStart = rawSeg.sourceStart + Math.max(0, cue.start - rawSeg.timelineStart);
    const srcEnd = rawSeg.sourceStart + Math.max(0, cue.end - rawSeg.timelineStart);
    const clipKey = sourceClipKey(rawSeg.sourceClip);
    const clipName = path.basename(rawSeg.sourceClip);
    const context = `...${cues[i - 1]?.text ?? ""} [${cue.text}] ${cues[i + 1]?.text ?? ""}...`;

    const keptMatches = overlappingEntries(keptBySource.get(clipKey), srcStart, srcEnd);
    if (keptMatches.length > 0) {
      const first = keptMatches[0], last = keptMatches[keptMatches.length - 1];
      const cutStart = first.entry.timelineStart + (first.overlapStart - first.entry.sourceStart);
      const cutEnd = last.entry.timelineStart + (last.overlapEnd - last.entry.sourceStart);
      if (meaningful) {
        fullTranscript.push({ cutStart, cutEnd, text: cue.text });
      } else {
        excludeCandidates.push({ text: cue.text, clip: clipName, context, pieceCount: keptMatches.length, cutStart, cutEnd, srcStart, srcEnd });
      }
    }

    const excludedMatches = overlappingEntries(excludedBySource.get(clipKey), srcStart, srcEnd);
    for (const { overlapStart, overlapEnd } of excludedMatches) {
      if (!meaningful) {
        filterCorrectlyCutCount++;
        continue;
      }
      const entry = { text: cue.text, clip: clipName, context, srcStart: overlapStart, srcEnd: overlapEnd };
      if (isDeliberateCut(clipName, overlapStart, overlapEnd)) {
        explainedCuts.push(entry);
      } else {
        flaggedBug.push(entry);
      }
    }
  });

  fullTranscript.sort((a, b) => a.cutStart - b.cutStart);
  flaggedBug.sort((a, b) => a.srcStart - b.srcStart);
  explainedCuts.sort((a, b) => a.srcStart - b.srcStart);
  const excludeGroups = groupByText(excludeCandidates);

  const excludedLines = [
    `=== FLAGGED: meaningful content in a cut span (${flaggedBug.length}) ===`,
    flaggedBug.length > 0
      ? `This should be impossible if the dialogue safety net ran against this same keep_segments.json/SRT/sources.json - investigate before trusting the cut, don't just delete these lines.`
      : `None found - the safety net's coverage is consistent with this transcript.`,
    "",
    ...flaggedBug.map((f) =>
      `[CUT] "${f.text}"  (${f.clip} @ ${f.srcStart.toFixed(2)}-${f.srcEnd.toFixed(2)}s)\n    context: ${f.context}`
    ),
    "",
    ...(explainedCuts.length > 0 ? [
      `=== Explained: meaningful content cut deliberately via repetition review (${explainedCuts.length}) ===`,
      `Not a bug - see --repetition-manifest's "reason" per entry for why each was trimmed.`,
      "",
      ...explainedCuts.map((f) =>
        `[CUT] "${f.text}"  (${f.clip} @ ${f.srcStart.toFixed(2)}-${f.srcEnd.toFixed(2)}s)\n    context: ${f.context}`
      ),
      "",
    ] : []),
    `=== Candidates to exclude: filler-only, currently kept (${excludeCandidates.length} occurrence(s), ${excludeGroups.length} distinct word(s)/sound(s)) ===`,
    `Audible enough to clear the amplitude/VAD threshold on its own despite carrying no real content.`,
    "",
    ...excludeGroups.map((g) =>
      `"${g.text}" x${g.count}\n${g.examples.map((o) => {
        const splitNote = o.pieceCount > 1 ? ` [split into ${o.pieceCount} pieces by a cut mid-utterance]` : "";
        return `    e.g. [${toSrtTime(o.cutStart)} -> ${toSrtTime(o.cutEnd)}] (${o.clip} @ ${o.srcStart.toFixed(2)}-${o.srcEnd.toFixed(2)}s)${splitNote}\n      context: ${o.context}`;
      }).join("\n")}`
    ),
  ];

  const includedLines = [
    `Script of the resulting video: ${fullTranscript.length} meaningful cue(s) currently kept, in order.`,
    `This is everything that will actually be in the cut if the excluded_review.txt candidates are removed - read it top to bottom.`,
    "",
    ...fullTranscript.map((t) => `[${toSrtTime(t.cutStart)} -> ${toSrtTime(t.cutEnd)}] ${t.text}`),
  ];

  fs.mkdirSync(args.outDir, { recursive: true });
  const excludedPath = path.join(args.outDir, "excluded_review.txt");
  const includedPath = path.join(args.outDir, "included_review.txt");
  fs.writeFileSync(excludedPath, excludedLines.join("\n") + "\n", "utf-8");
  fs.writeFileSync(includedPath, includedLines.join("\n") + "\n", "utf-8");

  console.error(`Wrote ${excludedPath} (${flaggedBug.length} flagged, ${explainedCuts.length} explained by repetition review, ${excludeCandidates.length} exclude-candidate occurrences in ${excludeGroups.length} groups)`);
  console.error(`Wrote ${includedPath} (${fullTranscript.length} meaningful cues - the resulting video's script)`);
  console.error(`(${filterCorrectlyCutCount} filler occurrence(s) were already correctly cut - not written to a file, nothing to review there)`);
  if (flaggedBug.length > 0) {
    console.error(`\n*** ${flaggedBug.length} MEANINGFUL cue(s) found in cut spans - see excluded_review.txt, investigate before trusting this cut. ***`);
  }
}

main();
