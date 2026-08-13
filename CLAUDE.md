# CLAUDE.md

Instructions for Claude Code (and any other agent reading this via `AGENTS.md`,
which symlinks here) when working in this repo.

**Non-technical user guide**: `使用指南.md` (Simplified Chinese, copy-paste
prompts for each step of the actual rough-cut/QA/insert flow below) — point
the user at that file rather than this one if they just want to know what to
type, not how the pipeline works internally.

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
a known open bug, not a config issue to tune around. **Default is now `false`** in
`config/rough_cut_config.json` — confirmed directly, not just inferred from the above:
running `classify.js` on a real project clip (IMG_3141, 786s) with `voice_priority`
true vs. false produced byte-identical `keep_seconds` output (181/181 spans, exact
match) at 14.6s vs. 8.9s wall time - a ~40% speedup for zero difference in kept
content. Turning it back on costs real time and, per the above, buys nothing on this
footage - only re-enable it if testing on different footage shows VAD actually
contributing distinct spans.

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

- **Premiere** (`premiere/build_rough_cut.md`): follow it step by step. Key
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
- **CapCut / Jianying Pro** (`jianying/README.md`): the rough-cut skill
  **always** targets an existing draft — raw footage is always imported into
  Jianying manually first (see the Autonomous rough-cut workflow below), so
  the pipeline never creates a project from scratch.
  - **`insert_rough_cut.js` — the only script the rough-cut skill calls.**
    Inserts kept spans into an *existing* draft (the user's own GUI import,
    so Jianying's own canvas/fps auto-detection is preserved), replacing
    whatever was on `--track-name` (default "Rough Cut") if anything was
    there. The skill always resolves the draft via the project **name** the
    user provides (`jianying/list_draft_sources.js --draft-name "<name>"`) —
    never guesses, never proceeds without one.
    - **Mechanism: clone each kept span from the *original* video-track
      segment it came from, not a fresh import.** An earlier version built
      the cut with `add-video`+`trim` per span (reading straight from the raw
      file onto a brand-new track). That mechanism shipped once and, combined
      with an unrelated ad hoc cleanup step run against the same draft
      afterward, produced a real incident: the original color-graded footage
      got deleted from the draft with no replacement, and a pre-existing
      caption track was left spanning the old, uncut duration while the new
      cut track was shorter — captions no longer lined up with anything.
      Root-caused via the draft's own `.capcut-cli-history/` snapshots (not
      guessed), which showed `insert_rough_cut.js` itself was innocent — the
      deletion happened in a separate, later step. But the underlying
      mechanism was still wrong on its own terms: `add-video` always creates
      a brand-new material from the raw file, so it can never carry over
      whatever color grading/effects the user applied in Jianying's GUI
      (those live in `extra_material_refs` tied to the *original* segment
      ID, not the media file) — a correct run of the old code would still
      have silently dropped grading on every clip. Now: for each kept piece,
      clone the original segment's material + every `extra_material_refs`
      entry with fresh IDs (mirrors `capcut-cli`'s own `duplicate` command,
      verified against `node_modules/capcut-cli/dist/factory.js`'s
      `duplicateSegment`), retime the clone directly, and consolidate every
      clone onto one new video track before finally removing the now-fully-
      cloned-out originals. Grading survives because the clone is a real
      copy of the graded material, not a re-import.
    - **This makes the script one-shot per raw import, not freely
      re-runnable** — once the originals are consumed, a second run has
      nothing left to clone from and fails loudly (`points at segment
      <id>, which no longer exists`), rather than silently doing the wrong
      thing. Confirmed hitting this directly: re-running after tuning
      `classify.js`'s inputs (a fixed `isMeaningfulCue` bug that changed
      `keep_segments.json`) failed exactly this way. To re-run with updated
      `keep_segments.json`, restore the draft first to a snapshot from
      *before* the previous real run of this script (`capcut restore
      "<draft>" --step N` — find the right N by checking
      `.capcut-cli-history/draft_content.json.*.snap` for one where the
      original video track still has its full segment count; a stale
      leftover "Rough Cut" track in that snapshot is fine, `--force`
      replaces it), then re-run. `.capcut-cli-history` only keeps the last
      20 writes, so this window can close — don't let many unrelated writes
      pile up on a draft between an insert and a planned re-run.
      **If the window has already closed** (confirmed hitting this too: all
      20 available snapshots already showed the post-cut state, none from
      before the original raw track was replaced), `jianying/rebuild_raw_timeline_from_track.js
      --draft-name "<name>" --track-name "Rough Cut"` recovers without a
      snapshot at all: it builds a `sources.json`-shaped `rawTimeline`
      directly from the *existing* "Rough Cut" track's own segments (their
      `source_timerange` still points at the original media files — that's
      exactly what the clone mechanism preserves), instead of from raw
      footage placement. `resolvePieceToSegments()` only ever reads
      `sourceClip`/`sourceStart`/`sourceEnd`/`segmentId` off a raw-timeline
      entry — it has no idea whether that entry came from real raw footage
      or from an already-cut track, so `insert_rough_cut.js` runs completely
      unchanged against this synthetic map, including the existing
      caption-track remap (confirmed on a real draft: 774/774 pieces
      matched cleanly with zero errors, 822→774 segments, captions
      correctly remapped, 68 cues dropped for landing entirely in a new cut
      gap). Requires `--force` since the track already exists. This only
      works because a further trim is *subtractive* relative to what's
      already on that track — if the new `keep_segments.json` needs footage
      outside what the current track covers, this can't recover it (that
      content is genuinely gone from the draft), same ceiling as the
      snapshot-restore path above.
    - **Runs as one in-process pass**, not N subprocess calls: loads the
      draft once via `capcut-cli`'s public library exports (`loadDraft`/
      `saveDraft`/`findSegment`/`findMaterialGlobal`/`getTracksByType` — see
      `node_modules/capcut-cli/dist/lib.js`; `duplicateSegment`/
      `removeSegment` themselves are internal-only, not part of the
      published package surface, hence the clone logic is reimplemented
      directly against the loaded draft object), builds every clone and the
      caption remap below in memory, then one `saveDraft`. This also
      sidesteps a real constraint: `duplicateSegment`'s own `--track` mode
      refuses to place a clone onto a track if the *original* segment's full
      untrimmed range overlaps something already placed there — guaranteed
      to trip after a couple of pieces share one original segment. Building
      every clone in memory before it ever touches the shared target track's
      array has nothing to collide with. `patches/capcut-cli+0.16.0.patch`'s
      `ROUGH_CUT_SHA1_CACHE_FILE` no longer applies to this script (no more
      per-segment `add-video` subprocess hashing the source file).
    - **A pre-existing caption/text track is remapped onto the same
      compacted timeline in the same pass**, when the draft has one: each
      cue's raw-timeline position is mapped through `--raw-timeline-map`'s
      `rawTimeline` → source-relative time → the same kept pieces used for
      video (`lib/timeline.js`'s `indexBySourceClip`/`overlappingEntries`,
      shared with `silence_classifier/dialogue_filter.js`'s matching logic).
      A cue entirely inside a cut gap is dropped; one straddling a cut
      boundary is split (cloned, same as video); otherwise it's just
      repositioned. Text segments carry no `source_timerange` (verified
      against a real segment — the field is `null`), so only
      `target_timerange` is ever touched for text. `draft.duration` (the
      project's overall length) is recomputed as the max segment end across
      all tracks afterward — it isn't derived automatically, and leaving it
      at the old, longer value after compacting is exactly the kind of thing
      that only surfaces as a confusing extra-long timeline/export tail
      later, not as an error now.
    - **Path matching across `--files`/`sources.json` must go through the
      same normalization on both sides.** `path.resolve()` on Windows
      produces backslashes; a `sourceClip` read straight from a draft/JSON
      (Jianying's own `material.path`) is forward-slash, as typed. Comparing
      those as bare strings for a `Map` key silently drops every match, with
      no error — confirmed twice: once in `classify.js`'s dialogue-safety-net
      lookup (fixed by resolving both sides before comparing), once in this
      script's own piece-to-segment matching (fixed via
      `lib/timeline.js`'s `sourceClipKey()`, now the one place this
      normalization happens). Any new code matching on `sourceClip` should
      route through `sourceClipKey()`, not compare raw strings.
    - **`--force`/`--dry-run` are boolean switches with no following value** —
      the arg parser must not blindly consume `argv[i+1]` for every flag, or
      two adjacent switches (`--force --dry-run`) silently eat each other
      (confirmed the hard way: `--dry-run` got consumed as `--force`'s
      "value", so a "dry run" quietly wrote to the real draft). Parsed as an
      explicit boolean-flag set now, not a generic key/value pair.
  - **`build_draft.js` / `classify.js --raw-dir` — not part of the rough-cut
    skill anymore.** These create a brand-new draft from a `raw/` folder of
    unimported footage (`compile` always sets canvas/fps from its own spec,
    1920×1080@30fps unless overridden, silently discarding whatever
    Jianying's GUI import would have picked). Left in the repo as standalone
    manual tools, but the autonomous workflow never falls back to them —
    footage always goes through Jianying's own GUI import first, so a draft
    with the given name always already exists by the time the skill runs.
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
  - Jianying must be closed before `build_draft.js` or `insert_rough_cut.js`
    runs (`capcut-cli` refuses to write a draft that's currently open) and
    (re)started afterward if it was already running — it only scans its
    drafts folder on startup, and won't pick up a new/modified draft
    otherwise.

`config/rough_cut_config.json` (schema in the sibling `.schema.json`) holds the
tunable thresholds (voice priority, silence threshold, padding, min silence length)
that `silence_classifier/classify.js` reads. Don't hardcode threshold values
elsewhere — route changes through this config.

## Subtitles (`jianying/subtitles/`)

**Both halves of this section are optional add-ons the user has to ask
for — neither is part of the default rough-cut flow.** The default rough-cut
is a plain amplitude/VAD auto-cut with no caption dependency at all (see the
Autonomous rough-cut workflow below); don't wait on or ask for an
auto-caption SRT unless the user specifically wants the content-aware safety
net described there. Dialogue and action-summary captions are, when the user
does want them, **two independent text tracks**, matching how the
`after.mp4` reference footage actually renders (studied directly, not
assumed — see `jianying/subtitles/PIPELINE_PLAN.md`). Neither is produced by local
transcription:

- **Dialogue is Jianying's own auto-caption, used directly (when the user
  opts in), and translated manually after the cut** — cleanup happens after
  cutting, not before. Jianying's raw auto-caption export (still Simplified
  Chinese, just not yet ChatGPT-polished) is what feeds the content-aware
  cutting safety net in `classify.js` — see `silence_classifier/dialogue_filter.js`
  and the workflow section below; `isMeaningfulCue()` only needs to judge "is
  this filler or real content," which doesn't require clean prose. Once the
  cut is assembled, the dialogue round-trip (re-caption the new cut sequence
  in Jianying, export, translate via ChatGPT copy-paste, import back into
  Jianying) is **entirely manual** — `jianying/subtitles/remap_dialogue.js` +
  `jianying/add_subtitles.js` are not run automatically as part of rough-cut
  (see below for why they're still around).
- **Action-summary captions are the separate, optional `action-summary`
  command** (`.claude/commands/action-summary.md`) — not auto-chained after
  rough-cut, and takes the user's own cut-timeline-aligned dialogue SRT
  (whatever they exported from Jianying post-cut, per above) as an explicit
  input rather than assuming a file our tooling produced.
  `jianying/subtitles/build_action_manifest.js` does the mechanical part (one
  representative frame + overlapping dialogue text per kept span, via the
  unchanged `jianying/subtitles/build_caption_manifest.js`); the Claude Code session
  itself (or, past a few hundred spans, a handful of background Agents)
  reads each frame + transcript excerpt directly and writes the caption —
  see `jianying/subtitles/PIPELINE_PLAN.md` for the real `after.mp4` few-shot
  examples and why this needs to be dialogue-driven, not just visual (a
  generic image-captioning model structurally can't produce captions like
  "老板说开不到门可以爆窗口" — that's reported speech, not something visible
  in any single frame). `jianying/subtitles/manifest_to_srt.js` turns the filled
  manifest into a single-line-per-cue SRT, imported via
  `jianying/add_subtitles.js` under a distinct track name.

**`jianying/subtitles/generate_subtitles.js`, `jianying/subtitles/diarize.js`, and
`jianying/subtitles/merge_captions.js` have been deleted** — local Whisper
transcription, pitch/timbre speaker tagging, and the old two-line dialogue+caption
merge respectively. No current command called any of them; the split-track
design (dialogue via Jianying's own auto-caption, action-summary via
`build_action_manifest.js`) fully superseded all three, and it's now had a
real validated run against actual Jianying-exported dialogue. Recoverable
from git history if ever needed — don't recreate them from scratch.

**`jianying/subtitles/remap_dialogue.js` is no longer called by the rough-cut skill**
— it's still a correct, working tool (see below for what it does and how
it's verified), just no longer wired into the automated workflow now that
dialogue export/translate/reimport is a manual step the user does themselves
after the cut. Left in place for anyone who wants to script that round-trip
themselves instead of doing it by hand in Jianying's UI.

**Content-aware cutting: meaningful dialogue cues get force-kept, filler never
forces a cut, English content is never treated as filler.**
`silence_classifier/dialogue_filter.js`'s `isMeaningfulCue()` treats a cue as
filler only if — after stripping punctuation and the classic non-lexical
interjection tokens (啊/嗯/哦/呃/um/uh/erm/etc.) — nothing is left, or what's
left is under 2 characters. Any Latin-letter content still standing after
that strip is **always** meaningful regardless of length (a lone word like
"OK" or "I" is content, not noise) — this is the "don't remove English
characters" rule. The whole function defaults to "meaningful" whenever
unsure, since a false "this is filler" call would silently discard real
content, exactly the failure mode this feature exists to prevent.
`meaningfulCueSourceSpans()` maps each meaningful cue from the raw (pre-cut)
timeline back to (source file, source-relative time), splitting across a
raw-track segment boundary if the cue straddles one, so no part of a
meaningful cue is ever silently dropped just for crossing a boundary.
`classify.js`'s `--dialogue-srt`/`--raw-timeline-map` flags union these spans
directly into `extraKeepSpans` — the same merge/pad/filter pipeline
(`mergeSpans`, `mergeClose`, `padSpans`) then applies uniformly to voice,
amplitude, *and* transcript spans together. This is deliberately
**additive-only**: it can only widen a keep-span, never narrow one. Verified
directly (not just unit-tested): a meaningful cue placed in what would
otherwise be a cut gap changed `keep_segments.json`'s total kept duration
from 203.8s to 206.0s, with a new span appearing exactly at the cue's
(padded) position; a filler-only cue in the same test contributed nothing.

**The short-segment length filter (`filterShortSpans`,
`min_segment_duration_ms`) exempts anything that overlaps a meaningful/
English `extraKeepSpans` entry.** Before this, a short span was dropped
purely on duration even if it came from a meaningful cue or English word
unioned in above — since the union happens before the same filter pipeline,
a short-but-meaningful span could get merged in only to be filtered right
back out. `filterShortSpans(spans, minDurationS, protectedSpans)` now checks
overlap against `protectedSpans` (the same `extraKeepSpans`) before dropping
anything under the length cutoff: pure amplitude/VAD-derived short spans
(no dialogue signal) are still filtered exactly as before, but a short span
that overlaps a meaningful-word or English-content cue survives regardless
of duration. This reuses the *existing* `min_segment_duration_ms` config
value as the cutoff — no separate threshold. `classifyClip`'s result now
also reports `dropped_short_spans` and `protected_short_spans` per clip so a
run's sanity check can see how many short spans were exempted this way.

**`jianying/subtitles/remap_dialogue.js` reuses the exact same content-aware filter
in reverse** — for each meaningful cue, map raw time → source-relative time
→ (via `keep_segments.json`'s own piece bounds, indexed per source clip since
kept pieces for one clip aren't contiguous in source time) → cut-timeline
time. Safe by construction: every meaningful cue's raw span was unioned into
`keep_segments.json` back in `classify.js`, so it should always land inside
some kept piece — a cue that doesn't gets a loud warning and is dropped, not
silently lost. Verified against real footage: a synthetic cue at raw
[19.0s, 20.5s] inside a kept piece spanning source [18.66s, 21.48s] at
timeline position 0 remapped to exactly [0.34s, 1.84s].

**`capcut import-srt` joins a cue's multiple text lines with `\n` into one text
segment** (confirmed by reading `capcut-cli`'s `parseSrt` directly, not
assumed) — irrelevant to the current split-track design (every SRT this
pipeline produces now is single-line-per-cue), but worth knowing if a future
change reintroduces multi-line cues.

## Autonomous rough-cut workflow (when the user gives you a Jianying project)

**No `raw/` or `output/` folder in this workflow.** Raw footage always lives
inside a Jianying project the user built themselves through Jianying's own
GUI — our tooling classifies it in place and never copies it anywhere.
Generated files (`sources.json`, `keep_segments.json`,
`rough_cut_progress.json`, and anything else this workflow or the optional
add-ons produce) go into **`projects/<draft-name>/`** — one folder per
project, entirely gitignored. `jianying/list_draft_sources.js` creates that
folder (it's the first script that runs), everything after it writes into the
same place. This workflow **never** falls back to `raw/`,
`classify.js --raw-dir`, or `jianying/build_draft.js` — it always resolves an
*existing* draft by the project name the user gives you, and fails loudly
rather than creating a new project if that name doesn't resolve.

**Default is caption-free, fast, and stable — just an auto-cut.** The
dialogue SRT / content-aware safety net (below) and the `action-summary`
command are both **optional add-ons the user has to ask for**, not part of
this default flow. Only the project name is required. Don't ask for or wait
on an auto-caption SRT before running this — that manual caption/export step
is now entirely skippable for a normal rough cut.

The user's own workflow starts with one manual step outside our tooling:
they import raw footage (possibly multiple files) into a Jianying project
via Jianying's own GUI (which auto-configures canvas/fps for that footage —
**confirm the HDR conversion tool (HDR 转换工具) toggle is turned on during
this import**, since that's a GUI-only setting we can't script) and place it
on a track in chronological order. **The project name is the only required
input** — if missing, ask for it before doing anything else, don't guess.

Run every step below yourself via Bash/PowerShell — the user should not need
to type or paste any commands:

1. Resolve the draft and its sources:
   `node jianying/list_draft_sources.js --draft-name "<project>"`. Fails
   loudly (pointing at `capcut projects "<name>"`) if no draft by that name
   exists — never proceed on a guess, and never create a new draft as a
   fallback. Creates `projects/<project>/` and writes `sources.json` there
   automatically (also prints the same JSON to stdout). Its JSON has two
   parts: `sourceFiles` (distinct raw video files already imported —
   classify these **in place**) and `rawTimeline` (each entry now also
   carries the original draft segment's `segmentId` — required by
   `insert_rough_cut.js` in step 6, not just the optional dialogue safety net
   below). If more than one video track exists on the draft already (e.g.
   re-running this after a prior rough cut), it auto-picks the track with the
   most segments as "the raw footage" and warns — that heuristic gets it
   backwards once a rough cut's own output track has more, smaller segments
   than the real raw import, so pass `--track-index` explicitly whenever more
   than one video track is present rather than trusting the auto-pick.
2. Get a per-file threshold:
   `node silence_classifier/suggest_threshold.js --files <sourceFiles, comma-separated>`
   — one suggested value per file, printed in order, never reused across
   clips/sessions (per-clip guidance is unchanged, and matters more now that
   one project can hold several files).
3. Write the first file's suggested value into `config/rough_cut_config.json`
   as the fallback default, keeping `adaptive_threshold: true`.
4. Classify, amplitude/VAD only, no dialogue input:
   `node silence_classifier/classify.js --config config/rough_cut_config.json
   --files <sourceFiles> --thresholds <values from step 2>
   --out projects/<project>/keep_segments.json`.
   Without a transcript there's no way to tell a short meaningful word (an
   acronym, a short English word) apart from a noise blip on amplitude alone
   — that's a hard capability boundary, not a bug. If short real words are
   getting cut, the lever here is `min_segment_duration_ms` (lower it a bit),
   not trying to guess meaning from the waveform.
5. Sanity-check before handing off: total kept duration against what's
   expected, and average segment length (well under ~1s = over-fragmented).
   Re-tune and re-run rather than proceeding on a bad result. **If a dialogue
   SRT is available** (the safety net below, or any other source), also run
   `silence_classifier/qa_transcript_report.js` here — before step 6, not
   after — so a review/fix cycle happens against `keep_segments.json` while
   it's still cheap to change, not against the already-inserted draft. See
   the safety net section below for exact usage; it's the same tool either
   way, this is just about *when* to run it.
6. Insert into the existing draft (never a new one):
   `node jianying/insert_rough_cut.js --draft-name "<project>" --keep-segments
   projects/<project>/keep_segments.json --raw-timeline-map
   projects/<project>/sources.json`. Confirm Jianying is closed first. Clones
   each kept span from its original segment (preserving any color grading/
   effects applied in Jianying's GUI) rather than re-importing from the raw
   file — see the mechanism note under "CapCut / Jianying Pro" above. Try a
   plain run first (no `--dry-run`); use `--dry-run` instead only if you want
   to sanity-check counts/durations before writing, e.g. re-running against a
   draft that already has a same-named track. If the draft already has a
   caption/text track (from Jianying's own auto-caption, run any time before
   this step — see the dialogue safety net below for how to also feed it
   into classification), its cues are remapped onto the same compacted
   timeline in this same pass — no separate step needed for that. Writes
   live progress to `projects/<project>/rough_cut_progress.json`
   periodically (`segmentsDone`/`segmentsTotal`, `percent`, `status`) — for a
   long insert, point the user at that file (or read it yourself) instead of
   guessing progress from elapsed time.
7. Report results: segment count, total kept duration, and (if a caption
   track was present) how many cues were remapped vs. dropped for falling
   entirely in a cut gap. Export is the user's one remaining manual step.
   Mention, briefly, that a content-aware dialogue safety net and the
   `action-summary` command both exist as optional add-ons if they ever want
   either — but don't push them or wait on captions unless the user actually
   asks.

### Optional add-on: content-aware dialogue safety net

Only do this if the user explicitly asks for better recall on short
meaningful/English utterances (acronyms, short words) that pure amplitude/VAD
might cut — or for cutting that's driven by dialogue content generally,
rather than volume alone. It requires an extra manual step from the user
first: run Jianying's built-in auto-caption on the raw assembly (no ChatGPT
cleanup needed yet — that's fine to do later). If it's still sitting in the
draft as a text track rather than an exported file, get it into file form
first: `capcut export-srt "<draft path>" > projects/<project>/dialogue_raw.srt`
(capture stdout via Node's `spawnSync` and write with `fs.writeFileSync(...,
"utf-8")` rather than a shell `>` redirect — Windows shell redirection has
already mangled UTF-8 Chinese text here once). Then:

- `projects/<project>/sources.json` from step 1 already has `rawTimeline` —
  reuse it directly as `--raw-timeline-map`, no need to re-run step 1.
- Add `--dialogue-srt projects/<project>/dialogue_raw.srt
  --raw-timeline-map projects/<project>/sources.json` to the `classify.js`
  call in step 4. The dialogue SRT's meaningful cues (real
  content, not just interjections like 啊/嗯/呃 — and never English content,
  which is always treated as meaningful regardless of length — see the
  Subtitles section) get unioned into the keep-spans so a quiet-but-meaningful
  phrase doesn't get cut just for falling under the amplitude threshold, and
  a short segment carrying meaningful/English content is exempted from the
  `min_segment_duration_ms` length filter that would otherwise drop it. This
  is additive-only — it can only keep more, never cut more. `classify.js`
  prints how much the safety net added and how many short spans it protected
  — fold that into step 5's sanity check. If the printed total looks
  suspiciously unaffected by `--dialogue-srt` (kept duration/segment count
  identical to a run without it), don't assume the net had nothing to add —
  check for a silent `sourceClip` path-matching failure first (see the
  `sourceClipKey()` note under "CapCut / Jianying Pro" above); this exact
  failure mode has happened before and produces no error, just a no-op.
- If the same auto-caption track is still present on the draft when
  `insert_rough_cut.js` runs (step 6), its cues get automatically remapped
  onto the compacted cut timeline in that same pass — **no separate
  re-caption-the-cut-sequence step is needed just to fix positions.**
  Translate/cleanup via ChatGPT and reimport is still a manual step
  afterward if the user wants that, and so is `action-summary` — see its own
  section below.
- **QA the result with `silence_classifier/qa_transcript_report.js`** once
  you have a dialogue SRT — run it **before** `insert_rough_cut.js` (step 6),
  against `keep_segments.json` directly, so any fix is a cheap JSON edit
  instead of a redo against an already-inserted draft:
  `node silence_classifier/qa_transcript_report.js --keep-segments
  projects/<project>/keep_segments.json --dialogue-srt
  projects/<project>/dialogue_raw.srt --raw-timeline-map
  projects/<project>/sources.json --out-dir projects/<project>`. Writes
  exactly two files, named for what they mean rather than the mechanism
  behind them:
  - `excluded_review.txt` — **candidates to cut.** Filler-only cues
    (`dialogue_filter.js`'s `isMeaningfulCue` — non-lexical interjections
    only; deliberately has no length-based cutoff, since Chinese has plenty
    of meaningful one-character words — 对/好/是/系/有/我/他/讲/行/噉/啱 and
    more all count as content, not filler, regardless of length) that are
    currently kept anyway, audible enough to clear the amplitude/VAD
    threshold on their own despite carrying no real content. Grouped by cue
    text with counts (e.g. `"哦" x107`) rather than one line per occurrence —
    almost all filler collapses into a handful of known interjections, and a
    flat list of hundreds of near-identical lines is unreviewable. Starts
    with a separate, loud **FLAGGED** section for the one thing that's a bug
    rather than an editorial call: a *meaningful* cue that ended up in a cut
    span, which should be structurally impossible given the safety net above
    (it unions every meaningful cue's span into `keep_seconds` already) — a
    stale `keep_segments.json` vs. this SRT, a raw-timeline-map mismatch, a
    rounding artifact at a file boundary, etc. **Report-only, not an
    auto-cut** — a mistranscribed cue could otherwise silently delete real
    content, so a human decides per case.
  - `included_review.txt` — **the script.** Every meaningful cue currently
    kept, in chronological cut-timeline order, formatted as a plain
    timecode + text transcript. This is deliberately not a diagnostic dump —
    it's meant to be read top to bottom like the actual planned video, so
    reviewing it means reading the video's script, not decoding a report
    format.
  - Filler that's already correctly cut (not kept, not flagged) isn't
    written to either file — there's nothing to review about a call that was
    made correctly, only a count in the console summary, so both files stay
    focused on what actually needs a decision.
  - Gives clip name + exact source-relative timecodes in `keep_segments.json`'s
    own coordinate system where relevant, so a fix is a direct edit to a
    `keep_seconds` entry — deliberately not a separate edit-format
    round-trip, to keep this fast. Pure JSON/SRT text processing, no audio
    decode — sub-second even on a multi-thousand-cue transcript.
  - `--repetition-manifest <path>` (optional) tells this script about
    deliberate repetition-trim decisions (see below) so a meaningful cue
    that was cut on purpose shows up under a separate **Explained** section
    instead of muddying the FLAGGED bug list.

- **Once `excluded_review.txt`'s filler candidates are reviewed and trusted,
  apply them** with `silence_classifier/apply_filler_exclusions.js
  --keep-segments ... --dialogue-srt ... --raw-timeline-map ... --out
  keep_segments.json` — mechanical, not a judgment call (unlike repetition
  below): `isMeaningfulCue` already decided these carry no content, so there's
  nothing case-by-case to weigh. Re-run `qa_transcript_report.js` afterward to
  confirm `excluded_review.txt` drops to 0 exclude-candidates.

- **Repetition needs actual judgment, not rules — this is what "we only ever
  run via Claude Code" is for.** A rules-only pass at "is this repeated text
  redundant" (prefix/overlap matching between adjacent cues) was tried and
  produced too many false positives to trust — mostly normal speech
  continuing into more content, not real redundancy (see the git history/PR
  discussion for the study). What *did* turn out to have a clean, checkable
  signal: `silence_classifier/build_repetition_manifest.js` detects (a) exact
  back-to-back duplicate cues and (b) the same short unit repeated 3+ times
  within one cue (digit runs like "2,000" excluded), and writes a manifest
  with `decision`/`reason` fields left blank. **Claude reads that manifest
  directly (Read tool) and fills in `"keep"` or `"cut"` + a one-line reason
  per entry** — not scripted, because the same repeated shape can be a
  genuine stutter (cut), deliberate emphasis like "对对对" = "yes yes yes"
  (keep), onomatopoeia like "嘟嘟嘟" describing an actual beep (keep, that's
  descriptive content), or laughter (judgment call - authenticity vs.
  pacing). Past a few hundred entries, delegate to a handful of background
  Agents instead of holding it all in one session's context, same scale
  guidance as action-summary. A user can also flag specific cues by hand
  (timecode + text) for the same treatment — add them to the manifest as
  `"pattern": "user_flagged"` entries with `occurrences` (clip + source-
  relative `srcStart`/`srcEnd`, found via `dialogue_raw.srt` +
  `sources.json`) and a `decision`/`reason` already filled in, same schema.
  Then `silence_classifier/apply_repetition_decisions.js --manifest ...
  --keep-segments ... --out keep_segments.json` applies every `"cut"`: for
  `exact_duplicate` it keeps the *first* occurrence and removes the rest
  (never drops every instance of something that was actually said — trimming
  a redundant repeat to one instance is an edit, deleting that it happened
  isn't what "cut" means here); for other patterns it removes the entire
  occurrence (no sub-cue-level word timing exists in an SRT to trim just the
  repeated portion out of the middle of one cue).

- **Paraphrase redundancy (same claim restated in different words) is a
  separate problem from the exact/intra-cue repetition above, and a cheap
  mechanical filter for it doesn't work — verified directly, not assumed.**
  `build_repetition_manifest.js`'s exact-text and intra-cue-repeat detectors
  only catch literal repeats; two adjacent cues saying the same thing in
  different wording (e.g. "系咯即呢边系新嘅 𠮶边系旧" / "我呢边系新 𠮶边系旧啊",
  both "this side is new, that side is old") slip through entirely. The
  obvious next idea — flag cue pairs by character-bigram similarity — was
  built and calibrated against real data (43 confirmed-redundant pairs from
  a real project vs. all 1,622 normal adjacent-cue pairs from the same
  transcript) before trusting it, and it failed: the best threshold (0.3)
  caught only 63% of real redundancy while still flagging 203 false
  positives, because normal follow-on speech ("auto hold" → "不要auto
  hold") scores *higher* on lexical overlap than genuine restatement
  ("现在不用给钱了" → "现在每个月免费", 0.167). Same root cause as the
  exact-repeat rules-only pass above: a text-similarity heuristic can't tell
  "restating the same point" from "continuing the point with more words" —
  there is no mechanical substitute for reading the transcript for meaning.
  **This is now folded into the broader semantic-review pass below**, rather
  than handled as its own chunked, ad hoc effort — see "Semantic review
  (INCLUDE/EXCLUDE/REVIEW)".

- **Semantic review (INCLUDE/EXCLUDE/REVIEW): one consolidated Sonnet pass
  over whatever's left after the mechanical passes above, not a chunked
  paraphrase-only effort.** Paraphrase redundancy, false starts, corrections,
  mistakes, irrelevant conversation, production/setup speech, and
  continuity-context judgment all need the same thing a text-similarity
  heuristic can't provide — actually reading the cue for meaning — so they're
  handled together, in one pass, rather than as separate ad hoc efforts.
  `silence_classifier/build_semantic_review_manifest.js` (mechanical only —
  reuses `isMeaningfulCue`/timeline helpers, no judgment) enumerates every
  currently-kept meaningful cue — i.e. it runs *after* filler exclusion and
  repetition-manifest application, so it only ever sees content those
  mechanical passes didn't already resolve — into a flat manifest,
  `projects/<project>/semantic_review.json` (deliberately its own file, not
  `repetition_manifest.json`: a semantic entry is one cue/one span, not a
  multi-occurrence pattern, and its decision needs to survive indefinitely
  rather than being cheaply rediscoverable by a fresh scan the way exact-
  duplicate detection is — see the script's own header for the carry-forward-
  by-cue-identity mechanism that makes re-runs only surface genuinely new
  cues). **Claude reads that manifest directly (Read tool) and fills in
  `"category"` (a short free-text label — `"false_start"`, `"correction"`,
  `"irrelevant_chat"`, `"production_speech"`, `"paraphrase_repeat"`,
  `"continuity_context"`, or anything else that actually fits — not a fixed
  enum) + `"decision"` (`"include"` | `"exclude"` | `"review"`) + `"reason"`
  per entry, same discipline as the repetition manifest.
  `silence_classifier/apply_semantic_decisions.js` then applies every
  `"exclude"` (cuts that one span — no "keep the first occurrence" logic
  needed, unlike repetition's `exact_duplicate`, since every entry here is
  already a single cue) and auto-prunes any stranded sub-`min_segment_
  duration_ms` sliver left behind, same mechanism as
  `apply_repetition_decisions.js` below.
  **`"review"` is never auto-cut** — an entry decided `"review"` is left in
  `keep_segments.json` exactly as it was; the manifest itself (any entry with
  `decision: "review"`) *is* the review list, so there's no separate file
  that can drift out of sync with it.
  **Default is one manifest, not chunked** — the old `semantic_review_chunk_
  *.json` approach (splitting the transcript into N overlapping pieces, each
  read by a separate agent) is retired as the default: a background Agent
  spawn pays its own cold-start context tax regardless of the chunk's actual
  size, so for a transcript that fits one Sonnet turn, chunking costs *more*
  total tokens than a single pass, not less. Confirmed on this real project:
  the full post-mechanical-pass manifest was 1353 cues / 11,412 characters —
  comfortably one pass. The builder script prints entry/character counts on
  every write specifically so this is a judgment call made with real numbers,
  not a guess; there is deliberately no hardcoded cue-count/char-count
  threshold. If a transcript is ever genuinely too large for one pass, the
  fallback is the same manual, ad hoc split (read the manifest, divide it by
  hand across a couple of Read/Write passes or background Agents) that
  existed before this script did — not new code, since baking in an
  arbitrary number now would be guessing, not measuring. Usage:
  `node silence_classifier/build_semantic_review_manifest.js --keep-segments
  projects/<project>/keep_segments.json --dialogue-srt
  projects/<project>/dialogue_raw.srt --raw-timeline-map
  projects/<project>/sources.json --out
  projects/<project>/semantic_review.json`, then fill in the manifest, then
  `node silence_classifier/apply_semantic_decisions.js --manifest
  projects/<project>/semantic_review.json --keep-segments
  projects/<project>/keep_segments.json --out
  projects/<project>/keep_segments.json --dialogue-srt
  projects/<project>/dialogue_raw.srt --raw-timeline-map
  projects/<project>/sources.json`. Run this **after** the repetition
  workflow above and **before** the final `qa_transcript_report.js` sanity
  check (pass it `--semantic-manifest projects/<project>/semantic_review.json`
  alongside `--repetition-manifest` so an excluded semantic cue is recognized
  as an explained cut rather than misreported as a bug), which runs
  **before** `insert_rough_cut.js` (step 6) — same "cheap JSON edit now,
  not an already-inserted-draft redo later" reasoning as everywhere else in
  this workflow.

- **`subtractSpan`-based edits (repetition/paraphrase/filler/semantic cuts) can strand
  near-zero-duration silent slivers that never went through
  `min_segment_duration_ms` filtering.** That floor only runs once, inside
  `classify.js`, before any of these later cuts exist — if a cut's boundary
  lands a hair short of the kept piece's own edge, the leftover fragment
  keeps whatever duration is left, however tiny. Confirmed on real footage:
  after a round of repetition/paraphrase cuts, an RMS scan of every kept
  span found 98 spans under 1.2s (most under 0.15s, RMS near 0%, zero
  dialogue overlap) that had silently accumulated — 14.1s of pure artifact
  sitting in `keep_segments.json` undetected until directly measured (the
  existing QA tooling doesn't check kept-span RMS, only cut-vs-meaningful
  overlap, so this class of bug is invisible to `qa_transcript_report.js`).
  `apply_repetition_decisions.js`, `apply_filler_exclusions.js`, and
  `apply_semantic_decisions.js` all auto-prune these afterward, reusing
  `classify.js`'s own `filterShortSpans` with `dialogue_filter.js`'s
  `meaningfulCueSourceSpans` as the protected-span check — the identical
  protection logic `classify.js` used originally, so this can only ever
  remove artifacts, never real content. For `apply_repetition_decisions.js`
  and `apply_semantic_decisions.js` this requires the optional
  `--dialogue-srt`/`--raw-timeline-map` flags (omit both to skip pruning
  entirely, unchanged behavior); `apply_filler_exclusions.js`
  already requires those flags for its main job, so pruning there is
  automatic. Not a substitute for `qa_transcript_report.js` — that still
  catches content-level problems (filler-kept, meaningful-cut); this only
  catches the specific artifact shape of "technically a span, practically
  silence."

If a step's output looks wrong (durations way off, segments too choppy, a
verification mismatch from `insert_rough_cut.js`, etc.), stop and flag it
rather than continuing on to the next step with bad data.

## Autonomous action-summary workflow (separate, optional, user-triggered)

Never run this automatically as part of the rough-cut workflow above — only
when the user explicitly asks for it via the `action-summary` command. They've
said a fully manual pass is "very accurate" to them, so don't assume this is
wanted.

1. Resolve the draft (existence check only — same pattern as rough-cut's step
   1, no need for the full source/raw-timeline read here).
2. Locate `projects/<project>/keep_segments.json` for this draft (produced by
   the rough-cut workflow — if missing, tell the user to run rough-cut first)
   **and ask the user for the cut-timeline-aligned dialogue SRT path** — since
   dialogue export/translate/reimport is now a fully manual step (see the
   Autonomous rough-cut workflow above), there's no fixed file our tooling
   produces for this anymore. Whatever they exported from Jianying's
   auto-caption on the *cut* sequence works — translated or not, since only
   the timing and overlap with each kept span matters here, not the language.
3. Build the caption manifest (mechanical — frame extraction + dialogue
   context, no model calls): `node jianying/subtitles/build_action_manifest.js
   --keep-segments projects/<project>/keep_segments.json --dialogue-srt
   <cut-timeline SRT path> --out projects/<project>/caption_manifest.json
   --frames-dir projects/<project>/caption_frames`.
4. Fill in captions yourself: read each manifest entry's `framePath` (+
   `transcriptExcerpt` for context) directly via the Read tool, few-shot
   primed on the real `after.mp4` examples in `jianying/subtitles/PIPELINE_PLAN.md`
   (short, present-tense, narrative, dialogue-driven when relevant — not a
   generic visual description), and write the result into `caption`. Do this
   inline for a normal-sized video; past a few hundred spans, delegate to a
   handful of background Agents instead (each handling a large chunk) rather
   than holding hundreds of frames in this session's own context — see
   `jianying/subtitles/PIPELINE_PLAN.md` for the scale guidance.
5. Turn the filled manifest into an SRT (mechanical): `node
   jianying/subtitles/manifest_to_srt.js --keep-segments
   projects/<project>/keep_segments.json --manifest
   projects/<project>/caption_manifest.json --out
   projects/<project>/action_captions.srt`.
6. Import as its own separate track: `node jianying/add_subtitles.js
   --draft-name "<project>" --srt projects/<project>/action_captions.srt
   --track-name "动作字幕 (Action Captions)"` — a distinct name so it can't
   collide with the dialogue track the user imports manually.
7. Report span count and captions filled vs. left blank, and restate plainly
   (not buried): this is an auto-generated pass, not human-reviewed.

If a step's output looks wrong, stop and flag it rather than continuing on to
the next step with bad data.

## Commands

```bash
npm install                                    # onnxruntime-node + capcut-cli

# Rough-cut skill (default, fast path): always an existing Jianying project
# (close Jianying first). No raw/ or output/ folder, no caption dependency -
# generated files land in projects/<name>/, gitignored. list_draft_sources.js
# creates that folder and writes sources.json into it automatically.
node jianying/list_draft_sources.js --draft-name "..."
node silence_classifier/suggest_threshold.js --files <sourceFiles from sources.json, comma-separated>
node silence_classifier/classify.js \
  --config config/rough_cut_config.json \
  --files <sourceFiles> --thresholds <values from suggest_threshold> \
  --out projects/<name>/keep_segments.json
node jianying/insert_rough_cut.js --draft-name "..." --keep-segments projects/<name>/keep_segments.json \
  --raw-timeline-map projects/<name>/sources.json
# clones each kept span from its original segment (preserves GUI-applied
# grading/effects) and remaps an existing caption track onto the compacted
# timeline in the same pass, if the draft has one. progress:
# projects/<name>/rough_cut_progress.json. --force to replace a same-named
# track from a prior run; --dry-run to preview without writing.
# then manually: export in Jianying

# Optional add-on: content-aware dialogue safety net (only if the user asks
# for better recall on short meaningful/English utterances, or dialogue-
# driven cutting generally) - add these two flags to the classify.js call
# above instead of running it plain:
#   --dialogue-srt <Jianying auto-caption SRT, uncleaned> --raw-timeline-map projects/<name>/sources.json
# (capcut export-srt "<draft>" first if it's still a text track, not a file)

# Deterministic checks first - filler, then repetition (see CLAUDE.md's
# "Content-aware cutting" section for the full workflow of each):
node silence_classifier/apply_filler_exclusions.js --keep-segments projects/<name>/keep_segments.json \
  --dialogue-srt projects/<name>/dialogue_raw.srt --raw-timeline-map projects/<name>/sources.json \
  --out projects/<name>/keep_segments.json
node silence_classifier/build_repetition_manifest.js --keep-segments projects/<name>/keep_segments.json \
  --dialogue-srt projects/<name>/dialogue_raw.srt --raw-timeline-map projects/<name>/sources.json \
  --out projects/<name>/repetition_manifest.json
# ... fill in decision/reason directly, then:
node silence_classifier/apply_repetition_decisions.js --manifest projects/<name>/repetition_manifest.json \
  --keep-segments projects/<name>/keep_segments.json --out projects/<name>/keep_segments.json \
  --dialogue-srt projects/<name>/dialogue_raw.srt --raw-timeline-map projects/<name>/sources.json

# THEN one consolidated semantic pass over whatever's left (paraphrase
# redundancy, false starts, corrections, mistakes, irrelevant chat,
# production speech, continuity context) - one manifest, not chunked, by
# default (see CLAUDE.md's "Semantic review" section for the threshold-free
# reasoning):
node silence_classifier/build_semantic_review_manifest.js --keep-segments projects/<name>/keep_segments.json \
  --dialogue-srt projects/<name>/dialogue_raw.srt --raw-timeline-map projects/<name>/sources.json \
  --out projects/<name>/semantic_review.json
# ... fill in category/decision ("include"|"exclude"|"review")/reason directly, then:
node silence_classifier/apply_semantic_decisions.js --manifest projects/<name>/semantic_review.json \
  --keep-segments projects/<name>/keep_segments.json --out projects/<name>/keep_segments.json \
  --dialogue-srt projects/<name>/dialogue_raw.srt --raw-timeline-map projects/<name>/sources.json

# QA BEFORE inserting - review/fix keep_segments.json while it's still cheap:
node silence_classifier/qa_transcript_report.js --keep-segments projects/<name>/keep_segments.json \
  --dialogue-srt projects/<name>/dialogue_raw.srt --raw-timeline-map projects/<name>/sources.json \
  --repetition-manifest projects/<name>/repetition_manifest.json \
  --semantic-manifest projects/<name>/semantic_review.json \
  --out-dir projects/<name>
# writes excluded_review.txt (filler-only cues kept anyway - candidates to
# cut, plus a FLAGGED section if a meaningful cue ended up in a cut span,
# which is a bug not an editorial call) and included_review.txt (the
# resulting video's script - every meaningful cue kept, in order). fast,
# no audio decode.
# then insert as above - if that same caption track is still on the draft,
# its cues are remapped automatically, no separate re-caption-the-cut step
# needed. Translate via ChatGPT / reimport is still manual if wanted.

# Optional add-on: action-summary captions, once you have a cut-timeline SRT
# (see Autonomous action-summary workflow) - point it at whatever SRT you
# exported from Jianying's auto-caption run on the cut sequence
node jianying/subtitles/build_action_manifest.js --keep-segments projects/<name>/keep_segments.json \
  --dialogue-srt <cut-timeline SRT> --out projects/<name>/caption_manifest.json --frames-dir projects/<name>/caption_frames
# ... fill in captions directly, then:
node jianying/subtitles/manifest_to_srt.js --keep-segments projects/<name>/keep_segments.json \
  --manifest projects/<name>/caption_manifest.json --out projects/<name>/action_captions.srt
node jianying/add_subtitles.js --draft-name "..." --srt projects/<name>/action_captions.srt --track-name "动作字幕 (Action Captions)"
```

Requires `ffmpeg`/`ffprobe` on `PATH`.

**`raw/`, `classify.js --raw-dir`, and `jianying/build_draft.js`
are not part of the rough-cut skill** — they remain in the repo only for the
separate Premiere path (`premiere/build_rough_cut.md`, see `README.md`)
and as standalone manual tools for a user with no pre-existing Jianying
project. The Jianying rough-cut workflow always requires a project name and
resolves an existing draft via `list_draft_sources.js` — it never creates one
and never reads from `raw/`. If you do use `--raw-dir` for the Premiere path,
note it classifies every video file in that directory with no filter — move
a human-edited reference/comparison clip out of `raw/` before running it, or
its own kept spans end up appended into the sequence alongside the real
footage. `projects/` is entirely gitignored (regenerated, not versioned) —
don't expect `git log`/`git show` to recover a past run; if you need to
compare against an earlier config, archive the config itself (not just the
output) somewhere before overwriting it.
