# Subtitle + action-summary pipeline: study findings & upgrade plan

Written after studying `raw/before.mp4` and `raw/after.mp4` (the human-edited
reference) and reviewing the current `jianying/subtitles/` implementation. Not yet
implemented — this is the agreed direction, pending go-ahead to build.

## What `after.mp4` actually shows

Sampled frames across `after.mp4` (a car-dealership delivery/walkthrough video)
show it already has two caption tracks burned in:

- **Top line** (bold, editorial action summary): `客户进来`, `老板说开不到门可以爆窗口`,
  `老板说其实和普通的门一样`, `看后车厢周边`, `解释车里面的东西`
- **Bottom line** (dialogue transcript): `那个是你妈妈吗?`, `它也是开不到的`,
  `B: 只是normal啦`, `然后呢现在你start车是不是`

**Key finding: the top-line action captions are not visual descriptions of the
frame — they're paraphrased summaries of what's being said/decided in that
shot.** `老板说开不到门可以爆窗口` ("the boss said if the door won't open, break
the window") describes reported speech, not pixels. A generic image-captioning
model can't produce this — it only ever sees a static frame, never the
transcript, so it's structurally answering the wrong question ("what does this
image show" instead of "what happened/was said here").

## Where the current pipeline falls short

| Stage | Current | Problem |
|---|---|---|
| Dialogue ASR | Local `whisper-small` (transformers.js), forced `language: "zh"`, no Cantonese token | Small model, CPU-bound, weak on Cantonese — vs. Jianying/CapCut's built-in recognizer, already proven accurate on this exact mixed Cantonese/Mandarin/English material |
| Script normalization | OpenCC mechanical Traditional→Simplified conversion | Fixes character variants only — can't fix mis-transcriptions or awkward phrasing, since it never re-reads for meaning |
| Action summary | Local image caption (`vit-gpt2`) + machine translation (`opus-mt-en-zh`), one frame, no transcript context | Wrong input entirely — needs the transcript, not just a frame. This is why current output is "generic/model-grade," per CLAUDE.md |

## Recommended pipeline

Keep the rough-cut stage exactly as-is (already validated, working well —
human just trims further to hit the target). Change the subtitle/caption stage:

1. Build the draft as today (`build_draft.js`) — unchanged.
2. **In Jianying, run its built-in auto-captions on the assembled draft, export
   that SRT.** This is the accuracy-first move: it's the ASR engine already
   trusted on real mixed-language audio, vs. guessing with a small local model.
3. **The Claude Code session running this pipeline reads that SRT directly and
   rewrites it into clean Simplified Chinese** — fixing mis-hearings inferable
   from context, not just swapping character sets.
4. **Action captions: for each kept span, the session reads the sampled frame +
   that span's transcript text directly** (via the Read tool — it has vision)
   and writes the short editorial caption, few-shot primed on the real
   `after.mp4` examples above (short, present-tense, narrative — not a visual
   description).
5. Merge into the same two-line SRT format used today, import via the existing
   `add_subtitles.js` — unchanged.
6. Human review pass in Jianying before export, as already expected.

This trades full unattended automation for accuracy: step 2 adds one manual
click-and-export inside Jianying that wasn't there before. Matches the
stated priority: **accuracy #1, manual work OK.**

## In-session processing, not a `claude -p` subprocess

First pass at this plan called out to `claude -p` (Claude Code's non-interactive
CLI mode) from a Node script for steps 3-4, reasoning that it runs under the
existing Claude Code login rather than needing a separate `ANTHROPIC_API_KEY`.
That part was right, but it missed a bigger point the user raised: **the whole
pipeline already runs inside a live Claude Code session** (the `rough-cut`
skill) — so there's no need to shell out to a *second*, fresh Claude process at
all. Two findings from actually testing `claude -p` drove the correction:

- Every `claude -p` call is a **cold-start session** that reloads full context
  before doing any real work. A trivial no-image test call cost $0.265
  (cost-equivalent), almost entirely `cache_creation` from reloading context,
  not the actual task. Stripping tool/settings loading got it down to $0.06 —
  still a real tax, paid again on every single call.
- A live session never pays that tax — its context is already warm and reused
  turn-to-turn via prompt caching. Reading a file or an image as a normal tool
  call in an ongoing conversation is strictly cheaper than a fresh subprocess,
  *and* more accurate, since it reasons with the full context already
  established (the `after.mp4` reference examples, the rest of the transcript)
  instead of a stripped-down one-shot prompt.

So steps 3-4 are things the session does directly with its own Read tool, not
scripts. The only place this needs more than "just do it inline" is scale:
`caption_moments.js`'s original design existed because CLAUDE.md flags
captioning as the slow part of the pipeline at 900+ spans — doing that many
inline in one conversation would bloat its context badly. At that scale, the
fix is a handful of **background Agent tasks** (e.g. 100-150 spans per agent),
not `claude -p` — same "keep batches off the main context" principle, just
staying inside Claude sessions rather than spawning CLI subprocesses. For a
video the size of this `before.mp4` test (68 spans), that's small enough to do
inline with no delegation.

## Concrete implementation steps

1. `jianying/build_draft.js` — unchanged.
2. Manual step: open the built draft in Jianying, run built-in auto-captions,
   export SRT.
3. The session reads the exported SRT and rewrites it into clean Simplified
   Chinese directly (no script).
4. `jianying/subtitles/generate_subtitles.js` (rewritten — Whisper transcription block
   removed, now takes `--dialogue-srt` pointing at the cleaned SRT from step 3):
   keeps `buildTimeline()`, keeps `diarize.js` speaker labeling (unrelated to
   this change — still local pitch/timbre clustering), writes the checkpoint
   dialogue-only SRT, then builds a **caption manifest** — one entry per unique
   kept span with its extracted frame path and transcript excerpt, no model
   calls at all (pure mechanical step, ffmpeg + timeline math, same as the
   frame-extraction half of the old `caption_moments.js`).
5. The session (or, at large span counts, a handful of background Agents) reads
   the manifest's frames + transcript excerpts directly and fills in each
   caption, few-shot primed on the `after.mp4` examples.
6. `jianying/subtitles/merge_captions.js` (mechanical, no AI): combines the checkpoint
   dialogue SRT + the now-filled caption manifest into the final two-line SRT.
7. Import via existing `add_subtitles.js` — unchanged.
8. Once verified, drop the now-unused `@xenova/transformers` image-caption/
   translation/Whisper usage from `package.json` and `jianying/subtitles/`.

## Test plan: `raw/before.mp4`, draft-only (no Export click)

Validation target is a Jianying draft with correct subtitles in place — not a
rendered output file. "Verified" means the draft is checkable in-app and via
the intermediate JSON/SRT files on disk; clicking Export is still the user's
manual final step and isn't part of this test.

1. Run the existing rough-cut path on `raw/before.mp4` end-to-end
   (`suggest_threshold.js` → `classify.js` → `build_draft.js` into a
   throwaway draft name, e.g. `"Pipeline-v2 Test"`) to get a real
   `keep_segments.json` and a real draft to attach subtitles to — not a
   synthetic/hand-built one, so the test exercises the same span count and
   timing math the real workflow will use.
2. Run the new subtitle stage against that draft: Jianying auto-captions →
   export SRT → session cleans the dialogue text → `generate_subtitles.js`
   builds the caption manifest → session fills in captions →
   `merge_captions.js` → `add_subtitles.js` import. Stop there — no Export.

### Benchmark (record per run, so later changes can be compared against it)

- Wall-clock time per stage: `classify.js`, `build_draft.js`, manifest
  build (`generate_subtitles.js`, frame extraction), `merge_captions.js`,
  `add_subtitles.js` import.
- For the two in-session steps (dialogue cleanup, action captions): how many
  cues/spans were processed inline vs. delegated to background Agents (only
  relevant past the point a video is too large to do inline), and how long
  each took — proxy for cost/usage since there's no per-token invoice to read
  under session-based usage.
- Span count, frame-extraction count, and count of any failed/empty manifest
  items (frame extraction failures) — same "failure shouldn't abort the run"
  tolerance the old `caption_moments.js` had, worth tracking per run.

### Verify

- **Timeline integrity**: SRT cue timestamps fall within
  `keep_segments.json`'s cumulative timeline bounds; span count referenced by
  captions matches the actual number of kept spans for `before.mp4` — no
  drift between the subtitle timeline and the video timeline.
- **Dialogue cleanup accuracy**: diff the Jianying-exported SRT against the
  session-cleaned version; spot-check a sample of changed lines against the
  original audio to confirm cleanup fixed real errors/script inconsistency
  and didn't hallucinate new content.
- **Action captions**: spot-check a sample against their source frame +
  transcript context — does the caption match what's actually happening, and
  does it match the register of the real `after.mp4` examples (short,
  present-tense, narrative) rather than reading like a generic visual
  description.
- **Format integrity**: every cue has both lines, no malformed timestamps, no
  empty captions beyond a small tolerance; `capcut import-srt` accepts the
  file without error.
- **Draft check in Jianying**: open the resulting draft and confirm the text
  track lines up with the video visually before considering the pipeline
  validated — this is the one step that has to be eyeballed, not scripted.

## Results: `before.mp4` mechanics test run (2026-08-11)

Ran everything automatable end to end. **Real accuracy verification (dialogue
cleanup, action captions against real speech) is still blocked on the manual
Jianying auto-caption + SRT export step** — nobody has done that yet, so this
run used a 5-cue hand-written dialogue SRT to prove the code paths work, not
to judge caption quality. Numbers below are real; the dialogue content is a
placeholder.

**Benchmark** (68 kept spans, 203.8s of 368.8s raw kept):

| Stage | Time |
|---|---|
| `suggest_threshold.js` | 0.5s |
| `classify.js` | 11.2s |
| `build_draft.js` (68 segments) | 1m59s |
| `generate_subtitles.js` (audio load + diarization + 68 ffmpeg frame extractions) | 30.9s |
| In-session action captioning (11 of 68 spans, done directly via Read) | small enough to be inline, no timing bottleneck at this scale |
| `merge_captions.js` | 0.2s |
| `add_subtitles.js` import | a few seconds (single CLI call) |

**Verify**:
- Timeline integrity: confirmed — all 68 pieces got a frame, cue timestamps
  in the final SRT match the checkpoint SRT's, no drift.
- Dialogue cleanup accuracy: **not tested this run** (no real Jianying export
  yet — see below).
- Action captions: spot-checked by reading all 11 sampled frames directly.
  Captions matched what's on screen, and where a (synthetic) transcript
  excerpt existed, the caption correctly leaned on it over the frame alone —
  e.g. piece 40's frame doesn't clearly show a trunk, but its transcript
  ("后车厢空间很大") does, and the caption ("介绍车厢空间") followed the
  transcript, matching the `after.mp4` finding that these captions are
  dialogue-driven, not just visual.
- Format integrity: `capcut import-srt` accepted the file without error;
  confirmed the two lines land in one text box (`\n`-joined) as expected.
- Draft check in Jianying: **not yet done** — needs a human to open the
  draft and eyeball it.

**Still blocked**: task of actually running Jianying's built-in auto-captions
on the `"Pipeline-v2 Test"` draft and exporting the SRT — no CLI path exists
for this (confirmed earlier: Jianying's UI automation was already ruled out
as infeasible without deep COM interop work, see the main CLAUDE.md). Needs
the user to do this manually before dialogue-cleanup accuracy and full-scale
action-caption quality can be verified for real.

Side effect of benchmarking: a second throwaway draft,
`"Pipeline-v2 Test Timing"`, was created to get a clean `build_draft.js`
timing number. Harmless clutter — delete it from Jianying's project list if
unwanted.

## Superseding redesign (2026-08-12): Jianying-project-first + content-aware cutting

Everything above this line is a historical record of the first design pass —
kept as-is, not rewritten, since it documents what was actually run. The
design itself has since changed on the user's own direction, in three ways:

1. **The pipeline now starts from an existing Jianying project**, not a raw
   file in `raw/`. The user imports raw footage into Jianying via its own GUI
   (so canvas/fps get auto-configured correctly), places it on a track, and
   runs Jianying's built-in auto-caption on that raw assembly *before* any
   cutting happens — not after, as the original design here assumed.
2. **That raw-timeline transcript now also drives a content-aware cutting
   safety net.** `silence_classifier/dialogue_filter.js` classifies each cue
   as meaningful (2+ real characters, not just interjections like 啊/嗯/呃)
   or filler, and `classify.js`'s new `--dialogue-srt`/`--raw-timeline-map`
   flags union meaningful cues' spans into the keep-spans — additive only,
   so it can only prevent a quiet-but-meaningful phrase from being cut, never
   cause a new cut. Verified directly against real footage: a meaningful cue
   placed in a would-be-cut gap changed total kept duration from 203.8s to
   206.0s, with a new span appearing exactly at the cue's padded position.
3. **Dialogue import is now automatic, not a second manual round-trip.**
   Since the cleaned transcript exists before cutting and this pipeline
   controls exactly what gets kept, `jianying/subtitles/remap_dialogue.js` remaps
   each meaningful cue from raw-timeline time onto the cut timeline (safe by
   construction — every meaningful cue's raw span was unioned into
   `keep_segments.json` in step 2, so it's guaranteed to land inside some
   kept piece) and `jianying/add_subtitles.js` imports it automatically. The
   original design's "step 2: manual auto-caption on the cut footage, export,
   reimport" is gone entirely. Verified: a synthetic cue at raw
   [19.0s, 20.5s] inside a kept piece spanning source [18.66s, 21.48s] at
   timeline position 0 remapped to exactly [0.34s, 1.84s].

**The two open design questions from the original plan are now resolved**:
- Dialogue-context source for action-summary (file path vs. reading the
  draft's text track live): moot — action-summary now always takes
  `output/dialogue_final.srt`, the file rough-cut just produced, not an
  ambiguous file the user has to locate.
- `claude -p` CLI subprocess vs. in-session processing for action captions:
  already resolved earlier in this same design pass — in-session, see
  the CLI-cost findings above. Unchanged by this redesign.

**Draft insertion mechanism** (new, not covered above): rough cuts now get
inserted into the *existing* draft via `jianying/insert_rough_cut.js` (one
`add-video` + one `trim` capcut-cli call per segment, verified against a real
draft this session — see its own header comment and `CLAUDE.md`'s "Editing
workflow" section for why `compile`/`build_draft.js` can't be used for this:
it always creates a brand-new draft and stomps canvas/fps). A real
performance risk was found and fixed before shipping: `add-video`'s asset
dedup hashes the source file whenever a same-named file already exists at
the destination (true for every segment after the first sharing a source
clip), and the in-memory cache that already fixed this once for `compile`
doesn't survive `add-video` always being a fresh subprocess -
`patches/capcut-cli+0.16.0.patch` now persists that cache to disk via
`ROUGH_CUT_SHA1_CACHE_FILE` to close the gap.

**Captions are two independent text tracks now, not one merged two-line
box** — `jianying/subtitles/manifest_to_srt.js` (single-line-per-cue action captions)
supersedes `jianying/subtitles/merge_captions.js`. `jianying/subtitles/generate_subtitles.js`
and `jianying/subtitles/diarize.js` (local Whisper transcription, pitch/timbre speaker
tagging) are also deprecated — dialogue is never locally transcribed
anymore, always Jianying's own auto-caption + ChatGPT cleanup. All three are
left in place with header comments explaining the supersession, not deleted,
per this doc's own established staged-removal convention (see the
`@xenova/transformers`/OpenCC deferral above) — actually delete them once
the new design has one real run against actual Jianying-exported dialogue,
which (as of this section) still hasn't happened.

Every new/changed script in this redesign
(`jianying/list_draft_sources.js`, `jianying/insert_rough_cut.js`,
`silence_classifier/dialogue_filter.js`, `jianying/subtitles/remap_dialogue.js`,
`jianying/subtitles/build_action_manifest.js`, `jianying/subtitles/manifest_to_srt.js`,
`classify.js`/`suggest_threshold.js`'s `--files` mode) was tested against
real `before.mp4` footage and/or the real `"Pipeline-v2 Test"` draft before
being considered done — not just unit-level reasoning. What's still
untested: the actual manual Jianying-auto-caption-on-raw-footage +
ChatGPT-cleanup round-trip has never happened for real; everything downstream
of it has only been verified against hand-written synthetic SRT fixtures.
