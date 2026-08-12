#!/usr/bin/env node
// Recovery tool for the scenario CLAUDE.md's insert_rough_cut.js notes warn
// about but don't give a fix for: the .capcut-cli-history rolling window (20
// snapshots) has closed before a planned re-run, so there's no snapshot left
// with the draft's ORIGINAL raw-footage track to restore. If a previous
// insert_rough_cut.js run already replaced that track with a "Rough Cut"
// track, its segments still carry valid source_timerange pointing at the
// original media files (that's exactly what the clone mechanism preserves -
// see insert_rough_cut.js's header) - just re-labeled as belonging to the cut
// timeline instead of the raw one.
//
// insert_rough_cut.js's resolvePieceToSegments() only reads sourceClip/
// sourceStart/sourceEnd/segmentId off each --raw-timeline-map entry (it does
// NOT need real "raw footage" placement, just SOME video track whose
// segments' source_timerange correctly maps back to the original files) - so
// this script builds a rawTimeline-shaped JSON directly from an existing
// track's own segments, letting insert_rough_cut.js run completely unchanged
// against it. This effectively lets a further-trimmed keep_segments.json be
// re-applied on top of an already-cut track when the true original is gone,
// without writing any new clone/trim logic.
//
// Usage:
//   node jianying/rebuild_raw_timeline_from_track.js --draft-name "<name>" \
//     [--track-name "Rough Cut"] [--draft-folder <dir>] [--out <path>]
import fs from "node:fs";
import path from "node:path";
import { findDraft, loadDraft, getTracksByType, findMaterialGlobal } from "capcut-cli";

import { detectDraftFolder, capcutBinPath, projectDir } from "./lib/draft_folder.js";

function parseArgs(argv) {
  const out = { trackName: "Rough Cut" };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, "").replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    out[key] = argv[i + 1];
  }
  if (!out.draftName) {
    throw new Error("Usage: rebuild_raw_timeline_from_track.js --draft-name <name> [--track-name \"Rough Cut\"] [--draft-folder <dir>] [--out <path>]");
  }
  return out;
}

const usToS = (us) => us / 1e6;

function main() {
  const args = parseArgs(process.argv.slice(2));
  const capcutBin = capcutBinPath();
  const draftFolder = args.draftFolder || detectDraftFolder(capcutBin);
  const draftPath = path.join(draftFolder, args.draftName);
  if (!fs.existsSync(draftPath)) {
    throw new Error(`No draft named "${args.draftName}" found in ${draftFolder}.`);
  }

  const filePath = findDraft(draftPath);
  const { draft } = loadDraft(filePath);
  const track = getTracksByType(draft, "video").find((t) => t.name === args.trackName);
  if (!track) {
    throw new Error(`No video track named "${args.trackName}" found in "${args.draftName}".`);
  }

  const rawTimeline = track.segments
    .map((seg) => {
      const mat = findMaterialGlobal(draft, seg.material_id);
      if (!mat || !mat.material.path) return null;
      return {
        sourceClip: mat.material.path,
        segmentId: seg.id,
        sourceStart: usToS(seg.source_timerange.start),
        sourceEnd: usToS(seg.source_timerange.start + seg.source_timerange.duration),
        timelineStart: usToS(seg.target_timerange.start),
        timelineEnd: usToS(seg.target_timerange.start + seg.target_timerange.duration),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.timelineStart - b.timelineStart);

  const sourceFiles = [...new Set(rawTimeline.map((e) => e.sourceClip))];

  const out = { sourceFiles, rawTimeline };
  const outPath = args.out || path.join(projectDir(args.draftName), "sources_from_track.json");
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2), "utf-8");
  console.error(`Wrote ${outPath}: ${rawTimeline.length} segment(s) from track "${args.trackName}" across ${sourceFiles.length} source file(s).`);
  for (const f of sourceFiles) console.error(`  ${f}`);
}

main();
