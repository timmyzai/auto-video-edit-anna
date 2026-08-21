#!/usr/bin/env node
// Combine voice + amplitude spans into keep_segments.json for the Premiere rough cut.
//
// Usage:
//   node classify.js --config ../config/rough_cut_config.json --raw-dir ../raw --out ../keep_segments.json
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import cliProgress from "cli-progress";

import { getAmplitudeSpans, getAdaptiveAmplitudeSpans } from "./amplitude.js";
import { loadPcmFloat32, loadPcmFloat32ForVad, probeVideo, VAD_SAMPLE_RATE } from "./extract_audio.js";
import { getVoiceSpans } from "./vad.js";
import { meaningfulCueSourceSpans } from "./dialogue_filter.js";
import { parseSrtFile } from "../lib/srt.js";
import { withStage, updateStageProgress } from "../lib/pipeline_progress.js";

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
//
// protectedSpans (source-relative [start,end] pairs, same as extraKeepSpans)
// exempts a short span from this drop if it overlaps one - those came from a
// meaningful dialogue cue or one containing English content (see
// dialogue_filter.js's isMeaningfulCue), which is a content signal, not a
// noise one, so length alone shouldn't be grounds to cut it. Everything else
// (pure amplitude/VAD-derived spans) is still filtered on length as before.
export function filterShortSpans(spans, minDurationS, protectedSpans = []) {
  return spans.filter(([start, end]) => {
    if (end - start >= minDurationS) return true;
    return protectedSpans.some(([ps, pe]) => ps < end && pe > start);
  });
}

export function secondsToFrames(spans, fps) {
  return spans.map(([start, end]) => {
    const startF = Math.floor(start * fps);
    const endF = Math.max(startF + 1, Math.round(end * fps));
    return [startF, endF];
  });
}

// extraKeepSpans: source-relative [start,end] pairs from a content-aware
// dialogue transcript (silence_classifier/dialogue_filter.js) that MUST be
// kept regardless of amplitude/VAD - additive-only, unioned in alongside
// voice/amplitude spans before the same merge/pad/filter pipeline applies to
// everything uniformly. See CLAUDE.md's "Autonomous rough-cut workflow" for
// why: amplitude/VAD is volume-based, not content-based, so a quiet-but-
// meaningful phrase can fall under threshold and get cut - this is the
// safety net against that, and it can only widen a keep-span, never narrow
// one (empty array = today's behavior, unchanged).
async function classifyClip(videoPath, config, { fps, durationS }, extraKeepSpans = []) {
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
    soundSpans = mergeSpans([...voiceSpans, ...ampSpans, ...extraKeepSpans]);
  } else {
    soundSpans = mergeSpans([...ampSpans, ...extraKeepSpans]);
  }

  const minGapS = config.min_silence_ms / 1000;
  soundSpans = mergeClose(soundSpans, minGapS);

  const preS = config.pre_roll_padding_ms / 1000;
  const postS = config.post_roll_padding_ms / 1000;
  let keepSpans = padSpans(soundSpans, preS, postS, durationS);

  const minDurationS = config.min_segment_duration_ms / 1000;
  const beforeCount = keepSpans.length;
  keepSpans = filterShortSpans(keepSpans, minDurationS, extraKeepSpans);
  const protectedShortCount = extraKeepSpans.length > 0
    ? keepSpans.filter(([s, e]) => e - s < minDurationS).length
    : 0;

  return {
    clip: videoPath,
    fps,
    duration_s: durationS,
    keep_seconds: keepSpans.map(([s, e]) => [Math.round(s * 1000) / 1000, Math.round(e * 1000) / 1000]),
    keep: secondsToFrames(keepSpans, fps),
    dropped_short_spans: beforeCount - keepSpans.length,
    protected_short_spans: protectedShortCount,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  // --out always lives under projects/<name>/ in the Jianying workflow (and
  // classify.js is also used standalone for the Premiere path, which has no
  // projects/ folder at all) - deriving the progress path from --out's own
  // directory works either way without this script needing to know about
  // draft names.
  const progressPath = path.join(path.dirname(path.resolve(args.out)), "pipeline_progress.json");
  const stageId = args.dialogueSrt ? "classify_dialogue" : "classify_amplitude";
  await withStage(progressPath, stageId, () => runClassify(args, progressPath, stageId));
}

