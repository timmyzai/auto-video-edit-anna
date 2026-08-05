"""Frame-wise RMS/dBFS envelope, expressed as % of full scale, thresholded into spans."""
from __future__ import annotations

from pathlib import Path

import numpy as np
import soundfile as sf

WINDOW_MS = 20


def get_amplitude_spans(wav_path: Path, threshold_pct: float, window_ms: int = WINDOW_MS) -> list[tuple[float, float]]:
    """Return merged (start_s, end_s) spans where peak amplitude >= threshold_pct of full scale."""
    audio, sample_rate = sf.read(str(wav_path), always_2d=False)
    if audio.ndim > 1:
        audio = audio.mean(axis=1)

    window_size = max(1, int(sample_rate * window_ms / 1000))
    threshold = threshold_pct / 100.0

    spans: list[tuple[float, float]] = []
    span_start = None
    for start_sample in range(0, len(audio), window_size):
        window = audio[start_sample:start_sample + window_size]
        if window.size == 0:
            continue
        rms = float(np.sqrt(np.mean(np.square(window))))
        t = start_sample / sample_rate
        if rms >= threshold:
            if span_start is None:
                span_start = t
        else:
            if span_start is not None:
                spans.append((span_start, t))
                span_start = None

    if span_start is not None:
        spans.append((span_start, len(audio) / sample_rate))

    return spans
