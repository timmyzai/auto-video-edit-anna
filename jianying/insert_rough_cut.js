#!/usr/bin/env node
// Inserts keep_segments.json's kept spans into an EXISTING Jianying/CapCut
// draft (the one the user manually imported raw footage into, so Jianying's
// own GUI already picked the right canvas/fps for it) - as opposed to
// build_draft.js, which always creates a brand-new draft via `compile` and
// therefore can't preserve a GUI-configured project.
//
// Mechanism: for each kept span, CLONE the ORIGINAL video-track segment it
// came from (material + every extra_material_refs entry - canvas/adjustment/
// filter/etc., i.e. whatever color grading the user applied in Jianying's
// GUI - with fresh ids, exactly mirroring capcut-cli's own `duplicate`
// command, verified against node_modules/capcut-cli/dist/factory.js's
// duplicateSegment), then retime the clone's source/target ranges directly
// (mirroring `trim`+`shift`'s exact math from dist/index.js's cmdTrim/
// cmdShift) and place it on one consolidated video track. This replaces an
// earlier design that built the cut by re-importing straight from the raw
// file (`add-video`+`trim`) onto a brand-new track: that mechanism could
// never carry over GUI-applied grading (a fresh import has no relationship
// to the original segment's material/effects), and left any pre-existing
// caption track un-remapped against the new, shorter timeline. See CLAUDE.md
// for the incident that surfaced this.
//
// Runs as ONE in-process pass against the loaded draft (capcut-cli's public
// findSegment/findMaterialGlobal/getTracksByType/loadDraft/saveDraft, per
// node_modules/capcut-cli/dist/lib.js's exports - duplicateSegment/
// removeSegment themselves are internal-only, not part of the published
// package surface) with a single saveDraft() at the end, rather than 2*N
// subprocess spawns + JSON read/write cycles. This also sidesteps
// duplicateSegment's own collision check (it refuses to place a clone onto
// an existing track if the ORIGINAL segment's full untrimmed range overlaps
// something already there - guaranteed once more than a couple of pieces
// share one original segment) - since every clone here is built and retimed
// entirely in memory before ever touching the shared target track's array,
// there's nothing to collide with.
//
// When the draft already has a text/caption track, its cues are remapped in
// the SAME pass: each cue's raw-timeline position is mapped through
// sources.json's rawTimeline -> source-relative time -> the same kept
// pieces used for video (lib/timeline.js's indexBySourceClip/
// overlappingEntries), then the cue is repositioned, split across a cut
// boundary if it straddles one, or dropped if it falls entirely in a cut
// gap. Text segments carry no source_timerange (verified against a real
// segment in this project's draft - the field is null), so only
// target_timerange is ever touched for text, unlike video.
//
// Usage:
//   node jianying/insert_rough_cut.js --draft-name "<name>" --keep-segments keep_segments.json \
//     --raw-timeline-map projects/<name>/sources.json \
//     [--draft-folder <dir>] [--track-name "Rough Cut"] [--force] [--dry-run] \
//     [--progress-file <path>]
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import cliProgress from "cli-progress";
import { findDraft, loadDraft, saveDraft, findSegment, findMaterialGlobal, getTracksByType } from "capcut-cli";

import { detectDraftFolder, capcutBinPath, projectDir } from "./lib/draft_folder.js";
import { buildPieceBounds, findPieceIndex, indexBySourceClip, overlappingEntries, sourceClipKey } from "../lib/timeline.js";

// --force/--dry-run are pure switches (no following value) - naively
// consuming argv[i+1] for every flag would eat the NEXT flag's name as this
// one's "value" whenever two switches are adjacent (e.g. `--force
// --dry-run`), silently dropping the second flag. Confirmed the hard way:
// `--force --dry-run` together left --dry-run's own token consumed by
// --force, so a "dry run" quietly wrote to the real draft instead.
const BOOLEAN_FLAGS = new Set(["force", "dryRun"]);

function parseArgs(argv) {
  const out = { trackName: "Rough Cut" };
  let i = 0;
  while (i < argv.length) {
    const key = argv[i].replace(/^--/, "").replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (BOOLEAN_FLAGS.has(key)) {
      out[key] = true;
      i += 1;
    } else {
      out[key] = argv[i + 1];
      i += 2;
    }
  }
  if (!out.draftName || !out.keepSegments || !out.rawTimelineMap) {
    throw new Error(
      "Usage: insert_rough_cut.js --draft-name <name> --keep-segments <path> " +
      "--raw-timeline-map <path, from list_draft_sources.js's sources.json> " +
      "[--draft-folder <dir>] [--track-name \"Rough Cut\"] [--force] [--dry-run] [--progress-file <path>]"
    );
  }
  out.force = Boolean(out.force);
  out.dryRun = Boolean(out.dryRun);
  return out;
}

