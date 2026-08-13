// Deterministic piece-boundary math mirroring jianying/build_draft.js's and
// jianying/insert_rough_cut.js's cumulative clip-by-clip, span-by-span timeline
// construction (same clamping against clipEntry.duration_s, same order).
// Shared by jianying/insert_rough_cut.js (which inserts spans in this exact
// order onto the timeline), subtitles/build_action_manifest.js (frame
// extraction + transcript-excerpt mapping), and subtitles/manifest_to_srt.js
// (final SRT timing) - all must agree on where each kept span lands, so this
// lives at the repo root (not under subtitles/) now that jianying/ depends on
// it too. Never compute this independently in a caller - drift between two
// separately-derived timelines is exactly the kind of bug that's invisible
// until captions land on the wrong shot.
import path from "node:path";

export function buildPieceBounds(clips) {
  const pieces = [];
  let cumulative = 0;
  for (const clipEntry of clips) {
    const sourceVideo = path.resolve(clipEntry.clip);
    const materialDuration = clipEntry.duration_s;
    for (const [inS, outS] of clipEntry.keep_seconds) {
      const clampedOutS = materialDuration ? Math.min(outS, materialDuration) : outS;
      const dur = clampedOutS - inS;
      if (dur <= 0) continue;
      pieces.push({
        pieceIdx: pieces.length,
        sourceClip: sourceVideo,
        sourceStart: inS,
        sourceEnd: clampedOutS,
        timelineStart: cumulative,
        timelineEnd: cumulative + dur,
      });
      cumulative += dur;
    }
  }
  return { pieces, totalSeconds: cumulative };
}

// pieces is sorted by timelineStart by construction (buildPieceBounds only
// ever appends with a monotonically increasing cumulative) - binary search
// instead of a linear scan per cue.
export function findPieceIndex(pieces, timelineSeconds) {
  let lo = 0;
  let hi = pieces.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const piece = pieces[mid];
    if (timelineSeconds < piece.timelineStart) hi = mid - 1;
    else if (timelineSeconds >= piece.timelineEnd) lo = mid + 1;
    else return mid;
  }
  // Off the end (a cue's timestamp can land a little past the true audio
  // duration due to rounding) - clamp to the nearest piece.
  return Math.min(Math.max(lo, 0), pieces.length - 1);
}

// Groups any array of {sourceClip, sourceStart, sourceEnd, ...} entries by
// sourceClip, sorted by sourceStart within each clip - shared shape used both
// by buildPieceBounds' pieces and jianying/list_draft_sources.js's
// rawTimeline, so this works for matching either direction (piece -> raw
// segment, or raw cue -> piece) without a global linear scan. Originally
// private to jianying/subtitles/remap_dialogue.js; pulled up here once
// jianying/insert_rough_cut.js needed the same matching for video pieces AND
// in-draft text-cue remapping.
// path.resolve() normalizes to the platform's native separator (backslashes
// on Windows), while a sourceClip read straight from a draft/JSON (e.g.
// Jianying's own material.path in sources.json) is stored as-is, forward
// slashes included - comparing those as bare strings silently drops every
// match. Confirmed the hard way: this exact mismatch already broke
// silence_classifier/classify.js's dialogue safety net (it keyed a Map on
// raw sourceClip strings but looked up with path.resolve()'d ones - every
// .get() returned undefined, silently, with no error). Every sourceClip key,
// on both the indexing and lookup side, must go through this same
// normalization so callers on either side of a path boundary still match.
export function sourceClipKey(sourceClip) {
  return path.resolve(sourceClip);
}

export function indexBySourceClip(entries) {
  const bySource = new Map();
  for (const entry of entries) {
    const key = sourceClipKey(entry.sourceClip);
    if (!bySource.has(key)) bySource.set(key, []);
    bySource.get(key).push(entry);
  }
  for (const arr of bySource.values()) arr.sort((a, b) => a.sourceStart - b.sourceStart);
  return bySource;
}

