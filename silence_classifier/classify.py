"""Combine voice + amplitude spans into keep_segments.json for the Premiere rough cut.

Usage:
    python classify.py --config ../config/rough_cut_config.json --raw-dir ../raw --work-dir ../work --out ../keep_segments.json
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from amplitude import get_amplitude_spans
from extract_audio import extract_audio, probe_video
from vad import get_voice_spans

VIDEO_EXTS = {".mp4", ".mov", ".mxf", ".avi", ".mkv"}


def merge_spans(spans: list[tuple[float, float]]) -> list[tuple[float, float]]:
    if not spans:
        return []
    spans = sorted(spans)
    merged = [spans[0]]
    for start, end in spans[1:]:
        last_start, last_end = merged[-1]
        if start <= last_end:
            merged[-1] = (last_start, max(last_end, end))
        else:
            merged.append((start, end))
    return merged


def merge_close(spans: list[tuple[float, float]], min_gap_s: float) -> list[tuple[float, float]]:
    """Bridge gaps shorter than min_gap_s so we don't cut tiny silences (breaths, plosives)."""
    if not spans:
        return []
    spans = sorted(spans)
    merged = [spans[0]]
    for start, end in spans[1:]:
        last_start, last_end = merged[-1]
        if start - last_end < min_gap_s:
            merged[-1] = (last_start, max(last_end, end))
        else:
            merged.append((start, end))
    return merged


def pad_spans(spans: list[tuple[float, float]], pre_s: float, post_s: float, duration_s: float) -> list[tuple[float, float]]:
    padded = [
        (max(0.0, start - pre_s), min(duration_s, end + post_s))
        for start, end in spans
    ]
    return merge_spans(padded)


def seconds_to_frames(spans: list[tuple[float, float]], fps: float) -> list[list[int]]:
    frames = []
    for start, end in spans:
        start_f = int(start * fps)
        end_f = max(start_f + 1, round(end * fps))
        frames.append([start_f, end_f])
    return frames


def classify_clip(video_path: Path, work_dir: Path, config: dict) -> dict:
    wav_path = extract_audio(video_path, work_dir / f"{video_path.stem}.wav")
    meta = probe_video(video_path)
    fps, duration_s = meta["fps"], meta["duration_s"]

    amp_spans = get_amplitude_spans(wav_path, config["other_sound_threshold_pct"])

    if config["voice_priority"]:
        voice_spans = get_voice_spans(wav_path, config["vad_confidence_threshold"])
        sound_spans = merge_spans(voice_spans + amp_spans)
    else:
        sound_spans = merge_spans(amp_spans)

    min_gap_s = config["min_silence_ms"] / 1000.0
    sound_spans = merge_close(sound_spans, min_gap_s)

    pre_s = config["pre_roll_padding_ms"] / 1000.0
    post_s = config["post_roll_padding_ms"] / 1000.0
    keep_spans = pad_spans(sound_spans, pre_s, post_s, duration_s)

    return {
        "clip": str(video_path),
        "fps": fps,
        "duration_s": duration_s,
        "keep_seconds": [[round(s, 3), round(e, 3)] for s, e in keep_spans],
        "keep": seconds_to_frames(keep_spans, fps),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--raw-dir", type=Path, required=True)
    parser.add_argument("--work-dir", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()

    config = json.loads(args.config.read_text(encoding="utf-8"))
    args.work_dir.mkdir(parents=True, exist_ok=True)

    clips = sorted(
        p for p in args.raw_dir.iterdir()
        if p.suffix.lower() in VIDEO_EXTS
    )
    if not clips:
        raise SystemExit(f"No video files found in {args.raw_dir}")

    results = [classify_clip(clip, args.work_dir, config) for clip in clips]

    args.out.write_text(json.dumps(results, indent=2), encoding="utf-8")
    print(f"Wrote {len(results)} clip(s) to {args.out}")


if __name__ == "__main__":
    main()
