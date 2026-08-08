#!/usr/bin/env node
// Generates a two-line Simplified-Chinese SRT from keep_segments.json, timed to the
// exact same concatenated timeline build_draft.js produces (same cumulative math -
// clip by clip, span by span, in order) - so cues line up whether the Jianying/CapCut
// draft was already built or not.
//
// Each cue has two lines:
//   1. "<A/B/C>: <transcript>"  - Whisper transcript, speaker-tagged via a pitch/
//      timbre clustering heuristic (see subtitles/diarize.js - not real voiceprint
//      diarization, a best-effort approximation).
//   2. an auto-generated action/scene caption for that moment (see
//      subtitles/caption_moments.js - local image captioning + translation, one per
//      kept span, cached and reused across every cue inside that span, computed in
//      batches - this is the slow phase at real segment counts).
//
// Speech in the source footage may be Cantonese or Mandarin. Whisper has no distinct
// Cantonese ("yue") language token - forcing `language: "zh"` still transcribes
// Cantonese speech into Chinese characters (the standard approach; quality is good
// for clear Mandarin, more variable for Cantonese). Whatever script Whisper or the
// caption translator output (Traditional is common), OpenCC (`from: "hk"`, tuned for
// Cantonese vocabulary like 哋/佢/嘅) forces it to Simplified - a no-op on text that's
// already Simplified, so this is safe to always run on both lines.
//
// Usage:
//   node subtitles/generate_subtitles.js --keep-segments keep_segments.json --out output/subtitles.srt
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline, env } from "@xenova/transformers";
import * as OpenCC from "opencc-js";
import ora from "ora";
import notifier from "node-notifier";

import { loadPcmFloat32, VAD_SAMPLE_RATE } from "../silence_classifier/extract_audio.js";
import { extractVoiceFeatures, clusterSpeakers, labelSpeakers } from "./diarize.js";
import { captionMoments } from "./caption_moments.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Cache downloaded model weights inside the repo instead of the OS default cache -
// keeps re-runs fast and matches how this repo already keeps VAD's model under
// models/ rather than relying on a global cache location.
env.cacheDir = path.join(__dirname, "..", "models", "transformers-cache");

function parseArgs(argv) {
  const out = {
    model: "Xenova/whisper-small",
    language: "zh",
    out: "output/subtitles.srt",
    speakers: "2",
    captions: "true",
    batchSize: "8",
  };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, "").replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    out[key] = argv[i + 1];
  }
  if (!out.keepSegments) {
    throw new Error(
      "Usage: generate_subtitles.js --keep-segments <path> [--out <path>] [--model <hf-id>] [--language zh] [--speakers 2] [--captions false] [--batch-size 8]"
    );
  }
  out.speakers = Number(out.speakers);
  out.batchSize = Number(out.batchSize);
  out.captions = out.captions !== "false";
  return out;
}

// Mirrors jianying/build_draft.js's per-clip/per-span cumulative timeline exactly
// (same clamping against clipEntry.duration_s, same order) so subtitle timestamps
// land on the same positions as the video segments Jianying will place. Also keeps
// per-piece source metadata (which file, what source-relative time range) so a cue's
// timeline position can be mapped back to a source frame for captioning.
function buildTimeline(clips) {
  const audioPieces = [];
  const pieceMeta = [];
  let cumulative = 0;

  for (const clipEntry of clips) {
    const sourceVideo = path.resolve(clipEntry.clip);
    console.error(`Extracting audio: ${sourceVideo} (${clipEntry.keep_seconds.length} segments)`);
    const { samples } = loadPcmFloat32(sourceVideo, VAD_SAMPLE_RATE);
    const materialDuration = clipEntry.duration_s;

    for (const [inS, outS] of clipEntry.keep_seconds) {
      const clampedOutS = materialDuration ? Math.min(outS, materialDuration) : outS;
      const dur = clampedOutS - inS;
      if (dur <= 0) continue;
      const startIdx = Math.max(0, Math.round(inS * VAD_SAMPLE_RATE));
      const endIdx = Math.min(samples.length, Math.round(clampedOutS * VAD_SAMPLE_RATE));
      if (endIdx <= startIdx) continue;

      audioPieces.push(samples.subarray(startIdx, endIdx));
      pieceMeta.push({
        timelineStart: cumulative,
        timelineEnd: cumulative + dur,
        sourceClip: sourceVideo,
        sourceStart: inS,
      });
      cumulative += dur;
    }
  }

  const totalSamples = audioPieces.reduce((sum, p) => sum + p.length, 0);
  const audio = new Float32Array(totalSamples);
  let offset = 0;
  for (const p of audioPieces) {
    audio.set(p, offset);
    offset += p.length;
  }
  return { audio, pieceMeta, totalSeconds: cumulative };
}

