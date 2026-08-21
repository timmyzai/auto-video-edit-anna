#!/usr/bin/env node
// Suggests a starting other_sound_threshold_pct for a new raw clip by analyzing
// its own RMS loudness distribution - other_sound_threshold_pct is relative to
// each clip's own levels, so no single number is correct across different
// recordings/mics (confirmed empirically: a noisy webcam clip needed 10%, a
// cleaner phone recording needed 5%). This picks a percentile of the clip's
// own distribution as a starting point instead of guessing a fixed number.
//
// Usage:
//   node silence_classifier/suggest_threshold.js --file raw/clip.mp4 [--target-percentile 90]
import path from "node:path";

import { loadPcmFloat32 } from "./extract_audio.js";
import { updateStageProgress, withStage } from "../lib/pipeline_progress.js";
import { projectDir } from "../jianying/lib/draft_folder.js";

const WINDOW_MS = 20;

function rmsDistributionPct(samples, sampleRate) {
  const windowSize = Math.round((sampleRate * WINDOW_MS) / 1000);
  const values = [];
  for (let start = 0; start < samples.length; start += windowSize) {
    const end = Math.min(start + windowSize, samples.length);
    let sumSquares = 0;
    for (let i = start; i < end; i++) sumSquares += samples[i] * samples[i];
    values.push(Math.sqrt(sumSquares / (end - start)) * 100);
  }
  values.sort((a, b) => a - b);
  return values;
}

function percentile(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

function parseArgs(argv) {
  const out = { targetPercentile: 90 };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, "").replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    out[key] = argv[i + 1];
  }
  if (!out.file && !out.files) {
    throw new Error("Usage: suggest_threshold.js (--file <video> | --files <p1,p2,...>) [--target-percentile 90]");
  }
  if (out.file && out.files) throw new Error("Pass --file or --files, not both.");
  return out;
}

// Shared by both modes - one file's RMS distribution -> one suggested value,
// with the same stderr printout either way.
function suggestForFile(filePath, targetP, targetPercentileLabel) {
  const { samples, sampleRate } = loadPcmFloat32(filePath, 16000);
  const dist = rmsDistributionPct(samples, sampleRate);

  console.error(`RMS distribution for ${filePath} (% of full scale, ${dist.length} windows):`);
  for (const p of [0.5, 0.75, 0.9, 0.95, 0.99]) {
    console.error(`  p${Math.round(p * 100)}: ${percentile(dist, p).toFixed(2)}`);
  }
  console.error(`  max: ${dist[dist.length - 1].toFixed(2)}`);

  const suggested = percentile(dist, targetP);
  console.error(`Suggested other_sound_threshold_pct (p${targetPercentileLabel}): ${suggested.toFixed(1)}\n`);
  return suggested;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const targetP = parseFloat(args.targetPercentile) / 100;

  console.error(
    "This is a starting point, not a guarantee - build a short test cut and adjust up/down " +
    "if too much or too little survives. Lower = keeps more (safer), higher = cuts more.\n"
  );

  // --draft-name is optional - this script is also used standalone for the
  // Premiere path, which has no projects/<name>/ folder to report into.
  const progressPath = args.draftName ? path.join(projectDir(args.draftName), "pipeline_progress.json") : null;

  const run = () => {
    if (args.files) {
      const files = args.files.split(",").map((p) => p.trim());
      const suggestions = [];
      for (const [i, f] of files.entries()) {
        suggestions.push(suggestForFile(f, targetP, args.targetPercentile));
        if (progressPath) updateStageProgress(progressPath, "suggest_threshold", { done: i + 1, total: files.length, note: f });
      }
      // One comma-separated line, same order as --files, so it pipes straight
      // into `classify.js --thresholds`.
      console.log(suggestions.map((s) => s.toFixed(1)).join(","));
    } else {
      const suggested = suggestForFile(args.file, targetP, args.targetPercentile);
      if (progressPath) updateStageProgress(progressPath, "suggest_threshold", { done: 1, total: 1, note: args.file });
      console.log(suggested.toFixed(1));
    }
  };

  if (progressPath) withStage(progressPath, "suggest_threshold", run);
  else run();
}

main();
