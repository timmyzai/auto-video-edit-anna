"""Voice activity detection via Silero VAD."""
from __future__ import annotations

from pathlib import Path

from silero_vad import get_speech_timestamps, load_silero_vad, read_audio

_model = None


def _get_model():
    global _model
    if _model is None:
        _model = load_silero_vad()
    return _model


def get_voice_spans(wav_path: Path, confidence_threshold: float = 0.5) -> list[tuple[float, float]]:
    """Return merged (start_s, end_s) spans where Silero VAD detects speech."""
    wav = read_audio(str(wav_path))
    timestamps = get_speech_timestamps(
        wav,
        _get_model(),
        threshold=confidence_threshold,
        return_seconds=True,
    )
    return [(t["start"], t["end"]) for t in timestamps]
