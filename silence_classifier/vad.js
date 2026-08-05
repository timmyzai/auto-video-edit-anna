// Voice activity detection via Silero VAD (ONNX, run directly through onnxruntime-node -
// no PyTorch). Verified against the model's actual input/output signature:
//   inputs:  input [1, 512] float32, state [2, 1, 128] float32, sr [] int64
//   outputs: output [1, 1] float32 (speech probability), stateN [2, 1, 128] float32
import { fileURLToPath } from "node:url";
import path from "node:path";
import * as ort from "onnxruntime-node";

const CHUNK_SAMPLES = 512; // 32ms at 16kHz - the window size this model was trained on
const STATE_SIZE = 2 * 1 * 128;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODEL_PATH = path.join(__dirname, "..", "models", "silero_vad.onnx");

let sessionPromise = null;
function getSession() {
  if (!sessionPromise) {
    sessionPromise = ort.InferenceSession.create(MODEL_PATH);
  }
  return sessionPromise;
}

// Returns merged (start_s, end_s) spans where per-chunk speech probability >= confidenceThreshold.
// This is a plain per-chunk threshold (no hysteresis/min-duration smoothing) - classify.js already
// bridges short gaps and pads spans downstream, so duplicating that logic here isn't needed.
export async function getVoiceSpans(samples, sampleRate, confidenceThreshold = 0.5) {
  if (sampleRate !== 16000) {
    throw new Error(`Silero VAD model expects 16kHz audio, got ${sampleRate}`);
  }
  const session = await getSession();
  const srTensor = new ort.Tensor("int64", new BigInt64Array([BigInt(sampleRate)]), []);

  let state = new Float32Array(STATE_SIZE);
  const spans = [];
  let spanStartChunk = null;
  const numChunks = Math.ceil(samples.length / CHUNK_SAMPLES);

  for (let i = 0; i < numChunks; i++) {
    const chunk = new Float32Array(CHUNK_SAMPLES);
    chunk.set(samples.subarray(i * CHUNK_SAMPLES, (i + 1) * CHUNK_SAMPLES));

    const feeds = {
      input: new ort.Tensor("float32", chunk, [1, CHUNK_SAMPLES]),
      state: new ort.Tensor("float32", state, [2, 1, 128]),
      sr: srTensor,
    };
    const results = await session.run(feeds);
    const prob = results.output.data[0];
    state = results.stateN.data;

    if (prob >= confidenceThreshold) {
      if (spanStartChunk === null) spanStartChunk = i;
    } else if (spanStartChunk !== null) {
      spans.push(chunksToSeconds(spanStartChunk, i, sampleRate));
      spanStartChunk = null;
    }
  }
  if (spanStartChunk !== null) {
    spans.push(chunksToSeconds(spanStartChunk, numChunks, sampleRate));
  }
  return spans;
}

function chunksToSeconds(startChunk, endChunk, sampleRate) {
  return [
    (startChunk * CHUNK_SAMPLES) / sampleRate,
    (endChunk * CHUNK_SAMPLES) / sampleRate,
  ];
}
