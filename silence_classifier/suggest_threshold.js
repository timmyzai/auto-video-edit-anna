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
import { loadPcmFloat32 } from "./extract_audio.js";

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
  if (!out.file) throw new Error("Usage: suggest_threshold.js --file <video> [--target-percentile 90]");
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const targetP = parseFloat(args.targetPercentile) / 100;

  const { samples, sampleRate } = loadPcmFloat32(args.file, 16000);
  const dist = rmsDistributionPct(samples, sampleRate);

  console.error(`RMS distribution for ${args.file} (% of full scale, ${dist.length} windows):`);
  for (const p of [0.5, 0.75, 0.9, 0.95, 0.99]) {
    console.error(`  p${Math.round(p * 100)}: ${percentile(dist, p).toFixed(2)}`);
  }
  console.error(`  max: ${dist[dist.length - 1].toFixed(2)}`);

  const suggested = percentile(dist, targetP);
  console.error(
    `\nSuggested other_sound_threshold_pct (p${args.targetPercentile}): ${suggested.toFixed(1)}`
  );
  console.error(
    "This is a starting point, not a guarantee - build a short test cut and adjust up/down " +
    "if too much or too little survives. Lower = keeps more (safer), higher = cuts more."
  );
  console.log(suggested.toFixed(1));
}

main();
