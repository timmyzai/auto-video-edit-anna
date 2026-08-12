// Mechanical step: for each kept span ("piece") on the concatenated timeline,
// extract one representative frame (ffmpeg) and collect the transcript text of
// any dialogue cues overlapping it. No model calls here - the actual caption
// text is filled in afterward, directly by the Claude Code session reading
// these frames + excerpts (or, at large span counts, a handful of background
// Agents), per subtitles/PIPELINE_PLAN.md. This replaces the old
// caption_moments.js, which paired this same frame-extraction step with local
// vit-gpt2 + opus-mt model calls - those are gone, this half is unchanged in
// spirit (bounded-concurrency ffmpeg spawns, one bad frame doesn't abort the
// run).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

// JPEG, not PNG: this frame only ever gets read once (by the session or an
// agent) - JPEG encodes an order of magnitude faster than PNG for a single
// frame at real span counts (hundreds), and quality loss at q:v 2 doesn't
// matter for a short editorial caption.
function extractFrame(sourceClip, atSeconds, outDir) {
  const framePath = path.join(outDir, `frame-${crypto.randomBytes(5).toString("hex")}.jpg`);
  const result = spawnSync("ffmpeg", [
    "-y", "-ss", String(Math.max(0, atSeconds)), "-i", sourceClip,
    "-frames:v", "1", "-q:v", "2", framePath,
  ], { stdio: ["ignore", "ignore", "pipe"] });
  if (result.status !== 0 || !fs.existsSync(framePath)) {
    throw new Error(`ffmpeg frame extraction failed for ${sourceClip}@${atSeconds}s: ${result.stderr}`);
  }
  return framePath;
}

// Bounded-concurrency map - ffmpeg spawns are I/O/seek-bound, not CPU-bound,
// so running several in parallel is safe and roughly free; unbounded would
// spawn hundreds of ffmpeg processes at once for a full-length video.
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * pieces: [{ pieceIdx, sourceClip, sourceStart, sourceEnd, timelineStart, timelineEnd }]
 *   - from lib/timeline.js's buildPieceBounds(), one entry per kept span.
 * cues: [{ start, end, text, speaker? }] dialogue cues on the concatenated
 *   timeline (already cleaned + speaker-labeled), used to build each piece's
 *   transcript excerpt for caption context.
 * outDir: where extracted frames are written - caller owns cleanup.
 * Returns manifest: [{ pieceIdx, sourceClip, atSeconds, framePath,
 *   transcriptExcerpt, caption: "" }] - `caption` is a placeholder for the
 *   session/agent to fill in.
 */
export async function buildCaptionManifest(pieces, cues, outDir, options = {}) {
  const { frameConcurrency = Math.max(2, Math.min(6, os.cpus().length)), onProgress } = options;
  fs.mkdirSync(outDir, { recursive: true });

  let done = 0;
  const manifest = await mapWithConcurrency(pieces, frameConcurrency, async (piece) => {
    const atSeconds = piece.sourceStart + (piece.timelineEnd - piece.timelineStart) / 2;
    let framePath = null;
    try {
      framePath = extractFrame(piece.sourceClip, atSeconds, outDir);
    } catch (err) {
      console.error(`(frame extraction failed for piece ${piece.pieceIdx}: ${err.message} - leaving frame blank)`);
    }
    const transcriptExcerpt = cues
      .filter((c) => c.start < piece.timelineEnd && c.end > piece.timelineStart)
      .map((c) => c.text)
      .join(" ");
    done++;
    onProgress?.(done, pieces.length);
    return {
      pieceIdx: piece.pieceIdx,
      sourceClip: piece.sourceClip,
      atSeconds,
      framePath,
      transcriptExcerpt,
      caption: "",
    };
  });

  return manifest;
}
