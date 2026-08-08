# CLAUDE.md

Instructions for Claude Code (and any other agent reading this via `AGENTS.md`,
which symlinks here) when working in this repo.

## What this repo is

A rough-cut pipeline: a plain-Node.js silence/voice classifier (`silence_classifier/`)
produces `keep_segments.json` from raw footage, then either an MCP-driven Premiere
playbook or a Node.js/Jianying pipeline assembles those segments into an actual cut
video. The whole repo is Node.js only — no Python anywhere (see the Jianying section
below for why, and what was tried and dropped). Full architecture and one-time
setup: see `README.md`.

**Scope boundary, learned the hard way**: this tool removes *silence* (volume-based),
not *content* (judgment-based). Compared against a real human-edited reference clip,
it consistently under-cuts relative to the human's edit by roughly however much of
their editing was cutting whole talking sections for content reasons rather than
trimming dead air — verified by aligning the human's before/after pair and finding
the "cut" and "kept" regions' loudness distributions overlap heavily (some cut
material was louder than some kept material). Don't chase closing that gap by
cranking the amplitude threshold — that's overfitting to one example, not fixing a
bug. If a user wants that gap closed, they want content editing (transcript + LLM
judgment), a genuinely different feature, not a threshold tweak.

Also confirmed the reference edit **reorders** content, not just trims it — its
opening seconds are a loud "hook" moment pulled from ~56s into the raw footage, not
the chronological start. Verified via cross-correlation match (RMS ~20%, right at
the source clip's own 99th percentile, i.e. genuinely its loudest moment) rather than
assumed. This tool only ever outputs kept spans in original chronological order —
that's a second, separate reason exact-match expectations against a human edit
should be reset, on top of the content-selection gap above.

**`other_sound_threshold_pct` is per-clip, not universal.** It's relative to each
clip's own loudness distribution, so a value tuned on one recording (noisy webcam:
~10%) does not transfer to another (cleaner phone recording: ~5%). Always run
`silence_classifier/suggest_threshold.js --file <clip>` on a new source before
picking a value — don't reuse a number from a previous session's clip. Also don't
blindly trust its p90 suggestion as the right value, just as the right *starting
point*: on a clip of continuous conversational speech (not clearly separated
sentences), p90 only clears the loudest emphasis peaks, fragmenting sentences into
choppy ~0.5-0.8s blips and roughly halving total kept duration vs. what's actually
speech. Build a test cut and check both total duration against expectations *and*
average segment length (well under ~1s average = over-fragmented) before trusting it.

**A single clip-wide threshold can't serve a clip with mixed-loudness scenes —
use `adaptive_threshold` for those.** Verified case: a quiet talker in a busy,
louder scene (background chatter, other speakers) had her dialogue entirely cut in
two ~3-4s stretches, even after the global threshold was already re-tuned — her
voice cleared the *local* ambient level around her but not the clip-wide cutoff,
confirmed via spectrogram (continuous speech energy present, RMS profiling showed
that scene's local p50 was ~3x the clip's global p50). VAD (`voice_priority`) did
not help — see below, it's non-functional. The real fix, now in
`silence_classifier/amplitude.js` (`getAdaptiveAmplitudeSpans`): compare each
window against a rolling *local* noise floor (percentile within a centered
window, default 6s/25th-percentile) times a ratio (default 2.2x), with
`adaptive_floor_pct` as an absolute safety net so near-total silence isn't kept
just for being the loudest thing nearby. Opt-in via `adaptive_threshold: true`
(the checked-in default config has it on) — off, `other_sound_threshold_pct`
behaves exactly as before, so this doesn't change behavior for a clip that never
sets the flag. Tune `adaptive_ratio` up if it's over-capturing background noise
elsewhere in the clip (whole-clip total duration is the fastest signal), down if
it's still missing quiet talkers.

