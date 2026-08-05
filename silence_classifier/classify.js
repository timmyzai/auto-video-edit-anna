#!/usr/bin/env node
// Combine voice + amplitude spans into keep_segments.json for the Premiere rough cut.
//
// Usage:
//   node classify.js --config ../config/rough_cut_config.json --raw-dir ../raw --out ../keep_segments.json
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getAmplitudeSpans } from "./amplitude.js";
import { loadPcmFloat32, probeVideo, VAD_SAMPLE_RATE } from "./extract_audio.js";
import { getVoiceSpans } from "./vad.js";

const VIDEO_EXTS = new Set([".mp4", ".mov", ".mxf", ".avi", ".mkv"]);

export function mergeSpans(spans) {
  if (spans.length === 0) return [];
  const sorted = [...spans].sort((a, b) => a[0] - b[0]);
  const merged = [sorted[0]];
  for (const [start, end] of sorted.slice(1)) {
    const last = merged[merged.length - 1];
    if (start <= last[1]) {
      last[1] = Math.max(last[1], end);
    } else {
      merged.push([start, end]);
    }
  }
  return merged;
}

// Bridges gaps shorter than minGapS so we don't cut tiny silences (breaths, plosives).
export function mergeClose(spans, minGapS) {
  if (spans.length === 0) return [];
  const sorted = [...spans].sort((a, b) => a[0] - b[0]);
  const merged = [sorted[0]];
  for (const [start, end] of sorted.slice(1)) {
    const last = merged[merged.length - 1];
    if (start - last[1] < minGapS) {
      last[1] = Math.max(last[1], end);
    } else {
      merged.push([start, end]);
    }
  }
  return merged;
}

export function padSpans(spans, preS, postS, durationS) {
  const padded = spans.map(([start, end]) => [
    Math.max(0, start - preS),
    Math.min(durationS, end + postS),
  ]);
  return mergeSpans(padded);
}

export function secondsToFrames(spans, fps) {
  return spans.map(([start, end]) => {
    const startF = Math.floor(start * fps);
    const endF = Math.max(startF + 1, Math.round(end * fps));
    return [startF, endF];
  });
}

async function classifyClip(videoPath, config) {
  const { samples, sampleRate } = loadPcmFloat32(videoPath, VAD_SAMPLE_RATE);
  const { fps, durationS } = probeVideo(videoPath);

  const ampSpans = getAmplitudeSpans(samples, sampleRate, config.other_sound_threshold_pct);

  let soundSpans;
  if (config.voice_priority) {
    const voiceSpans = await getVoiceSpans(samples, sampleRate, config.vad_confidence_threshold);
    soundSpans = mergeSpans([...voiceSpans, ...ampSpans]);
  } else {
    soundSpans = mergeSpans(ampSpans);
  }

  const minGapS = config.min_silence_ms / 1000;
  soundSpans = mergeClose(soundSpans, minGapS);

  const preS = config.pre_roll_padding_ms / 1000;
  const postS = config.post_roll_padding_ms / 1000;
  const keepSpans = padSpans(soundSpans, preS, postS, durationS);

  return {
    clip: videoPath,
    fps,
    duration_s: durationS,
    keep_seconds: keepSpans.map(([s, e]) => [Math.round(s * 1000) / 1000, Math.round(e * 1000) / 1000]),
    keep: secondsToFrames(keepSpans, fps),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = JSON.parse(fs.readFileSync(args.config, "utf-8"));

  const clips = fs
    .readdirSync(args.rawDir)
    .filter((f) => VIDEO_EXTS.has(path.extname(f).toLowerCase()))
    .sort()
    .map((f) => path.join(args.rawDir, f));

  if (clips.length === 0) {
    throw new Error(`No video files found in ${args.rawDir}`);
  }

  const results = [];
  for (const clip of clips) {
    console.error(`Classifying ${clip} ...`);
    results.push(await classifyClip(clip, config));
  }

  fs.writeFileSync(args.out, JSON.stringify(results, null, 2));
  console.error(`Wrote ${results.length} clip(s) to ${args.out}`);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, "").replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    out[key] = argv[i + 1];
  }
  if (!out.config || !out.rawDir || !out.out) {
    throw new Error("Usage: classify.js --config <path> --raw-dir <dir> --out <path>");
  }
  return out;
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