function writeProgress(progressFilePath, state) {
  try {
    fs.writeFileSync(progressFilePath, JSON.stringify(state, null, 2));
  } catch {
    // Best-effort - a failed progress write must never fail a real insert.
  }
}

function formatEta(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}m${String(s).padStart(2, "0")}s`;
}

const usToS = (us) => us / 1e6;
const sToUs = (s) => Math.round(s * 1e6);

// Clones a segment's material and every extra_material_refs entry with fresh
// ids (mirroring duplicateSegment's cloning, verified against
// node_modules/capcut-cli/dist/factory.js) so the clone is fully independent
// of the original - editing/removing the original afterward never touches
// the clone, and vice versa. Works for any segment type (video, text, ...)
// since it never inspects source_timerange/target_timerange itself.
function cloneSegmentWithMaterials(draft, originalSeg) {
  const primary = findMaterialGlobal(draft, originalSeg.material_id);
  if (!primary) throw new Error(`Material not found for segment ${originalSeg.id}`);
  const newSeg = structuredClone(originalSeg);
  newSeg.id = crypto.randomUUID();
  const primaryClone = structuredClone(primary.material);
  primaryClone.id = crypto.randomUUID();
  draft.materials[primary.type].push(primaryClone);
  newSeg.material_id = primaryClone.id;
  const newRefs = [];
  for (const refId of originalSeg.extra_material_refs ?? []) {
    const extra = findMaterialGlobal(draft, refId);
    if (!extra) continue; // dangling ref - dropped, not copied, same as duplicateSegment
    const clone = structuredClone(extra.material);
    clone.id = crypto.randomUUID();
    draft.materials[extra.type].push(clone);
    newRefs.push(clone.id);
  }
  newSeg.extra_material_refs = newRefs;
  return newSeg;
}

function makeTrack(type, name) {
  return { id: crypto.randomUUID(), type, name, attribute: 0, segments: [], is_default_name: false, flag: 0 };
}

// Resolves one buildPieceBounds piece (sourceClip + source-relative time,
// file-relative) to the original draft segment(s) it should be cloned from,
// by intersecting against rawTimeline (list_draft_sources.js's per-segment
// source windows). Almost always resolves to exactly one sub-piece (a piece
// normally lands entirely within the one segment classify.js read it from),
// but never assumes that - a piece straddling two of the user's own raw-
// track placements (rare) produces one sub-piece per segment it overlaps,
// same discipline as remap_dialogue.js's overlappingPieces.
function resolvePieceToSegments(piece, rawTimelineBySource) {
  const entries = rawTimelineBySource.get(sourceClipKey(piece.sourceClip));
  const matches = overlappingEntries(entries, piece.sourceStart, piece.sourceEnd);
  return matches.map(({ entry, overlapStart, overlapEnd }) => ({
    segmentId: entry.segmentId,
    sourceStart: overlapStart,
    sourceEnd: overlapEnd,
    timelineStart: piece.timelineStart + (overlapStart - piece.sourceStart),
    timelineEnd: piece.timelineStart + (overlapEnd - piece.sourceStart),
  }));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const capcutBin = capcutBinPath();
  const draftFolder = args.draftFolder || detectDraftFolder(capcutBin);
  const draftPath = path.join(draftFolder, args.draftName);
  if (!fs.existsSync(draftPath)) {
    throw new Error(
      `No draft named "${args.draftName}" found in ${draftFolder}. Check the name ` +
      `(capcut projects "${args.draftName}") or pass --draft-folder.`
    );
  }

  const clips = JSON.parse(fs.readFileSync(args.keepSegments, "utf-8"));
  if (clips.length === 0) throw new Error(`No clips found in ${args.keepSegments}`);
  const { pieces, totalSeconds } = buildPieceBounds(clips);
  if (pieces.length === 0) throw new Error(`${args.keepSegments} produced zero kept spans - nothing to insert.`);

  const { rawTimeline } = JSON.parse(fs.readFileSync(args.rawTimelineMap, "utf-8"));
  if (!rawTimeline.length || rawTimeline.some((e) => !e.segmentId)) {
    throw new Error(
      `${args.rawTimelineMap} has no rawTimeline entries with segmentId - re-run list_draft_sources.js ` +
      `(current version) against this draft to regenerate it.`
    );
  }
  const rawTimelineBySource = indexBySourceClip(rawTimeline);
  const piecesBySource = indexBySourceClip(pieces);

  const filePath = findDraft(draftPath);
  const { draft } = loadDraft(filePath);

  const existingTrack = getTracksByType(draft, "video").find((t) => t.name === args.trackName);
  if (existingTrack && !args.force) {
    throw new Error(
      `A video track named "${args.trackName}" already has ${existingTrack.segments.length} segment(s) in "${args.draftName}". ` +
      `Pass --force to replace it (this rebuilds the cut from scratch), or a different --track-name.`
    );
  }

  const progressFilePath = args.progressFile
    ? path.resolve(args.progressFile)
    : path.join(projectDir(args.draftName), "rough_cut_progress.json");
  const startedAt = Date.now();
  const bar = new cliProgress.SingleBar({
    format: "Building cut |{bar}| {percentage}% | {value}/{total} pieces",
    stream: process.stderr,
    hideCursor: true,
  }, cliProgress.Presets.shades_classic);
  bar.start(pieces.length, 0);

  // --- Video: clone each kept piece from its original segment onto one new track ---
  const finalVideoTrack = makeTrack("video", args.trackName);
  const consumedOriginalSegmentIds = new Set();
  const unmatchedPieces = [];

  pieces.forEach((piece, idx) => {
    const subPieces = resolvePieceToSegments(piece, rawTimelineBySource);
    if (subPieces.length === 0) {
      unmatchedPieces.push(piece);
      return;
    }
    for (const sub of subPieces) {
      const found = findSegment(draft, sub.segmentId);
      if (!found) {
        throw new Error(
          `Piece ${idx} (${piece.sourceClip}@${piece.sourceStart.toFixed(2)}-${piece.sourceEnd.toFixed(2)}s) ` +
          `points at segment ${sub.segmentId}, which no longer exists in "${args.draftName}". ` +
          `Re-run list_draft_sources.js against the current draft and retry.`
        );
      }
      const clone = cloneSegmentWithMaterials(draft, found.segment);
      const durationS = sub.sourceEnd - sub.sourceStart;
      clone.source_timerange = { start: sToUs(sub.sourceStart), duration: sToUs(durationS) };
      clone.target_timerange = { start: sToUs(sub.timelineStart), duration: sToUs(durationS / (clone.speed || 1)) };
      clone.raw_segment_id = finalVideoTrack.id;
      finalVideoTrack.segments.push(clone);
      consumedOriginalSegmentIds.add(sub.segmentId);
    }
    bar.update(idx + 1);
    if ((idx + 1) % 25 === 0 || idx + 1 === pieces.length) {
      const elapsedS = (Date.now() - startedAt) / 1000;
      writeProgress(progressFilePath, {
        status: "running",
        draftName: args.draftName,
        segmentsDone: idx + 1,
        segmentsTotal: pieces.length,
        percent: Math.round(((idx + 1) / pieces.length) * 1000) / 10,
        elapsedSeconds: Math.round(elapsedS),
        startedAt: new Date(startedAt).toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }
  });
  bar.stop();

  if (unmatchedPieces.length > 0) {
    throw new Error(
      `${unmatchedPieces.length} kept span(s) didn't land inside any raw-timeline segment (e.g. ` +
      `${unmatchedPieces[0].sourceClip}@${unmatchedPieces[0].sourceStart.toFixed(2)}-${unmatchedPieces[0].sourceEnd.toFixed(2)}s). ` +
      `This means keep_segments.json and --raw-timeline-map disagree about the source footage - regenerate both ` +
      `against the current draft before retrying. Nothing has been written yet.`
    );
  }

  // Drop the consumed original segments (their material is safe - every kept
  // piece was already cloned out above with independent materials) and any
  // now-empty track left behind, same as capcut-cli's removeSegment.
  for (const track of getTracksByType(draft, "video")) {
    track.segments = track.segments.filter((s) => !consumedOriginalSegmentIds.has(s.id));
  }
  draft.tracks = draft.tracks.filter((t) => t.type !== "video" || t.segments.length > 0);

  // Replace a stale prior "Rough Cut" track wholesale - it's fully superseded.
  if (existingTrack) {
    draft.tracks = draft.tracks.filter((t) => t.id !== existingTrack.id);
  }
  draft.tracks.push(finalVideoTrack);

  // --- Text: remap the existing caption track's cues onto the same compacted timeline ---
  let textStats = null;
  const textTrack = getTracksByType(draft, "text")[0];
  if (textTrack) {
    const originalCues = [...textTrack.segments];
    const remapped = [];
    let dropped = 0;
    let split = 0;
    for (const cue of originalCues) {
      const cueStart = usToS(cue.target_timerange.start);
      const cueEnd = usToS(cue.target_timerange.start + cue.target_timerange.duration);
      const rawIdx = findPieceIndex(rawTimeline, cueStart);
      const rawSeg = rawTimeline[rawIdx];
      // Cue's raw-timeline time -> source-file-relative time, same hop
      // dialogue_filter.js's meaningfulCueSourceSpans uses.
      const srcStart = rawSeg.sourceStart + Math.max(0, cueStart - rawSeg.timelineStart);
      const srcEnd = rawSeg.sourceStart + Math.max(0, cueEnd - rawSeg.timelineStart);
      const clipPieces = piecesBySource.get(sourceClipKey(rawSeg.sourceClip));
      const matches = overlappingEntries(clipPieces, srcStart, srcEnd);
      if (matches.length === 0) {
        dropped++;
        continue;
      }
      matches.forEach(({ entry: piece, overlapStart, overlapEnd }, i) => {
        const newStart = piece.timelineStart + (overlapStart - piece.sourceStart);
        const newEnd = piece.timelineStart + (overlapEnd - piece.sourceStart);
        const target = i === 0 ? cue : cloneSegmentWithMaterials(draft, cue);
        target.target_timerange = { start: sToUs(newStart), duration: sToUs(newEnd - newStart) };
        remapped.push(target);
        if (i > 0) split++;
      });
    }
    remapped.sort((a, b) => a.target_timerange.start - b.target_timerange.start);
    textTrack.segments = remapped;
    textStats = { originalCues: originalCues.length, keptCues: remapped.length, dropped, split };
  }

  // draft.duration (the project's overall length) isn't derived from track
  // contents automatically - removeSegment recomputes it the same way after
  // a delete (max segment end across all tracks), and this pass needs the
  // same treatment or Jianying keeps showing/exporting the old, longer
  // (pre-cut) project length even though no track's content reaches it.
  let maxEndUs = 0;
  for (const track of draft.tracks) {
    for (const seg of track.segments) {
      const end = seg.target_timerange.start + seg.target_timerange.duration;
      if (end > maxEndUs) maxEndUs = end;
    }
  }
  draft.duration = maxEndUs;

  console.error(
    `Video: ${pieces.length} kept span(s) -> ${finalVideoTrack.segments.length} segment(s) on "${args.trackName}" ` +
    `(${totalSeconds.toFixed(2)}s), cloned from ${consumedOriginalSegmentIds.size} original segment(s).`
  );
  if (textStats) {
    console.error(
      `Text: ${textStats.originalCues} cue(s) -> ${textStats.keptCues} kept ` +
      `(${textStats.dropped} fell entirely in cut gaps, ${textStats.split} split across a cut boundary).`
    );
  } else {
    console.error("Text: no existing caption track on this draft - nothing to remap.");
  }

  if (args.dryRun) {
    console.error("DRY RUN - nothing written. Re-run without --dry-run to apply.");
    writeProgress(progressFilePath, {
      status: "dry-run",
      draftName: args.draftName,
      segmentsDone: pieces.length,
      segmentsTotal: pieces.length,
      percent: 100,
      updatedAt: new Date().toISOString(),
    });
    return;
  }

  saveDraft(filePath, draft);

  // Sweep materials orphaned by the removed original segments/stale track -
  // capcut-cli's own tested command, not reimplemented here.
  const pruneResult = spawnSync(`"${capcutBin}"`, ["prune", `"${draftPath}"`], {
    encoding: "utf-8",
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (pruneResult.status !== 0) {
    console.error(`WARNING: post-insert "capcut prune" failed (exit ${pruneResult.status}): ${pruneResult.stderr || pruneResult.stdout}`);
  }

  // Read back the actually-written file, not the in-memory object, for the final check.
  const tracksAfterRaw = spawnSync(`"${capcutBin}"`, ["tracks", `"${draftPath}"`], {
    encoding: "utf-8",
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let tracksAfter = null;
  try { tracksAfter = JSON.parse(tracksAfterRaw.stdout); } catch { /* reported below as a warning */ }
  const videoTracksAfter = tracksAfter ? tracksAfter.filter((t) => t.type === "video") : null;
  if (!videoTracksAfter || videoTracksAfter.length !== 1 || videoTracksAfter[0].segments !== finalVideoTrack.segments.length) {
    console.error(
      `WARNING: post-write verification didn't see exactly 1 video track with ${finalVideoTrack.segments.length} ` +
      `segment(s) (found: ${videoTracksAfter ? JSON.stringify(videoTracksAfter) : tracksAfterRaw.stdout}). Check the draft before trusting it.`
    );
  } else {
    console.error(`Verified: exactly 1 video track ("${args.trackName}", ${videoTracksAfter[0].segments} segments) after write.`);
  }

  writeProgress(progressFilePath, {
    status: "done",
    draftName: args.draftName,
    segmentsDone: pieces.length,
    segmentsTotal: pieces.length,
    percent: 100,
    startedAt: new Date(startedAt).toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

main();
