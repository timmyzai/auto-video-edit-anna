// Frame-wise RMS envelope, expressed as % of full scale, thresholded into spans.
const WINDOW_MS = 20;

function rmsEnvelope(samples, sampleRate, windowMs) {
  const windowSize = Math.max(1, Math.round((sampleRate * windowMs) / 1000));
  const numWindows = Math.ceil(samples.length / windowSize);
  const rms = new Float64Array(numWindows);
  for (let w = 0; w < numWindows; w++) {
    const start = w * windowSize;
    const end = Math.min(start + windowSize, samples.length);
    let sumSquares = 0;
    for (let i = start; i < end; i++) sumSquares += samples[i] * samples[i];
    rms[w] = Math.sqrt(sumSquares / (end - start)) * 100; // % of full scale
  }
  return { rms, windowSize };
}

function spansFromKeepFlags(keep, windowSize, sampleRate, totalSamples) {
  const spans = [];
  let spanStart = null;
  for (let w = 0; w < keep.length; w++) {
    const t = (w * windowSize) / sampleRate;
    if (keep[w]) {
      if (spanStart === null) spanStart = t;
    } else if (spanStart !== null) {
      spans.push([spanStart, t]);
      spanStart = null;
    }
  }
  if (spanStart !== null) spans.push([spanStart, totalSamples / sampleRate]);
  return spans;
}

// Returns merged (start_s, end_s) spans where RMS amplitude >= thresholdPct of full scale.
export function getAmplitudeSpans(samples, sampleRate, thresholdPct, windowMs = WINDOW_MS) {
  const { rms, windowSize } = rmsEnvelope(samples, sampleRate, windowMs);
  const threshold = thresholdPct;
  const keep = new Uint8Array(rms.length);
  for (let w = 0; w < rms.length; w++) keep[w] = rms[w] >= threshold ? 1 : 0;
  return spansFromKeepFlags(keep, windowSize, sampleRate, samples.length);
}

// Local percentile within a centered window (in envelope-sample units). O(n*w) - fine at
// 20ms resolution over clip-length audio (tens of thousands of windows, not millions).
function rollingPercentile(values, halfWindow, percentile) {
  const n = values.length;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - halfWindow);
    const hi = Math.min(n, i + halfWindow + 1);
    const slice = Array.from(values.subarray(lo, hi)).sort((a, b) => a - b);
    const idx = Math.min(slice.length - 1, Math.floor((percentile / 100) * slice.length));
    out[i] = slice[idx];
  }
  return out;
}

// Same idea as getAmplitudeSpans, but the threshold adapts to each scene's local loudness
// instead of one fixed number for the whole clip. A quiet talker surrounded by louder
// background chatter can sit well above the ambient noise floor around them while still
// falling under a clip-wide threshold tuned for a louder scene elsewhere - this catches that
// case by comparing each window against a rolling local floor (the ambient/background level
// nearby) rather than a single global cutoff. `floorPct` is a safety net so a long stretch of
// near-total silence doesn't get treated as "signal" just because it's the loudest thing
// nearby - it's a floor under the *local* threshold, not a replacement for it.
export function getAdaptiveAmplitudeSpans(samples, sampleRate, {
  windowMs = WINDOW_MS,
  localWindowS = 6,
  localPercentile = 25,
  ratio = 1.8,
  floorPct = 1.5,
} = {}) {
  const { rms, windowSize } = rmsEnvelope(samples, sampleRate, windowMs);
  const halfWindow = Math.round((localWindowS * 1000) / windowMs / 2);
  const localFloor = rollingPercentile(rms, halfWindow, localPercentile);

  const keep = new Uint8Array(rms.length);
  for (let w = 0; w < rms.length; w++) {
    const threshold = Math.max(localFloor[w] * ratio, floorPct);
    keep[w] = rms[w] >= threshold ? 1 : 0;
  }
  return spansFromKeepFlags(keep, windowSize, sampleRate, samples.length);
}
