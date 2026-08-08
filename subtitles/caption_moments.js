// Auto-generates a short Simplified-Chinese "what's happening" caption per kept
// span (one call site per distinct shot/moment - generate_subtitles.js dedupes and
// caches by span, so a 4-sentence answer inside one shot gets one caption call, not
// four). Local image captioning (English) + local translation, not a human review
// pass - quality is generic/model-grade. This is meant to give every subtitle block
// a second line "for free," not a polished, context-aware summary.
//
// Batched by design: at real segment counts (900+) a naive one-item-at-a-time loop
// is the dominant cost in the whole pipeline (frame-extract spawn + 2 model calls,
// serialized, per item). Frame extraction (I/O-bound, cheap) runs with bounded
// concurrency; model inference runs in batches (fewer JS/tokenizer round trips than
// one-at-a-time, and lets ONNX Runtime amortize its per-call overhead across more
// work). Verified output shapes directly against the installed transformers.js
// build rather than assumed - image-to-text batches as a *nested* array
// ([[{generated_text}], [{generated_text}], ...]), translation batches as a *flat*
// one ([{translation_text}, {translation_text}, ...]) - easy to get backwards.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { pipeline, RawImage } from "@xenova/transformers";

let captioner = null;
let translator = null;

export async function loadCaptionModels() {
  if (!captioner) captioner = await pipeline("image-to-text", "Xenova/vit-gpt2-image-captioning");
  if (!translator) translator = await pipeline("translation", "Xenova/opus-mt-en-zh");
  return { captioner, translator };
}

// JPEG, not PNG: this frame only ever feeds a model and gets deleted immediately
// after - JPEG encodes an order of magnitude faster than PNG for a single frame at
// this volume (900+ extractions), and quality loss at q:v 2 is irrelevant for a
// captioning model's purposes.
function extractFrame(sourceClip, atSeconds) {
  const tmpPath = path.join(os.tmpdir(), `frame-${process.pid}-${crypto.randomBytes(4).toString("hex")}.jpg`);
  const result = spawnSync("ffmpeg", [
    "-y", "-ss", String(Math.max(0, atSeconds)), "-i", sourceClip,
    "-frames:v", "1", "-q:v", "2", tmpPath,
  ], { stdio: ["ignore", "ignore", "pipe"] });
  if (result.status !== 0 || !fs.existsSync(tmpPath)) {
    throw new Error(`ffmpeg frame extraction failed for ${sourceClip}@${atSeconds}s: ${result.stderr}`);
  }
  return tmpPath;
}

// Bounded-concurrency map - ffmpeg spawns are I/O/seek-bound, not CPU-bound, so
// running several in parallel is safe and roughly free; unbounded would spawn
// hundreds of ffmpeg processes at once for a full run.
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

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * items: [{ sourceClip, atSeconds }] - atSeconds is on sourceClip's OWN timeline,
 * not the concatenated cut timeline; callers must translate cue/timeline time back
 * to source time first.
 * Returns Simplified-Chinese captions, same order/length as items. A failure on any
 * single item (bad frame, model hiccup) yields "" for that item only - one bad shot
 * must not abort an hour-long run.
 */
export async function captionMoments(items, converter, options = {}) {
  const { batchSize = 8, frameConcurrency = Math.max(2, Math.min(6, os.cpus().length)), onProgress } = options;
  if (items.length === 0) return [];

  await loadCaptionModels();

  const framePaths = new Array(items.length).fill(null);
  try {
    await mapWithConcurrency(items, frameConcurrency, async (item, i) => {
      try {
        framePaths[i] = extractFrame(item.sourceClip, item.atSeconds);
      } catch (err) {
        framePaths[i] = { error: err };
      }
    });

    const englishCaptions = new Array(items.length).fill("");
    const validIndices = framePaths.map((p, i) => (p && !p.error ? i : -1)).filter((i) => i >= 0);

    let done = 0;
    for (const batchIndices of chunk(validIndices, batchSize)) {
      const images = await Promise.all(batchIndices.map((i) => RawImage.read(framePaths[i])));
      // Verified against the installed transformers.js build: a single-image call
      // returns [{generated_text}], a batched call returns one nested array of that
      // shape *per image* ([[{generated_text}], [{generated_text}], ...]) - not the
      // same shape one level up, so these two branches genuinely differ.
      let perImageResults;
      try {
        perImageResults = images.length === 1 ? [await captioner(images[0])] : await captioner(images);
      } catch (err) {
        perImageResults = batchIndices.map(() => null);
        console.error(`(captioning batch failed: ${err.message} - leaving these shots blank)`);
      }
      batchIndices.forEach((itemIdx, j) => {
        const result = perImageResults[j];
        englishCaptions[itemIdx] = result ? result[0].generated_text : "";
      });
      done += batchIndices.length;
      onProgress?.(done, validIndices.length);
    }

    const nonEmptyIndices = englishCaptions.map((t, i) => (t ? i : -1)).filter((i) => i >= 0);
    const zhCaptions = new Array(items.length).fill("");
    for (const batchIndices of chunk(nonEmptyIndices, batchSize * 2)) {
      const texts = batchIndices.map((i) => englishCaptions[i]);
      // Unlike the captioner, translator's batched output is already flat - a
      // single-text call and a multi-text call both return
      // [{translation_text}, ...] with no extra nesting level, verified the same way.
      let translated;
      try {
        translated = await translator(texts);
      } catch (err) {
        translated = batchIndices.map(() => null);
        console.error(`(translation batch failed: ${err.message} - leaving these shots blank)`);
      }
      batchIndices.forEach((itemIdx, j) => {
        const result = translated[j];
        zhCaptions[itemIdx] = result ? converter(result.translation_text.trim()) : "";
      });
    }

    return zhCaptions;
  } finally {
    for (const p of framePaths) {
      if (typeof p === "string") fs.rmSync(p, { force: true });
    }
  }
}
