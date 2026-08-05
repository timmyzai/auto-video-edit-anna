"""ffmpeg/ffprobe helpers: pull a mono 16kHz wav out of a video and read its fps/duration."""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

VAD_SAMPLE_RATE = 16000


def extract_audio(video_path: Path, out_wav_path: Path, sample_rate: int = VAD_SAMPLE_RATE) -> Path:
    out_wav_path.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        "ffmpeg", "-y", "-i", str(video_path),
        "-ac", "1", "-ar", str(sample_rate),
        "-vn", str(out_wav_path),
    ]
    subprocess.run(cmd, check=True, capture_output=True)
    return out_wav_path


def probe_video(video_path: Path) -> dict:
    cmd = [
        "ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=r_frame_rate,avg_frame_rate",
        "-show_entries", "format=duration",
        "-of", "json", str(video_path),
    ]
    result = subprocess.run(cmd, check=True, capture_output=True, text=True)
    data = json.loads(result.stdout)
    stream = data["streams"][0]
    duration = float(data["format"]["duration"])
    fps = _parse_frame_rate(stream.get("avg_frame_rate") or stream.get("r_frame_rate"))
    return {"fps": fps, "duration_s": duration}


def _parse_frame_rate(raw: str) -> float:
    if "/" in raw:
        num, den = raw.split("/")
        den = float(den)
        return float(num) / den if den else float(num)
    return float(raw)