async function runClassify(args, progressPath, stageId) {
  const config = JSON.parse(fs.readFileSync(args.config, "utf-8"));

  const clips = args.files
    ? args.files.split(",").map((p) => path.resolve(p.trim()))
    : fs
        .readdirSync(args.rawDir)
        .filter((f) => VIDEO_EXTS.has(path.extname(f).toLowerCase()))
        .sort()
        .map((f) => path.join(args.rawDir, f));

  if (clips.length === 0) {
    throw new Error(`No video files found in ${args.files ? "--files" : args.rawDir}`);
  }

  // Per-file thresholds for --files mode (silence_classifier/suggest_threshold.js
  // --files prints these in the same order) - other_sound_threshold_pct is
  // relative to each clip's own loudness, so applying one config-wide value
  // across multiple files violates the per-clip guidance CLAUDE.md documents.
  let thresholds = null;
  if (args.thresholds) {
    thresholds = args.thresholds.split(",").map(Number);
    if (thresholds.length !== clips.length) {
      throw new Error(`--thresholds has ${thresholds.length} value(s) but --files has ${clips.length} - must match.`);
    }
  } else if (args.files) {
    console.error(
      "WARNING: --files given without --thresholds - applying config's single " +
      "other_sound_threshold_pct to every file, which violates the per-clip guidance " +
      "(each clip's own loudness distribution differs). Run suggest_threshold.js --files first."
    );
  }

  // Content-aware safety net (optional): union meaningful dialogue-cue spans
  // into each clip's keep-spans before the normal amplitude/VAD pipeline -
  // see classifyClip's extraKeepSpans param and silence_classifier/dialogue_filter.js.
  let extraSpansByClip = new Map();
  if (args.dialogueSrt && args.rawTimelineMap) {
    const { rawTimeline } = JSON.parse(fs.readFileSync(args.rawTimelineMap, "utf-8"));
    const dialogueCues = parseSrtFile(args.dialogueSrt);
    const chunks = meaningfulCueSourceSpans(dialogueCues, rawTimeline);
    for (const chunk of chunks) {
      // Keyed on path.resolve() to match the `clips` lookup key below -
      // rawTimeline's sourceClip comes from the draft (forward slashes) while
      // `clips` comes from --files resolved to the platform's native
      // separator, so comparing raw strings silently drops every chunk on
      // Windows (backslash vs forward slash never string-equal).
      const key = path.resolve(chunk.sourceClip);
      if (!extraSpansByClip.has(key)) extraSpansByClip.set(key, []);
      extraSpansByClip.get(key).push([chunk.sourceStart, chunk.sourceEnd]);
    }
    const totalChunkS = chunks.reduce((sum, c) => sum + (c.sourceEnd - c.sourceStart), 0);
    console.error(
      `Content-aware safety net: ${chunks.length} meaningful dialogue cue chunk(s), ` +
      `${totalChunkS.toFixed(1)}s total, will be unioned into keep-spans across ${extraSpansByClip.size} clip(s).`
    );
  } else if (args.dialogueSrt || args.rawTimelineMap) {
    throw new Error("--dialogue-srt and --raw-timeline-map must be given together.");
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
    const effectiveConfig = thresholds ? { ...config, other_sound_threshold_pct: thresholds[i] } : config;
    const extraKeepSpans = extraSpansByClip.get(clip) || [];
    const result = await classifyClip(clip, effectiveConfig, clipMeta[i], extraKeepSpans);
    processedS += clipMeta[i].durationS;
    bar.update(Math.round(processedS), { clip: path.basename(clip) });
    // Duration-weighted, same basis as the terminal progress bar above - a
    // 20s clip and a 20min clip cost wildly different processing time, so
    // "clips done" alone would give a misleading ETA once clip lengths
    // aren't uniform.
    updateStageProgress(progressPath, stageId, {
      done: Math.round(processedS),
      total: Math.max(1, Math.round(totalDurationS)),
      note: `${path.basename(clip)} (${i + 1}/${clips.length} clips)`,
    });
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
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, "").replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    out[key] = argv[i + 1];
  }
  if (!out.config || !out.out || !(out.rawDir || out.files)) {
    throw new Error(
      "Usage: classify.js --config <path> --out <path> (--raw-dir <dir> | --files <p1,p2,...>) " +
      "[--thresholds <t1,t2,...>] [--dialogue-srt <raw-timeline srt> --raw-timeline-map <path>]"
    );
  }
  if (out.rawDir && out.files) {
    throw new Error("Pass --files or --raw-dir, not both.");
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
