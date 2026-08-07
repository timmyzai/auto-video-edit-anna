// ffmpeg/ffprobe helpers: pull raw PCM audio out of a video and read its fps/duration.
import { spawnSync } from "node:child_process";

export const VAD_SAMPLE_RATE = 16000;

// ffmpeg's plain "-ac 1" downmix uses a ~0.707/0.707 center-mix matrix (broadcast
// convention), not 0.5/0.5. For sources where L and R carry the same signal (very
// common with virtual/software mics that just duplicate mono into stereo), that
// matrix nearly doubles amplitude and can push the mix over full scale (clipping).
// Downmixing explicitly at 0.5/0.5 avoids that. Only applies when there's actually
// a second channel to mix in.
function downmixFilter(channels) {
  return channels >= 2 ? "pan=mono|c0=0.5*c0+0.5*c1" : null;
}

function probeAudioChannels(videoPath) {
  const result = spawnSync("ffprobe", [
    "-v", "error",
    "-select_streams", "a:0",
    "-show_entries", "stream=channels",
    "-of", "json",
    videoPath,
  ]);
  if (result.status !== 0) {
    throw new Error(`ffprobe failed for ${videoPath}: ${result.stderr}`);
  }
  const data = JSON.parse(result.stdout.toString());
  const stream = data.streams && data.streams[0];
  if (!stream) {
    throw new Error(`${videoPath} has no audio stream.`);
  }
  return stream.channels;
}

function runFfmpegPcm(videoPath, sampleRate, extraFilters) {
  const channels = probeAudioChannels(videoPath);
  const filters = [downmixFilter(channels), ...extraFilters].filter(Boolean);
  const args = ["-i", videoPath];
  if (filters.length > 0) args.push("-af", filters.join(","));
  args.push("-ac", "1", "-ar", String(sampleRate), "-f", "f32le", "-vn", "-");

  const result = spawnSync("ffmpeg", args, { maxBuffer: 1024 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(`ffmpeg failed for ${videoPath}: ${result.stderr}`);
  }
  const buf = result.stdout;
  const samples = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
  if (samples.length === 0) {
    throw new Error(
      `ffmpeg produced 0 audio samples for ${videoPath}. The audio track likely has ` +
      `no decodable packets (container metadata can claim a duration/codec with an ` +
      `empty track) — this happens with some screen/webcam recorders when the mic ` +
      `capture silently fails. Check the file has real audio (e.g. play it back or ` +
      `run: ffprobe -select_streams a:0 -count_packets -show_entries stream=nb_read_packets <file>).`
    );
  }
  return { samples, sampleRate };
}

// Reads raw mono float32 PCM straight from ffmpeg's stdout - no WAV container,
// no parsing library needed. Used for amplitude-based detection, so no loudness
// normalization here — thresholds are meant to read actual relative levels.
export function loadPcmFloat32(videoPath, sampleRate = VAD_SAMPLE_RATE) {
  return runFfmpegPcm(videoPath, sampleRate, []);
}

// Same audio, but loudness-normalized before VAD sees it. Silero's confidence
// drops off fast on quiet/inconsistently-leveled input; dynaudnorm brings quiet
// recordings up to a level closer to what the model was trained on. Kept separate
// from loadPcmFloat32 because amplitude-based detection must NOT be normalized —
// that would defeat the whole point of an amplitude threshold.
export function loadPcmFloat32ForVad(videoPath, sampleRate = VAD_SAMPLE_RATE) {
  return runFfmpegPcm(videoPath, sampleRate, ["dynaudnorm=f=150:g=15"]);
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