**Isolated sub-threshold-duration blips are noise, not speech — filtered by
`min_segment_duration_ms`.** The schema's nominal default is 250ms, verified
concretely against a 0.24s blip (see prior investigation: RMS around it 0.99-1.97%
vs. the blip itself 3.21%, a single-window spike with no sustained energy — real
speech doesn't do that). In practice, real talking-head footage needs this much
higher: on one clip, fully half of all raw kept segments were under 1s, most of
them genuine short filler words, not blips — raising the floor to 900ms-1.2s to
drop those was a deliberate editorial call (confirmed with the user first: "delete
everything under 1.2s"), not evidence the classifier was wrong. Before raising
this, check what fraction of segments and total seconds fall under your candidate
cutoff — if it's a large fraction of the whole clip (not just a couple of stray
blips), you're making a content/style call, not a noise-filtering one, and should
confirm that's actually wanted rather than silently gutting real dialogue.

**Silero VAD (`voice_priority`) has tested unreliable in practice** — near-zero
confidence on two different real recordings despite clearly audible speech. Don't
assume it's contributing anything; the amplitude threshold is currently doing
essentially all the real work regardless of `voice_priority`'s setting. Treat this as
a known open bug, not a config issue to tune around.

## MCP tools

The `premiere-pro-mcp` server is registered at **user scope** (`claude mcp add
premiere-pro -s user -- premiere-pro-mcp`), so its ~280 `mcp__premiere-pro__*` tools
are available in every session automatically — no per-project setup needed.

- If those tools don't show up as searchable, the session was started before the
  server was registered, or before the CEP panel connected. The fix is restarting
  Claude Code, not reconfiguring anything. Call `mcp__premiere-pro__ping` first in a
  new session to confirm connectivity before doing anything else with Premiere.
- Never enable the bridge's `unsafe-script` (raw ExtendScript execution) — use only
  its named tools.
- This drives a real, possibly-open Premiere project. Prefer the read-only
  inspection tools (`get_premiere_state`, `get_full_project_overview`,
  `list_project_items`, etc.) to understand current state before making changes.

## Editing workflow

Two ways to turn `keep_segments.json` into an actual video, pick based on segment
count and which editor the user wants:

- **Premiere** (`orchestrate/build_rough_cut.md`): follow it step by step. Key
  invariant: **never delete or modify existing sequences or bins** — rough cuts are
  assembled by inserting "keep" segments onto a brand-new `Rough Cut - <date>`
  sequence. Insert one segment at a time (`set_playhead_position` →
  `set_source_in_out` → `insert_from_source`), and read back the actual resulting
  duration via `get_timeline_summary` after each one to use as the next segment's
  playhead position — don't precompute all playhead positions in advance and batch
  many inserts in one message. Batching ~15+ Premiere tool calls together in one
  message has been observed to silently corrupt clips (stale in/out state reused
  from an earlier call) — caught by verifying `v1CoveragePercent` stays 100 and
  clip count matches segment count after every insert. Doesn't scale well past
  ~50 segments (each one costs several round trips).
- **CapCut / Jianying Pro** (`jianying/README.md`): `build_draft.js` (Node.js, via
  the `capcut-cli` npm package) builds any segment count in one call (tested at
  200+), no per-segment verification loop, but also no live audit — trust is placed
  in the library plus a final duration check on the exported file. This has been
  the only editing path actually exercised so far — the Premiere path above is
  documented but unverified in practice.
  - **Export is manual, by design, not an oversight.** A Python version (via
    `pyJianYingDraft` + the `uiautomation` package) originally automated the
    export click sequence too. Porting that to Node.js/PowerShell was attempted and
    abandoned: Jianying's UI is QML-based and puts nearly all its button/label text
    in one specific accessibility property (`FullDescription`, UIA property
    #30159) that Python's `uiautomation` reads via raw COM — .NET's managed
    automation library (what PowerShell wraps) doesn't expose that property at
    all (`AutomationProperty.LookupById(30159)` returns null, confirmed by
    dumping the live UI tree; the legacy MSAA/IAccessible bridge isn't
    implemented on these controls either). A real fix needs hand-written COM
    interop matching `IUIAutomation6`'s exact vtable layout — bigger, riskier
    effort than was worth it for this. Don't re-attempt this without planning
    for that scope; it's not a quick PowerShell tweak.
  - Draft-creation output was validated byte-identical to the old Python version
    before switching (same duration to the microsecond, frame-matching content at
    the same timeline position) — the swap is safe, only the export automation
    was dropped.
  - Jianying must be closed before `build_draft.js` runs (`capcut-cli compile`
    refuses otherwise) and (re)started after a new draft is created while it was
    already running — it only scans its drafts folder on startup.

`config/rough_cut_config.json` (schema in the sibling `.schema.json`) holds the
tunable thresholds (voice priority, silence threshold, padding, min silence length)
that `silence_classifier/classify.js` reads. Don't hardcode threshold values
elsewhere — route changes through this config.

## Subtitles (`subtitles/`)

Default part of the pipeline (see the Autonomous workflow below — only skip it if
the user explicitly says no subtitles this run), after `keep_segments.json` exists
(built or not-yet-built into a draft) and before/after building the Jianying draft:
generates a two-line Simplified-Chinese SRT and imports it into a draft as its own
text track.

- `subtitles/generate_subtitles.js --keep-segments keep_segments.json --out
  output/subtitles.srt` — builds the exact concatenated timeline audio
  `jianying/build_draft.js` would produce (same clip-by-clip, span-by-span
  cumulative math), transcribes it with a local Whisper model
  (`@xenova/transformers`, no Python, no cloud call), and writes an SRT with two
  lines per cue:
  1. `<A/B/C>: <transcript>` — speaker-tagged dialogue.
  2. an auto-generated action/scene caption for that shot.
- `jianying/add_subtitles.js --draft-name "<name>" --srt output/subtitles.srt` —
  imports that SRT into an *existing* draft via `capcut import-srt` (new text
  track, one segment per cue). Same "Jianying must be closed first" constraint as
  `build_draft.js`.

**Speech may be Cantonese or Mandarin — there's no dedicated Cantonese ("yue")
Whisper language token**, so `generate_subtitles.js` forces `language: "zh"`
regardless; this transcribes Cantonese into Chinese characters reasonably but with
more variance than clear Mandarin. Whatever script Whisper (or the action-caption
translator) outputs, `subtitles/generate_subtitles.js` and
`subtitles/caption_moments.js` both run it through OpenCC (`from: "hk"` — chosen
over `"tw"` because it keeps Cantonese colloquial characters like 哋/佢/嘅 that
`"tw"`'s mapping table drops) to force Simplified — idempotent on text that's
already Simplified, so always run, never conditionally.

**Speaker tags (A/B/C) are a pitch/timbre clustering heuristic
(`subtitles/diarize.js`), not real voiceprint diarization.** There's no
pyannote-equivalent available without Python. It clusters cues by median pitch
(autocorrelation) and spectral centroid (direct-summation DFT — frames are short
enough this doesn't need an FFT dependency), so two speakers with similar voice
(same gender/register) can land in the same cluster and get mislabeled as one
person. Treat it as a first-pass approximation to review, not ground truth — don't
present it as reliable per-speaker attribution without a human pass on footage
where that matters.

**Action captions (`subtitles/caption_moments.js`) are one local
image-caption-model call per *kept span* (not per subtitle cue)**, cached and
reused across every cue inside that span — a 4-sentence answer inside one shot
gets one caption, not four near-identical ones. Quality is generic/model-grade
(small English image-captioning model + local en→zh translation), not a
context-aware human summary — good for "something to show" on every cue for free,
not a polished narration. At ~900+ kept spans this is the slow part of the
pipeline — run it as a background job, don't block on it synchronously, even with
the batching below.

**Captioning is batched, not one-item-at-a-time — a naive per-item loop was the
dominant cost of the whole pipeline at real segment counts.** Frame extraction
(ffmpeg, I/O/seek-bound) runs with bounded concurrency; image-captioning and
translation run as batched model calls. The two models' batched output shapes are
NOT parallel — verified directly against the installed `@xenova/transformers`
build rather than assumed: image-to-text nests one level deeper per item
(`[[{generated_text}], [{generated_text}], ...]`) while translation stays flat
(`[{translation_text}, {translation_text}, ...]`). Getting this backwards silently
misaligns every caption with the wrong item rather than throwing - if you touch
`caption_moments.js`, re-verify both shapes against the actual installed model
before trusting a refactor, don't assume symmetry.

**Speaker clustering must be deterministic — re-running on unchanged input has to
produce identical output.** The k-means++ init in `diarize.js` originally used
`Math.random()`, so the same footage could get a different A/B split (or different
speaker labels) on every run. Fixed with a fixed-seed `mulberry32` PRNG. Don't
reintroduce `Math.random()` there.

**A checkpoint SRT (dialogue-only, no action captions) is written right after
transcription + diarization, before the slow captioning phase starts** — so
killing/crashing during the ~hour-long captioning pass still leaves a usable
single-line subtitle file instead of nothing. The full two-line SRT overwrites it
once captioning finishes.

**Whisper's long-form failure mode is repeating one phrase for several consecutive
chunks** (heavy noise, cross-talk, or non-speech that slipped past the silence
classifier) — `generate_subtitles.js` collapses runs of exact-duplicate transcript
text (keeping the first couple of repeats, dropping the rest) as a cheap accuracy
pass that can't touch legitimately distinct dialogue (which won't be
byte-identical cue to cue).

**`capcut import-srt` joins a cue's multiple text lines with `\n` into one text
segment** (confirmed by reading `capcut-cli`'s `parseSrt` in
`node_modules/capcut-cli/dist/srt.js` directly, not assumed) - this is what makes
the two-line-per-cue SRT format land as two lines in one caption box rather than
two separate captions. If a future `capcut-cli` upgrade changes that parser's
behavior, the two-line format would need re-verifying.

## Autonomous rough-cut workflow (when the user hands you a raw file)

When the user gives you a file (path, or drops it somewhere) and asks for a rough
cut, run the whole pipeline yourself via Bash/PowerShell — they should not need to
type or paste any commands themselves. Do this instead of just printing the command
for them to run:

1. Get the file into `raw/` (move/copy it there if it lives elsewhere), and check
   `raw/` doesn't also contain a human-edited reference/comparison clip left over
   from a prior diffing session — move that out first if so (see the note under
   `## Commands` on why: `classify.js` has no filter and will treat it as source
   footage).
2. Run `node silence_classifier/suggest_threshold.js --file raw/<clip>` to get a
   per-clip starting `other_sound_threshold_pct`. Never carry over a threshold
   number from a previous clip/session — it doesn't transfer (see the per-clip
   note above).
3. Write that value into `config/rough_cut_config.json`, keeping
   `adaptive_threshold: true` for scenes with mixed loudness (quiet talker in a
   loud scene, etc.).
4. Run `node silence_classifier/classify.js --config config/rough_cut_config.json
   --raw-dir raw --out keep_segments.json`.
5. Sanity-check before handing off: total kept duration against what's expected,
   and average segment length (well under ~1s average = over-fragmented — usually
   means the threshold is too aggressive, see guidance above). If it looks off,
   re-tune and re-run step 4 rather than proceeding anyway.
6. Build the draft. Default to the Jianying/CapCut path
   (`node jianying/build_draft.js --keep-segments keep_segments.json --draft-name
   "..."`) since it's the only one actually exercised end-to-end — confirm Jianying
   is closed first, it refuses to run otherwise. Only use the Premiere MCP path
   instead if the user specifically asks for Premiere.
7. Subtitles are part of the default pipeline, not an opt-in extra — always run
   `node subtitles/generate_subtitles.js --keep-segments keep_segments.json --out
   output/subtitles.srt` (background it — see the Subtitles section above, this is
   the slow step) then `node jianying/add_subtitles.js --draft-name "..." --srt
   output/subtitles.srt` against the same draft name used in step 6. Only skip
   this step if the user explicitly says they don't want subtitles for this run.
8. Report what was produced (segment count, total duration) and remind the user
   that opening the app and clicking Export is the one remaining manual step —
   don't imply it also happened. Jianying needs to be (re)started after a new
   draft is created if it was already open. Since subtitles ran, always restate
   the two caveats plainly (not buried): speaker tags A/B/C come from a
   pitch/energy-clustering heuristic, not real voiceprint diarization, and can
   mislabel same-timbre speakers (see Subtitles section); action-summary captions
   are auto-generated per shot (frame sampling + local image captioning +
   translation), not a human review of the ~900 clips — generic/model-grade, not
   a polished narration.

If a step's output looks wrong (durations way off, segments too choppy, etc.),
stop and flag it rather than continuing on to the next step with bad data.

## Commands

```bash
npm install                                    # onnxruntime-node + capcut-cli
node silence_classifier/suggest_threshold.js --file raw/clip.mp4   # per-clip threshold, run this first
node silence_classifier/classify.js \
  --config config/rough_cut_config.json \
  --raw-dir raw --out keep_segments.json       # generate keep_segments.json

# CapCut/Jianying path (close Jianying first):
node jianying/build_draft.js --keep-segments keep_segments.json --draft-name "..."
# then open the draft in Jianying and click Export yourself - no automated export
```

Requires `ffmpeg`/`ffprobe` on `PATH`.

**`classify.js --raw-dir` classifies every video file in that directory, with no
filter.** If you drop a human-edited reference/comparison clip into `raw/` to
diff against (e.g. for the kind of before/after analysis above), move it out
before running `classify.js` — otherwise it gets classified as if it were source
footage and its own kept spans end up appended into the Jianying draft /
Premiere sequence alongside the real footage. `output/keep_segments*.json` is
gitignored (regenerated, not versioned) — don't expect `git log`/`git show` to
recover a past run; if you need to compare against an earlier config, archive
the config itself (not just the output) somewhere before overwriting it.
