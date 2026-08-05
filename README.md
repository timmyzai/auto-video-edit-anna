# auto-video-edit-anna

Claude-driven rough cut for Adobe Premiere Pro 2020: strip silent stretches out of raw
footage before you start real editing. "Silent" is tunable, not fixed:

- **Voice priority** (default on): any segment with a detected human voice is always kept.
- **Other-sound threshold** (default 10%): when there's no voice, a segment is only kept
  if non-voice audio amplitude reaches this percent of full scale — otherwise it's cut.

Tune both (plus padding and minimum silence length) in `config/rough_cut_config.json`.

This repo is the custom half of the pipeline — the audio classifier and the Claude
playbook. It does **not** contain a Premiere plugin; that's a separate third-party
MCP server you install once (steps below).

## Architecture

```
Claude Code (MCP client)
   │ stdio
   ▼
premiere-pro-mcp (Node.js MCP server, npm global install — not part of this repo)
   │ writes ExtendScript command files
   ▼
CEP bridge panel inside Premiere Pro 2020 (evalScript)
   ▼
Premiere project / sequences / trackItems

Offline, before touching Premiere:
raw footage ──ffmpeg──▶ raw PCM (piped, no file/library needed)
   ──Silero VAD (ONNX, via onnxruntime-node)──▶ voice spans
   ──RMS envelope──▶ other-sound spans
   ──merge per config──▶ keep_segments.json (frame-accurate in/out points)
```

The classifier is plain Node.js — no Python/PyTorch. Silero VAD runs as a 2.3MB ONNX
model through `onnxruntime-node`, which is the only real dependency; everything else
is stdlib + a couple hundred lines of JS in `silence_classifier/`.

Rough cuts are assembled by **inserting only the "keep" segments** onto a brand new
sequence — not by deleting from an existing one. Premiere's ExtendScript API has no
supported clip-deletion call (only the undocumented QE DOM does, and it can silently
no-op); inserting trimmed clips is fully documented and reliable. This also means the
tool is non-destructive: your raw clips and existing sequences are never touched.

## One-time setup

### 1. Control layer: `premiere-pro-mcp`

```bash
npm install -g premiere-pro-mcp
premiere-pro-mcp --install-cep
```

This installs the CEP panel to `%APPDATA%\Adobe\CEP\extensions\MCPBridgeCEP` and sets
the Windows registry debug keys Premiere needs to load an unsigned extension. Then:

1. Open Premiere Pro 2020, enable the extension via **Window > Extensions**, and
   confirm the bridge panel connects.
2. Register the server with Claude Code — check the project's current docs for the
   exact syntax (it's evolved before), e.g.:
   ```
   /plugin marketplace add leancoderkavy/premiere-pro-mcp
   /plugin install premiere-pro@premiere-pro-mcp
   ```

**Before enabling:** this bridge can execute ExtendScript inside Premiere. Read
through its source first. Leave `unsafe-script` (raw script execution) **off** —
only use its named, verified tools — and don't expose its HTTP transport; stick to
local stdio.

### 2. Node.js environment for the classifier

```bash
cd auto-video-edit-anna
npm install
```

That pulls in `onnxruntime-node` (the only dependency). The Silero VAD model itself
(`models/silero_vad.onnx`, ~2.3MB) is already checked into this repo — no download step.

Also requires `ffmpeg`/`ffprobe` on `PATH`.

## Running it

1. Drop raw footage into `raw/`.
2. Adjust `config/rough_cut_config.json` if the defaults don't fit this project.
3. Generate keep segments:
   ```bash
   node silence_classifier/classify.js \
     --config config/rough_cut_config.json \
     --raw-dir raw \
     --out keep_segments.json
   ```
4. Hand `keep_segments.json` to Claude Code (with the `premiere-pro-mcp` server
   registered) and point it at `orchestrate/build_rough_cut.md` — it will import the
   clips and assemble a new "Rough Cut - <date>" sequence in the open Premiere project.
5. Review the sequence in Premiere. Adjust thresholds and re-run if too much or too
   little got cut — each run produces a fresh sequence, nothing is overwritten.

## Notes / known risks

- Re-verify `premiere-pro-mcp`'s current CLI flags and Claude Code registration
  syntax at install time — it's a fast-moving third-party project.
- Confirm the bridge actually connects to this specific Premiere Pro 2020 install
  before trusting the full pipeline — don't assume version support.
- Frame rate must match between raw footage and the target sequence; a mismatch
  shifts every cut point.
- `npm install` currently reports 2 high-severity advisories against `adm-zip`, a
  transitive dependency `onnxruntime-node` uses only to unzip its own bundled native
  binary during install (not something that touches your footage or any untrusted
  input at runtime). Worth revisiting if `onnxruntime-node` ships a fixed release.
- The VAD wrapper (`silence_classifier/vad.js`) uses a plain per-chunk probability
  threshold rather than Silero's full hysteresis/min-duration smoothing algorithm —
  `classify.js` already handles gap-bridging (`min_silence_ms`) and padding
  downstream, so this is intentionally simpler, not a shortcut that loses accuracy
  where it matters. Verified end-to-end against a synthetic test clip with known
  silent/tone/noise regions before this was committed.