// Every entry (from one clip's indexBySourceClip bucket) overlapping
// [start, end) in source-relative time, each with its own clamped overlap
// window - a query range never assumed to land inside exactly one entry, so a
// range straddling two entries' boundary gets a slice of each rather than
// silently keeping only the first match.
export function overlappingEntries(entries, start, end) {
  if (!entries) return [];
  return entries
    .map((entry) => ({
      entry,
      overlapStart: Math.max(entry.sourceStart, start),
      overlapEnd: Math.min(entry.sourceEnd, end),
    }))
    .filter(({ overlapStart, overlapEnd }) => overlapEnd > overlapStart);
}

// Detects overlapping [sourceStart, sourceEnd) ranges within the same source
// clip across a set of {sourceClip, sourceStart, sourceEnd, ...} entries -
// e.g. two segments on a video track both cloned from the same span of raw
// footage. A well-formed rawTimeline/kept-piece list never has this: kept
// spans come from classify.js's mergeSpans (sorted, non-overlapping by
// construction), and resolvePieceToSegments only ever partitions a piece
// against non-overlapping candidates. Two entries overlapping means the data
// being queried is itself internally inconsistent - built from a track whose
// own segments already reference duplicate/overlapping source footage, most
// likely from an edit outside this tool's control (e.g. the draft was
// reopened/resaved in Jianying) since the last known-good state. Confirmed
// hitting this directly: a "Rough Cut" track rebuilt into a raw-timeline-map
// via jianying/rebuild_raw_timeline_from_track.js carried 124 such
// overlapping pairs for one source file, silently inherited from the track it
// read - jianying/insert_rough_cut.js cloned every one of them, inflating the
// resulting video track by several minutes of duplicated footage with no
// error at write time. Returns one entry per overlapping pair found (not
// just a boolean) so a caller can report exactly what's wrong; empty array
// means clean.
export function findOverlappingSourceRanges(entries) {
  const bySource = indexBySourceClip(entries);
  const overlaps = [];
  for (const [clip, arr] of bySource) {
    let cursor = -Infinity;
    let cursorEntry = null;
    for (const entry of arr) {
      if (cursorEntry && entry.sourceStart < cursor - 1e-6) {
        overlaps.push({ clip, a: cursorEntry, b: entry });
      }
      if (entry.sourceEnd > cursor) {
        cursor = entry.sourceEnd;
        cursorEntry = entry;
      }
    }
  }
  return overlaps;
}

// Human-readable summary for findOverlappingSourceRanges' output - grouped
// per-clip counts plus a handful of concrete examples, not a raw dump (an
// affected clip can have well over a hundred overlapping pairs).
export function formatOverlapReport(overlaps, { maxExamples = 5 } = {}) {
  const bySourceCount = new Map();
  for (const o of overlaps) bySourceCount.set(o.clip, (bySourceCount.get(o.clip) || 0) + 1);
  const summary = [...bySourceCount.entries()].map(([clip, n]) => `${clip} (${n} pair(s))`).join(", ");
  const examples = overlaps
    .slice(0, maxExamples)
    .map((o) => `  ${o.clip}: [${o.a.sourceStart.toFixed(2)}-${o.a.sourceEnd.toFixed(2)}s] overlaps [${o.b.sourceStart.toFixed(2)}-${o.b.sourceEnd.toFixed(2)}s]`);
  const more = overlaps.length > maxExamples ? `\n  ...and ${overlaps.length - maxExamples} more` : "";
  return `${overlaps.length} overlapping source-range pair(s): ${summary}\n${examples.join("\n")}${more}`;
}

// Removes [cutStart, cutEnd) from a clip's keep_seconds, splitting any span
// that straddles it rather than assuming it aligns exactly to a span edge.
// Shared by every script that subtracts a specific cue's span from a kept
// clip (silence_classifier/apply_repetition_decisions.js,
// silence_classifier/apply_filler_exclusions.js) - the exact same operation,
// only the source of "what to cut" differs between them.
export function subtractSpan(keepSeconds, cutStart, cutEnd) {
  const out = [];
  for (const [s, e] of keepSeconds) {
    if (cutEnd <= s || cutStart >= e) {
      out.push([s, e]);
      continue;
    }
    if (cutStart > s) out.push([s, cutStart]);
    if (cutEnd < e) out.push([cutEnd, e]);
  }
  return out;
}