// pieceMeta is sorted by timelineStart by construction (buildTimeline only ever
// appends with a monotonically increasing cumulative) - binary search instead of a
// linear scan per cue, since this runs once per transcript cue (hundreds) against
// hundreds-to-low-thousands of pieces.
function findPieceIndex(pieceMeta, timelineSeconds) {
  let lo = 0;
  let hi = pieceMeta.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const piece = pieceMeta[mid];
    if (timelineSeconds < piece.timelineStart) hi = mid - 1;
    else if (timelineSeconds >= piece.timelineEnd) lo = mid + 1;
    else return mid;
  }
  // Off the end (Whisper's tail chunk can report a timestamp a little past the true
  // audio duration due to timestamp-bin quantization) - clamp to the nearest piece.
  return Math.min(Math.max(lo, 0), pieceMeta.length - 1);
}

function toSrtTime(seconds) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const hh = Math.floor(ms / 3_600_000);
  const mm = Math.floor((ms % 3_600_000) / 60_000);
  const ss = Math.floor((ms % 60_000) / 1000);
  const mmm = ms % 1000;
  const pad = (n, len) => String(n).padStart(len, "0");
  return `${pad(hh, 2)}:${pad(mm, 2)}:${pad(ss, 2)},${pad(mmm, 3)}`;
}

function writeSrt(cues, labels, actionLines, outPath) {
  const srt = cues
    .map((c, i) => {
      const lines = [`${labels[i]}: ${c.text}`];
      if (actionLines[i]) lines.push(actionLines[i]);
      return `${i + 1}\n${toSrtTime(c.start)} --> ${toSrtTime(c.end)}\n${lines.join("\n")}\n`;
    })
    .join("\n");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, srt, "utf-8");
}

