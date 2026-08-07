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
