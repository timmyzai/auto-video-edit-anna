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
