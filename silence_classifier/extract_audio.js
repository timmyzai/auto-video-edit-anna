// ffmpeg/ffprobe helpers: pull raw PCM audio out of a video and read its fps/duration.
import { spawnSync } from "node:child_process";

export const VAD_SAMPLE_RATE = 16000;

// Reads raw mono float32 PCM straight from ffmpeg's stdout - no WAV container,
// no parsing library needed.
export function loadPcmFloat32(videoPath, sampleRate = VAD_SAMPLE_RATE) {
  const result = spawnSync(
    "ffmpeg",
    ["-i", videoPath, "-ac", "1", "-ar", String(sampleRate), "-f", "f32le", "-vn", "-"],
    { maxBuffer: 1024 * 1024 * 1024 }
  );
  if (result.status !== 0) {
    throw new Error(`ffmpeg failed for ${videoPath}: ${result.stderr}`);
  }
  const buf = result.stdout;
  const samples = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
  return { samples, sampleRate };
}

export function probeVideo(videoPath) {
  const result = spawnSync("ffprobe", [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=r_frame_rate,avg_frame_rate",
    "-show_entries", "format=duration",
    "-of", "json",
    videoPath,
  ]);
  if (result.status !== 0) {
    throw new Error(`ffprobe failed for ${videoPath}: ${result.stderr}`);
  }
  const data = JSON.parse(result.stdout.toString());
  const stream = data.streams[0];
  const durationS = parseFloat(data.format.duration);
  const fps = parseFrameRate(stream.avg_frame_rate || stream.r_frame_rate);
  return { fps, durationS };
}

function parseFrameRate(raw) {
  if (raw.includes("/")) {
    const [num, den] = raw.split("/").map(Number);
    return den ? num / den : num;
  }
  return Number(raw);
}