// Whisper's best-known long-form failure mode is repeating the same phrase for
// several consecutive chunks when it loses its footing (heavy noise, cross-talk,
// non-speech that slipped past the silence classifier). Collapsing immediate exact
// repeats is a cheap, safe accuracy pass - it can only remove a run of duplicates,
// never touch legitimately distinct dialogue (which won't be byte-identical).
function collapseRepeats(cues, maxRun = 2) {
  const out = [];
  let runText = null;
  let runLength = 0;
  for (const cue of cues) {
    if (cue.text === runText) {
      runLength++;
      if (runLength > maxRun) continue; // drop this repeat, keep the first maxRun
    } else {
      runText = cue.text;
      runLength = 1;
    }
    out.push(cue);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const clips = JSON.parse(fs.readFileSync(args.keepSegments, "utf-8"));
  if (clips.length === 0) throw new Error(`No clips found in ${args.keepSegments}`);

  const { audio, pieceMeta, totalSeconds } = buildTimeline(clips);
  console.error(`Concatenated timeline audio: ${totalSeconds.toFixed(1)}s across ${pieceMeta.length} spans`);

  const modelSpinner = ora(`Loading Whisper model (${args.model})...`).start();
  const transcriber = await pipeline("automatic-speech-recognition", args.model);
  modelSpinner.succeed(`Whisper model loaded (${args.model})`);

  const asrStart = Date.now();
  let chunkCount = 0;
  const asrSpinner = ora("Transcribing (long footage can take a while)...").start();
  const result = await transcriber(audio, {
    chunk_length_s: 30,
    stride_length_s: 5,
    return_timestamps: true,
    language: args.language,
    task: "transcribe",
    chunk_callback: () => {
      chunkCount++;
      const elapsedS = (Date.now() - asrStart) / 1000;
      const msg = `Transcribing... chunk ${chunkCount} (~${Math.min(chunkCount * 25, totalSeconds).toFixed(0)}/${totalSeconds.toFixed(0)}s of audio, ${elapsedS.toFixed(0)}s elapsed)`;
      asrSpinner.text = msg;
      // ora's spinner redraws in place, which is invisible once stdout/stderr is
      // redirected to a log file (confirmed firsthand: a real background run's log
      // had zero progress lines despite 15+ minutes of elapsed CPU time) - also emit
      // a plain line periodically so a redirected run stays observable.
      if (chunkCount % 5 === 0) console.error(msg);
    },
  });
  asrSpinner.succeed(`Transcription complete (${((Date.now() - asrStart) / 1000).toFixed(0)}s).`);

  // "hk" (Hong Kong Traditional) rather than "tw" (Taiwan Mandarin) as the source
  // variant - it carries Cantonese colloquial characters (哋/佢/嘅/etc.) that "tw"'s
  // mapping table doesn't, which matters since this footage may be Cantonese.
  const converter = OpenCC.Converter({ from: "hk", to: "cn" });

  const rawChunks = result.chunks || [];
  let cues = [];
  for (let i = 0; i < rawChunks.length; i++) {
    const chunk = rawChunks[i];
    const text = converter(chunk.text.trim());
    if (!text) continue;
    const start = chunk.timestamp[0];
    if (start >= totalSeconds) continue; // tail-chunk timestamp past the true audio end
    // Whisper can leave the final chunk's end timestamp null (still-open segment at
    // audio end) - fall back to the next cue's start, or a fixed 2s tail for the very
    // last one, rather than emitting a malformed/negative-duration SRT cue.
    const next = rawChunks[i + 1];
    const end = Math.min(chunk.timestamp[1] ?? (next ? next.timestamp[0] : start + 2), totalSeconds);
    if (end <= start) continue;
    cues.push({ start, end, text });
  }
  const beforeDedup = cues.length;
  cues = collapseRepeats(cues);
  console.error(`${cues.length} transcript cues${beforeDedup !== cues.length ? ` (dropped ${beforeDedup - cues.length} repeated-hallucination cues)` : ""}.`);

  const diarizeSpinner = ora("Estimating speakers (pitch/timbre clustering)...").start();
  const features = cues.map((c) => extractVoiceFeatures(audio, VAD_SAMPLE_RATE, c.start, c.end));
  const clusterIds = clusterSpeakers(features, args.speakers);
  const labels = labelSpeakers(clusterIds);
  diarizeSpinner.succeed(`Speakers estimated (${new Set(labels).size} distinct tag(s)).`);

  // Checkpoint: write the dialogue-only SRT now, before the slow captioning phase.
  // If captioning crashes or gets interrupted partway through (the dominant cost at
  // real segment counts), there's still a usable single-line subtitle file on disk
  // instead of nothing.
  writeSrt(cues, labels, new Array(cues.length).fill(""), args.out);
  console.error(`Checkpoint written: ${args.out} (dialogue only, action captions pending).`);

  let actionLines = new Array(cues.length).fill("");
  if (args.captions && cues.length > 0) {
    const cueToPieceIndex = cues.map((c) => findPieceIndex(pieceMeta, c.start));
    const uniquePieceIndices = [...new Set(cueToPieceIndex)];
    const captionItems = uniquePieceIndices.map((pieceIdx) => {
      const piece = pieceMeta[pieceIdx];
      return { sourceClip: piece.sourceClip, atSeconds: piece.sourceStart + (piece.timelineEnd - piece.timelineStart) / 2 };
    });

    const captionSpinner = ora(`Captioning ${captionItems.length} distinct shots (batched)...`).start();
    const captionStart = Date.now();
    const captions = await captionMoments(captionItems, converter, {
      batchSize: args.batchSize,
      onProgress: (done, total) => {
        const elapsedS = (Date.now() - captionStart) / 1000;
        const rate = done / Math.max(elapsedS, 1);
        const etaS = rate > 0 ? (total - done) / rate : 0;
        const msg = `Captioning shots... ${done}/${total} (${elapsedS.toFixed(0)}s elapsed, ~${etaS.toFixed(0)}s remaining)`;
        captionSpinner.text = msg;
        if (done % (args.batchSize * 5) < args.batchSize) console.error(msg);
      },
    });
    captionSpinner.succeed(`Captioned ${captionItems.length} distinct shots (${((Date.now() - captionStart) / 1000).toFixed(0)}s).`);

    const pieceIndexToCaption = new Map(uniquePieceIndices.map((pieceIdx, j) => [pieceIdx, captions[j]]));
    actionLines = cueToPieceIndex.map((pieceIdx) => pieceIndexToCaption.get(pieceIdx) || "");
  }

  writeSrt(cues, labels, actionLines, args.out);
  console.error(`Wrote ${cues.length} cues to ${args.out} (${totalSeconds.toFixed(1)}s of timeline covered).`);

  notifyDone("Subtitles ready", `${cues.length} cues written to ${args.out}.`);
}

function notifyDone(title, message) {
  try {
    notifier.notify({ title, message, sound: true }, (err) => {
      if (err) console.error(`(notification failed: ${err.message})`);
    });
  } catch (err) {
    console.error(`(notification failed: ${err.message})`);
  }
}

main().catch((err) => {
  console.error(err.stack || err.message || err);
  process.exitCode = 1;
});
