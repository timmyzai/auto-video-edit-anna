#!/usr/bin/env node
// QA pass over a keep_segments.json before handing it to Premiere/CapCut: catches
// segments that are almost certainly not real speech (too short to be a spoken
// word, or don't actually clear the configured amplitude threshold on re-check),
// and flags borderline ones for manual review instead of silently guessing.
//
// Usage:
//   node silence_classifier/qa_check.js --keep-segments keep_segments.json --config config/rough_cut_config.json
//
// Writes:
//   <keep-segments>.qa-passed.json  - segments that passed automatically
//   <keep-segments>.qa-review.json  - borderline segments needing a human look
// (auto-rejected segments are just dropped and reported, not written anywhere)
import fs from "node:fs";
import { loadPcmFloat32 } from "./extract_audio.js";

const REJECT_MS = 150;   // below this: essentially always a noise transient
const BORDERLINE_MS = 500; // below this but above REJECT_MS: needs a human look

const MIN_LAG = Math.round(16000 / 400), MAX_LAG = Math.round(16000 / 80);

function peakRmsPct(samples, sampleRate, s0, s1) {
  const WINDOW = Math.round(sampleRate * 0.02);
  const i0 = Math.floor(s0 * sampleRate), i1 = Math.floor(s1 * sampleRate);
  let peak = 0;
  for (let start = i0; start < i1; start += WINDOW) {
    const end = Math.min(start + WINDOW, i1);
    let sq = 0;
    for (let i = start; i < end; i++) sq += samples[i] * samples[i];
    const rms = Math.sqrt(sq / (end - start));
    if (rms > peak) peak = rms;
  }
  return peak * 100;
}

function peakVoicingStrength(samples, sampleRate, s0, s1) {
  const FRAME = Math.round(sampleRate * 0.04), HOP = Math.round(sampleRate * 0.02);
  const i0 = Math.floor(s0 * sampleRate), i1 = Math.floor(s1 * sampleRate);
  let peak = 0;
  for (let start = i0; start + FRAME <= i1; start += HOP) {
    const frame = samples.subarray(start, start + FRAME);
    let energy = 0;
    for (let i = 0; i < frame.length; i++) energy += frame[i] * frame[i];
    if (energy < 1e-6) continue;
    for (let lag = MIN_LAG; lag <= MAX_LAG && lag < frame.length; lag++) {
      let corr = 0;
      for (let i = 0; i < frame.length - lag; i++) corr += frame[i] * frame[i + lag];
      const norm = corr / energy;
      if (norm > peak) peak = norm;
    }
  }
  return Math.max(0, peak);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, "").replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    out[key] = argv[i + 1];
  }
  if (!out.keepSegments || !out.config) {
    throw new Error("Usage: qa_check.js --keep-segments <path> --config <path>");
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = JSON.parse(fs.readFileSync(args.config, "utf-8"));
  const clips = JSON.parse(fs.readFileSync(args.keepSegments, "utf-8"));
  const threshold = config.other_sound_threshold_pct;

  let totalPass = 0, totalBorderline = 0, totalReject = 0;
  const allPassed = [], allReview = [];

  for (const clip of clips) {
    const { samples, sampleRate } = loadPcmFloat32(clip.clip, 16000);
    const passed = [], review = [], rejected = [];

    for (const [start, end] of clip.keep_seconds) {
      const durMs = (end - start) * 1000;
      const peakRms = peakRmsPct(samples, sampleRate, start, end);
      // The flat re-check only makes sense against a single clip-wide cutoff. Under
      // adaptive_threshold, a span can legitimately clear a local floor while sitting
      // under the nominal other_sound_threshold_pct, so skip this check in that mode
      // rather than re-deriving the local floor here just to re-confirm what classify.js
      // already decided.
      const belowThreshold = !config.adaptive_threshold && peakRms < threshold;

      if (durMs < REJECT_MS || belowThreshold) {
        rejected.push({ start, end, durMs: Math.round(durMs), peakRms: +peakRms.toFixed(2), reason: belowThreshold ? "peak RMS below configured threshold on re-check" : "shorter than reject floor" });
      } else if (durMs < BORDERLINE_MS) {
        const voicing = peakVoicingStrength(samples, sampleRate, start, end);
        review.push({ start, end, durMs: Math.round(durMs), peakRms: +peakRms.toFixed(2), peakVoicing: +voicing.toFixed(3) });
      } else {
        passed.push([start, end]);
      }
    }

    totalPass += passed.length;
    totalBorderline += review.length;
    totalReject += rejected.length;

    console.error(`\n${clip.clip}:`);
    console.error(`  pass: ${passed.length}  borderline: ${review.length}  auto-rejected: ${rejected.length}`);
    if (rejected.length > 0) {
      console.error(`  rejected (dropped):`);
      for (const r of rejected) console.error(`    [${r.start},${r.end}] ${r.durMs}ms peakRms=${r.peakRms}% - ${r.reason}`);
    }
    if (review.length > 0) {
      console.error(`  needs review (higher peakVoicing = more likely real speech):`);
      for (const r of review) console.error(`    [${r.start},${r.end}] ${r.durMs}ms peakRms=${r.peakRms}% peakVoicing=${r.peakVoicing}`);
    }

    allPassed.push({ ...clip, keep_seconds: passed });
    for (const r of review) allReview.push({ clip: clip.clip, ...r });
  }

  const passOut = args.keepSegments.replace(/\.json$/, "") + ".qa-passed.json";
  const reviewOut = args.keepSegments.replace(/\.json$/, "") + ".qa-review.json";
  fs.writeFileSync(passOut, JSON.stringify(allPassed, null, 2));
  fs.writeFileSync(reviewOut, JSON.stringify(allReview, null, 2));
  console.error(`\nwrote ${passOut} (auto-passed only, ${clips.length} clip(s))`);
  console.error(`wrote ${reviewOut} (borderline list for your review)`);

  console.error(`\n=== Total: ${totalPass} pass, ${totalBorderline} borderline, ${totalReject} auto-rejected ===`);
}

main();
