#!/usr/bin/env node
// Combine voice + amplitude spans into keep_segments.json for the Premiere rough cut.
//
// Usage:
//   node classify.js --config ../config/rough_cut_config.json --raw-dir ../raw --out ../keep_segments.json
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import cliProgress from "cli-progress";
import notifier from "node-notifier";

import { getAmplitudeSpans, getAdaptiveAmplitudeSpans } from "./amplitude.js";
import { loadPcmFloat32, loadPcmFloat32ForVad, probeVideo, VAD_SAMPLE_RATE } from "./extract_audio.js";
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

// Drops spans shorter than minDurationS after padding/merging. A span that's
// still this short even after padding almost never came from real speech - a
// spoken syllable sustains energy well past a single 20ms window, so what's
// left is a transient (click, tap, breath) that briefly crossed the amplitude
// threshold. Isolated blips like this are jarring in the final cut precisely
// because they aren't speech, so they get no visual/audio continuity around them.
export function filterShortSpans(spans, minDurationS) {
  return spans.filter(([start, end]) => end - start >= minDurationS);
}

export function secondsToFrames(spans, fps) {
  return spans.map(([start, end]) => {
    const startF = Math.floor(start * fps);
    const endF = Math.max(startF + 1, Math.round(end * fps));
    return [startF, endF];
  });
}

async function classifyClip(videoPath, config, { fps, durationS }) {
  const { samples, sampleRate } = loadPcmFloat32(videoPath, VAD_SAMPLE_RATE);

  const ampSpans = config.adaptive_threshold
    ? getAdaptiveAmplitudeSpans(samples, sampleRate, {
        localWindowS: config.adaptive_window_s,
        localPercentile: config.adaptive_local_percentile,
        ratio: config.adaptive_ratio,
        floorPct: config.adaptive_floor_pct,
      })
    : getAmplitudeSpans(samples, sampleRate, config.other_sound_threshold_pct);

  let soundSpans;
  if (config.voice_priority) {
    const { samples: vadSamples, sampleRate: vadSampleRate } = loadPcmFloat32ForVad(videoPath, VAD_SAMPLE_RATE);
    const voiceSpans = await getVoiceSpans(vadSamples, vadSampleRate, config.vad_confidence_threshold);
    soundSpans = mergeSpans([...voiceSpans, ...ampSpans]);
  } else {
    soundSpans = mergeSpans(ampSpans);
  }

  const minGapS = config.min_silence_ms / 1000;
  soundSpans = mergeClose(soundSpans, minGapS);

  const preS = config.pre_roll_padding_ms / 1000;
  const postS = config.post_roll_padding_ms / 1000;
  let keepSpans = padSpans(soundSpans, preS, postS, durationS);

  const minDurationS = config.min_segment_duration_ms / 1000;
  keepSpans = filterShortSpans(keepSpans, minDurationS);

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

  // Probed up front (ffprobe only, no audio decode - cheap even for many clips) so the
  // bar can weight progress by footage duration rather than clip count: a 20s clip and
  // a 20min clip cost wildly different processing time, so "clips done" alone would give
  // a misleading ETA the moment clip lengths aren't uniform. classifyClip takes the
  // result directly instead of re-probing internally, so each clip is only probed once.
  const clipMeta = clips.map((clip) => probeVideo(clip));
  const totalDurationS = clipMeta.reduce((sum, m) => sum + m.durationS, 0);

  const bar = new cliProgress.SingleBar(
    {
      format: "Classifying [{bar}] {percentage}% | {value}s / {total}s | ETA {eta}s | {clip}",
      stream: process.stderr,
      hideCursor: true,
      clearOnComplete: false,
    },
    cliProgress.Presets.shades_classic
  );
  // Guards against NaN% if every clip somehow probes to 0s duration - cli-progress
  // divides by `total` to compute the percentage shown.
  bar.start(Math.max(1, Math.round(totalDurationS)), 0, { clip: path.basename(clips[0]) });

  const results = [];
  const warnings = [];
  let processedS = 0;
  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];
    bar.update(Math.round(processedS), { clip: path.basename(clip) });
    const result = await classifyClip(clip, config, clipMeta[i]);
    processedS += clipMeta[i].durationS;
    bar.update(Math.round(processedS), { clip: path.basename(clip) });
    if (result.keep.length === 0) {
      // Deferred until after bar.stop() below - interleaving console.error with an
      // active cli-progress bar corrupts the terminal line (the bar redraws over it).
      warnings.push(
        `WARNING: 0 segments kept for ${clip} (duration ${result.duration_s.toFixed(1)}s). ` +
        `This clip's audio never crossed the voice/amplitude thresholds in the config — ` +
        `double-check that's actually intended before handing this off to Premiere.`
      );
    }
    results.push(result);
  }
  bar.stop();
  for (const w of warnings) console.error(w);

  fs.writeFileSync(args.out, JSON.stringify(results, null, 2));
  const keptS = results.reduce(
    (sum, r) => sum + r.keep_seconds.reduce((s, [a, b]) => s + (b - a), 0),
    0
  );
  console.error(
    `Wrote ${results.length} clip(s) to ${args.out} — ${keptS.toFixed(1)}s kept of ${totalDurationS.toFixed(1)}s raw.`
  );

  notifyDone(
    "Rough-cut classification complete",
    `${results.length} clip(s), ${keptS.toFixed(0)}s kept of ${totalDurationS.toFixed(0)}s raw.`
  );
}

// Best-effort OS toast - a missing/blocked notifier backend (e.g. locked-down
// environments without snoreToast) must never turn an otherwise-successful run into
// a failed one, so failures here are logged, not thrown.
function notifyDone(title, message) {
  try {
    notifier.notify({ title, message, sound: true }, (err) => {
      if (err) console.error(`(notification failed: ${err.message})`);
    });
  } catch (err) {
    console.error(`(notification failed: ${err.message})`);
  }
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
