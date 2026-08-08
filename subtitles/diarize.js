// Lightweight speaker-separation heuristic: pitch (autocorrelation F0) + spectral
// centroid (direct-summation DFT, frames are short enough this is cheap without an
// FFT dependency) per cue, k-means clustered. This is NOT real voiceprint diarization
// - there's no pyannote-equivalent model available without Python, which this repo
// avoids (see CLAUDE.md). It separates cues mainly by pitch/timbre, so two speakers
// of similar voice (e.g. same gender, similar age) can land in the same cluster and
// get mislabeled as one person. Treat A/B/C tags as a first-pass approximation, not
// ground truth - useful for "who's probably talking" at a glance, not for anything
// where speaker accuracy matters (e.g. legal/interview attribution).

const FRAME_MS = 30;
const HOP_MS = 15;
const MAX_FRAMES_PER_CUE = 20;

function autocorrelationPitch(frame, sampleRate) {
  const minLag = Math.floor(sampleRate / 400); // 400 Hz upper bound
  const maxLag = Math.floor(sampleRate / 70); // 70 Hz lower bound
  let zeroLag = 0;
  for (let i = 0; i < frame.length; i++) zeroLag += frame[i] * frame[i];
  if (zeroLag < 1e-6) return null; // near-silence, nothing to estimate

  let bestLag = -1;
  let bestVal = 0;
  for (let lag = minLag; lag <= maxLag && lag < frame.length; lag++) {
    let sum = 0;
    for (let i = 0; i < frame.length - lag; i++) sum += frame[i] * frame[i + lag];
    if (sum > bestVal) {
      bestVal = sum;
      bestLag = lag;
    }
  }
  if (bestLag < 0 || bestVal / zeroLag < 0.3) return null; // not periodic enough - unvoiced/noise
  return sampleRate / bestLag;
}

function spectralCentroid(frame, sampleRate) {
  const bins = 32;
  const minHz = 80;
  const maxHz = 4000;
  let weightedSum = 0;
  let magSum = 0;
  for (let b = 0; b < bins; b++) {
    const freq = minHz * Math.pow(maxHz / minHz, b / (bins - 1));
    const w = (2 * Math.PI * freq) / sampleRate;
    let re = 0;
    let im = 0;
    for (let i = 0; i < frame.length; i++) {
      re += frame[i] * Math.cos(w * i);
      im -= frame[i] * Math.sin(w * i);
    }
    const mag = Math.hypot(re, im);
    weightedSum += freq * mag;
    magSum += mag;
  }
  return magSum > 1e-6 ? weightedSum / magSum : 0;
}

// Returns {pitch, centroid} for a cue, or null if no voiced frame was found in its
// span (too short/quiet to estimate) - caller decides how to handle that cue.
export function extractVoiceFeatures(audio, sampleRate, startS, endS) {
  const frameLen = Math.round((sampleRate * FRAME_MS) / 1000);
  const hopLen = Math.round((sampleRate * HOP_MS) / 1000);
  const startIdx = Math.max(0, Math.round(startS * sampleRate));
  const endIdx = Math.min(audio.length, Math.round(endS * sampleRate));

  const pitches = [];
  const centroids = [];
  for (let i = startIdx; i + frameLen <= endIdx; i += hopLen) {
    const frame = audio.subarray(i, i + frameLen);
    const pitch = autocorrelationPitch(frame, sampleRate);
    if (pitch !== null) {
      pitches.push(pitch);
      centroids.push(spectralCentroid(frame, sampleRate));
    }
    if (pitches.length >= MAX_FRAMES_PER_CUE) break;
  }
  if (pitches.length === 0) return null;

  pitches.sort((a, b) => a - b);
  const medianPitch = pitches[Math.floor(pitches.length / 2)];
  const meanCentroid = centroids.reduce((a, b) => a + b, 0) / centroids.length;
  return { pitch: medianPitch, centroid: meanCentroid };
}

function dist2(a, b) {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
}

// Deterministic PRNG (mulberry32), fixed-seeded - k-means++ init previously used
// Math.random(), which meant re-running on the exact same footage could produce a
// different cluster split (and even different A/B assignment) every time. For a
// "stable pipeline" requirement, re-running generate_subtitles.js on unchanged
// input must produce identical output, not just similar output.
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// k-means over z-score-normalized {pitch, centroid}. Cues with no detected voiced
// frame inherit the nearest (by cue index / time) resolved cue's speaker rather than
// silently defaulting to cluster 0, which would bias every quiet cue toward whoever
// happens to own cluster 0.
export function clusterSpeakers(features, k) {
  const valid = features.map((f, i) => ({ f, i })).filter((x) => x.f !== null);
  const out = new Array(features.length).fill(null);
  if (valid.length === 0) return out.fill(0);

  const norm = (vals) => {
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length) || 1;
    return vals.map((v) => (v - mean) / sd);
  };
  const nPitch = norm(valid.map((x) => x.f.pitch));
  const nCentroid = norm(valid.map((x) => x.f.centroid));
  const points = valid.map((_, j) => [nPitch[j], nCentroid[j]]);

  const uniquePointCount = new Set(points.map((p) => p.join(","))).size;
  const effectiveK = Math.max(1, Math.min(k, uniquePointCount, points.length));

  const rng = mulberry32(42);
  let centroidsPts = [points[Math.floor(rng() * points.length)]];
  while (centroidsPts.length < effectiveK) {
    const dists = points.map((p) => Math.min(...centroidsPts.map((c) => dist2(p, c))));
    const total = dists.reduce((a, b) => a + b, 0);
    if (total === 0) break;
    let r = rng() * total;
    let chosen = points[0];
    for (let i = 0; i < points.length; i++) {
      r -= dists[i];
      if (r <= 0) {
        chosen = points[i];
        break;
      }
    }
    centroidsPts.push(chosen);
  }

  let assignments = new Array(points.length).fill(0);
  for (let iter = 0; iter < 25; iter++) {
    let changed = false;
    for (let i = 0; i < points.length; i++) {
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < centroidsPts.length; c++) {
        const d = dist2(points[i], centroidsPts[c]);
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      if (assignments[i] !== best) changed = true;
      assignments[i] = best;
    }
    const sums = centroidsPts.map(() => [0, 0, 0]);
    for (let i = 0; i < points.length; i++) {
      const a = assignments[i];
      sums[a][0] += points[i][0];
      sums[a][1] += points[i][1];
      sums[a][2] += 1;
    }
    centroidsPts = centroidsPts.map((c, idx) => (sums[idx][2] > 0 ? [sums[idx][0] / sums[idx][2], sums[idx][1] / sums[idx][2]] : c));
    if (!changed) break;
  }

  valid.forEach((x, j) => {
    out[x.i] = assignments[j];
  });

  for (let i = 0; i < out.length; i++) {
    if (out[i] === null) {
      let nearest = null;
      let nearestDist = Infinity;
      for (let j = 0; j < out.length; j++) {
        if (out[j] !== null && Math.abs(i - j) < nearestDist) {
          nearestDist = Math.abs(i - j);
          nearest = out[j];
        }
      }
      out[i] = nearest ?? 0;
    }
  }
  return out;
}

// Labels clusters A, B, C... in order of first appearance on the timeline, so "A" is
// always whoever speaks first rather than an arbitrary cluster-id ordering.
export function labelSpeakers(clusterIds) {
  const order = [];
  for (const id of clusterIds) if (!order.includes(id)) order.push(id);
  const letters = "ABCDEFGH";
  const map = new Map(order.map((id, i) => [id, letters[i] || `S${i + 1}`]));
  return clusterIds.map((id) => map.get(id));
}
