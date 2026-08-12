#!/usr/bin/env node
// Read-only: resolves a Jianying/CapCut draft by name and reports (a) the
// distinct raw source video files already imported into it, and (b) the raw
// video track's ordered placement (source file + source-relative time range +
// timeline position per segment). (b) is what makes an auto-caption SRT
// exported from that raw assembly interpretable - its cue timestamps are
// relative to the raw track, not to any individual source file, so they need
// this map to become (sourceClip, sourceRelativeTime) pairs. See
// silence_classifier/dialogue_filter.js and subtitles/remap_dialogue.js.
//
// Uses capcut-cli's exported library functions (loadDraft/findDraft/
// getTracksByType/findMaterial) directly rather than shelling out to
// `capcut segments`/`capcut materials` - those CLI commands project a
// human-oriented summary that drops source_timerange and material_id
// entirely (verified by reading their implementation in
// node_modules/capcut-cli/dist/index.js's segmentData()), which is exactly
// the data this script needs. loadDraft never writes - this script never
// mutates the draft.
//
// Usage:
//   node jianying/list_draft_sources.js --draft-name "<name>" [--draft-folder <dir>] \
//     [--track-index <n>] [--out <path>]
//
// Writes its JSON to projects/<draft-name>/sources.json by default (pass
// --out to override) - every other rough-cut script reads that same
// per-project folder, so this is the one place the folder gets created.
// Still prints the same JSON to stdout too, for piping/inspection.
import fs from "node:fs";
import path from "node:path";
import { findDraft, loadDraft, getTracksByType, findMaterial } from "capcut-cli";

import { detectDraftFolder, capcutBinPath, projectDir } from "./lib/draft_folder.js";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, "").replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    out[key] = argv[i + 1];
  }
  if (!out.draftName) {
    throw new Error("Usage: list_draft_sources.js --draft-name <name> [--draft-folder <dir>] [--track-index <n>]");
  }
  return out;
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

  const filePath = findDraft(draftPath);
  const { draft } = loadDraft(filePath);

  const videoTracks = getTracksByType(draft, "video");
  if (videoTracks.length === 0) {
    throw new Error(
      `"${args.draftName}" has no video track - import raw footage and place it on the ` +
      `timeline in Jianying first (this is also what lets Jianying auto-caption it).`
    );
  }

  let trackIndex;
  if (args.trackIndex !== undefined) {
    trackIndex = Number(args.trackIndex);
  } else {
    // Default to the track with the most segments - a freshly-imported raw
    // assembly is almost always the video track with the most material on it.
    // Warn rather than guess silently if there's real ambiguity.
    trackIndex = videoTracks.reduce(
      (bestIdx, t, i) => (t.segments.length > videoTracks[bestIdx].segments.length ? i : bestIdx),
      0
    );
    if (videoTracks.length > 1) {
      console.error(
        `WARNING: ${videoTracks.length} video tracks found; auto-selected track ${trackIndex} ` +
        `("${videoTracks[trackIndex].name}", ${videoTracks[trackIndex].segments.length} segments) as the raw ` +
        `footage track. Pass --track-index to pick a different one if that's wrong. Tracks: ` +
        videoTracks.map((t, i) => `[${i}] "${t.name}" (${t.segments.length} segs)`).join(", ")
      );
    }
  }
  const rawTrack = videoTracks[trackIndex];

  const rawTimeline = rawTrack.segments
    .map((seg) => {
      const material = findMaterial(draft.materials.videos, seg.material_id);
      if (!material) {
        console.error(`WARNING: segment ${seg.id} references an unresolvable material (${seg.material_id}) - skipping it.`);
        return null;
      }
      return {
        sourceClip: material.path,
        segmentId: seg.id,
        sourceStart: seg.source_timerange.start / 1e6,
        sourceEnd: (seg.source_timerange.start + seg.source_timerange.duration) / 1e6,
        timelineStart: seg.target_timerange.start / 1e6,
        timelineEnd: (seg.target_timerange.start + seg.target_timerange.duration) / 1e6,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.timelineStart - b.timelineStart);

  const sourceFiles = [...new Set(rawTimeline.map((s) => s.sourceClip))];

  console.error(`Draft "${args.draftName}": ${sourceFiles.length} distinct source file(s), ${rawTimeline.length} raw-track segment(s).`);
  for (const f of sourceFiles) console.error(`  ${f}`);

  const json = JSON.stringify({ sourceFiles, rawTimeline }, null, 2);
  const outPath = args.out || path.join(projectDir(args.draftName), "sources.json");
  fs.writeFileSync(outPath, json);
  console.error(`Wrote ${outPath}`);

  console.log(json);
}

main();
