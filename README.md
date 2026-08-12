# auto-video-edit-anna

Claude-driven rough cut for Adobe Premiere Pro 2020 or Jianying/CapCut: strip silent
stretches out of raw footage before you start real editing. "Silent" is tunable, not fixed:

**Not a developer? See `使用指南.md`** (Simplified Chinese) for a plain step-by-step guide
with copy-paste prompts — this file and `CLAUDE.md` are for working on the pipeline itself.

- **Voice priority** (default *off* — see CLAUDE.md's VAD section for why): when on, any
  segment with a detected human voice is always kept.
- **Other-sound threshold** (relative to *this clip's own* loudness — see
  `silence_classifier/suggest_threshold.js`): when there's no voice, a segment is only
  kept if non-voice audio amplitude reaches this percent of full scale — otherwise cut.

- **Adaptive threshold** (`adaptive_threshold: true`, on by default in the checked-in
  config): instead of one clip-wide cutoff, compares each moment against a rolling
  *local* noise floor. Fixes a quiet talker getting cut in a louder scene (background
  chatter, other speakers) where they clear the ambient level around them but not a
  single global threshold. Set `adaptive_threshold: false` to fall back to the plain
  clip-wide `other_sound_threshold_pct` behavior.

- **Minimum segment duration**: a kept span still shorter than this after padding is
  dropped. A small value (~250ms) only catches transient noise (clicks, taps, breath).
  Real talking-head footage often wants this much higher (900ms-1.2s) to drop short
  filler words too — that's an editorial choice about what counts as worth keeping,
  not a noise-filtering one, so check what fraction of total content it removes
  before committing to a value.

Tune all of these in `config/rough_cut_config.json`.

**Known limitation:** Silero VAD (the "voice priority" detector) has tested unreliable
on real recordings so far — confidence stayed near-zero on two different sources despite
clearly audible speech (root cause not fully isolated; suspected mic-level processing
like noise suppression distorting the waveform in ways that confuse the model without
being audible to a human ear). In practice, `other_sound_threshold_pct` is currently
doing most of the real work regardless of `voice_priority`'s setting. Treat "voice
priority" as aspirational until this is debugged with a known-clean reference recording.
Default is `false` — confirmed on real footage that turning it on produces identical
output at ~40% slower wall time, so there's currently no upside to enabling it.

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

**Setting up a new machine? Use `SETUP.md`** — a step-by-step checklist (Node
environment, `ffmpeg`, config sanity check, an end-to-end smoke test) with a verify
command after each step, scoped to the Jianying path. This section only covers what
`SETUP.md` intentionally skips: the Premiere control layer, needed for the Premiere
path only.

### Control layer: `premiere-pro-mcp` (Premiere path only)

```bash
npm install -g premiere-pro-mcp
premiere-pro-mcp --install-cep
```

This installs the CEP panel to `%APPDATA%\Adobe\CEP\extensions\MCPBridgeCEP` and sets
the Windows registry debug keys Premiere needs to load an unsigned extension.

1. Open Premiere Pro, enable the extension via **Window > Extensions > MCP Bridge**,
   and confirm the panel shows connected.
2. Register the server with Claude Code at **user scope**, so it's available in every
   project, not just this one:
   ```bash
   claude mcp add premiere-pro -s user -- premiere-pro-mcp
   ```
3. **Restart Claude Code** (quit and reopen, or start a fresh session). MCP servers
   are only loaded at session start — a server added mid-session won't have its
   tools available until you restart.
4. Verify from a shell or from inside a session:
   ```bash
   claude mcp list          # premiere-pro: premiere-pro-mcp - ✔ Connected
   ```
   or ask Claude to call the `ping` tool — it returns the connected Premiere
   version and the currently open project name.

Troubleshooting: `premiere-pro-mcp --doctor` checks the local install/config;
`premiere-pro-mcp --diagnose-cep` checks the CEP install, debug keys, and Premiere's
extension signature logs specifically.

**Before enabling:** this bridge can execute ExtendScript inside Premiere. Read
through its source first. Leave `unsafe-script` (raw script execution) **off** —
only use its named, verified tools — and don't expose its HTTP transport; stick to
local stdio.

## Running it

1. Drop raw footage into `raw/`.
2. Get a starting threshold for *this* clip — `other_sound_threshold_pct` is relative
   to each clip's own loudness, so no single number is correct across different
   recordings/mics (confirmed: a noisy webcam clip needed ~10%, a cleaner phone
   recording needed ~5%). Don't guess it — measure it:
   ```bash
   node silence_classifier/suggest_threshold.js --file raw/your_clip.mp4
   ```
   This prints the clip's own RMS percentile table and suggests a value (default:
   90th percentile of that clip's own loudness distribution). Put that number into
   `config/rough_cut_config.json`.
3. Generate keep segments:
   ```bash
   node silence_classifier/classify.js \
     --config config/rough_cut_config.json \
     --raw-dir raw \
     --out keep_segments.json
   ```
4. QA the segments before building anything — re-verifies every kept span's peak
   RMS actually clears the threshold (catches classifier bugs) and tiers segments
   by duration (< 150ms auto-rejected as noise, 150-500ms flagged for your review
   with a voicing-strength score to help judge, > 500ms auto-passed):
   ```bash
   node silence_classifier/qa_check.js --keep-segments keep_segments.json --config config/rough_cut_config.json
   ```
   Writes `keep_segments.qa-passed.json` (safe to build from directly) and
   `keep_segments.qa-review.json` (borderline list — skim it, drop anything from
   `keep_seconds` in the passed file that turns out to be junk).
5. Build the actual cut, in either editor — from `keep_segments.qa-passed.json`,
   not the raw classifier output:
   - **Premiere**: hand the QA-passed file to Claude Code (with `premiere-pro-mcp`
     registered) and point it at `premiere/build_rough_cut.md` — it imports the
     clips and assembles a new "Rough Cut - \<date\>" sequence in the open project.
   - **CapCut / Jianying Pro**: see `jianying/README.md`. Default path now expects
     you to have already imported the raw footage into a Jianying project yourself
     (so Jianying's own GUI picks the right canvas/fps) — the tool inserts the
     rough cut into that existing draft rather than creating a new one. A
     from-scratch fallback (`build_draft.js`) still exists for when there's no
     pre-existing project. Better suited to high segment counts (hundreds of
     cuts) than the Premiere path, which verifies each insert individually and
     doesn't scale as well past ~50 segments.
6. Review the result. Adjust thresholds and re-run if too much or too little got cut
   — each run produces a fresh sequence/draft, nothing is overwritten.

### What this tool can and can't do

It removes **silence** (or more precisely: spans where volume never crosses your
threshold). It cannot do **content editing** — deciding a spoken section was
rambling, redundant, or off-topic and should go, even though it wasn't quiet. That
requires understanding what was *said*, not just how loud it was, and is out of
scope for a volume-based classifier. If you compare its output to a human-edited
reference cut, expect it to under-cut relative to that reference by roughly however
much of the human's editing was content-driven rather than silence-driven — that's
not a bug to tune away, it's the honest boundary of what amplitude/VAD analysis can
tell you.

## Notes / known risks

- Setup steps above were verified against `premiere-pro-mcp@1.9.2`. It's a
  fast-moving third-party project — re-check `--version` and `--help` output if
  something here stops matching reality.
- Confirm the bridge actually connects to this specific Premiere Pro install before
  trusting the full pipeline — don't assume version support.
- Frame rate must match between raw footage and the target sequence; a mismatch
  shifts every cut point.
- `npm install` currently reports 4 advisories: 2 high-severity against `adm-zip`, a
  transitive dependency `onnxruntime-node` uses only to unzip its own bundled native
  binary during install (not something that touches your footage or any untrusted
  input at runtime), and 2 moderate against `uuid`, pulled in by `node-notifier`
  (used for the "job done" desktop notification after classification/draft builds)
  purely for internal notification IDs, never fed untrusted input. Worth revisiting
  if either package ships a fixed release.
- The VAD wrapper (`silence_classifier/vad.js`) uses a plain per-chunk probability
  threshold rather than Silero's full hysteresis/min-duration smoothing algorithm —
  `classify.js` already handles gap-bridging (`min_silence_ms`) and padding
  downstream, so this is intentionally simpler, not a shortcut that loses accuracy
  where it matters. Verified end-to-end against a synthetic test clip with known
  silent/tone/noise regions before this was committed.
