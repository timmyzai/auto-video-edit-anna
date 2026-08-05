// Frame-wise RMS envelope, expressed as % of full scale, thresholded into spans.
const WINDOW_MS = 20;

// Returns merged (start_s, end_s) spans where RMS amplitude >= thresholdPct of full scale.
export function getAmplitudeSpans(samples, sampleRate, thresholdPct, windowMs = WINDOW_MS) {
  const windowSize = Math.max(1, Math.round((sampleRate * windowMs) / 1000));
  const threshold = thresholdPct / 100;

  const spans = [];
  let spanStart = null;

  for (let start = 0; start < samples.length; start += windowSize) {
    const end = Math.min(start + windowSize, samples.length);
    let sumSquares = 0;
    for (let i = start; i < end; i++) sumSquares += samples[i] * samples[i];
    const rms = Math.sqrt(sumSquares / (end - start));
    const t = start / sampleRate;

    if (rms >= threshold) {
      if (spanStart === null) spanStart = t;
    } else if (spanStart !== null) {
      spans.push([spanStart, t]);
      spanStart = null;
    }
  }
  if (spanStart !== null) {
    spans.push([spanStart, samples.length / sampleRate]);
  }
  return spans;
}
