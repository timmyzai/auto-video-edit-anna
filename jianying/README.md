# CapCut / Jianying Pro pipeline

Alternative to the Premiere path (`premiere/build_rough_cut.md`) for turning a
`keep_segments.json` into an actual cut video, using Jianying Pro (剪映专业版,
CapCut's mainland-China counterpart) instead of Premiere.

## Why this exists

Jianying has no official API, and no file-based shortcut exists for triggering a
render/export. So the pipeline splits in two:

1. **Draft creation** (fully automated) — [`capcut-cli`](https://github.com/renezander030/capcut-cli)'s
   `compile` command writes the exact `draft_content.json`/`draft_info.json` files
   Jianying itself writes when you build a project through its GUI, directly into its
   drafts folder. Jianying can't tell the difference — it just sees a project that
   "already exists." Pure file generation, nothing runs or gets clicked. Verified
   byte-identical output (same duration, frame-matching content) against the earlier
   Python/`pyJianYingDraft` version before switching to this.
2. **Export** (manual) — open the draft in Jianying and click Export yourself. An
   automated version was attempted (Windows UI Automation) and abandoned: Jianying's
   UI is QML-based and puts nearly all its button/label text in one specific
   accessibility property (`FullDescription`, UIA property #30159) that Python's
   `uiautomation` package reads via raw COM, but that .NET's built-in automation
   library (and PowerShell, which wraps it) doesn't expose - `LookupById` returns
   null and every read fails silently. Fixing that needs hand-written COM interop
   matching `IUIAutomation6`'s exact interface layout - real effort, not attempted
   here. Manual export was the chosen tradeoff over taking on that risk or keeping a
   Python dependency around for just this one step.

## Setup

```bash
npm install   # capcut-cli is a regular dependency, already in package.json
```

Jianying Pro must be installed and opened at least once (so it has a real drafts
folder for `capcut doctor` to detect - see below).

## Usage

**Always: insert into a project you already have.** This is the only mode the
rough-cut skill uses — there is no raw-footage/no-existing-project mode in
that workflow anymore. The user imports raw footage into a Jianying project
themselves first (via Jianying's own GUI, so it auto-configures canvas/fps
correctly — confirm the HDR conversion tool, HDR 转换工具, is on during that
import) and places it on a track - see the root `CLAUDE.md`'s "Autonomous
rough-cut workflow" for the full sequence. Our tooling then inserts the rough
cut *into that existing draft*, rather than creating a competing new one, and
always resolves the draft by the project **name** given to it - it never
guesses one or falls back to creating a new project. **Default is caption-free
and fast** - no auto-caption/export step required for a normal rough cut:

Every generated file for a project lands in `projects/<draft-name>/` -
`list_draft_sources.js` creates that folder (it's always the first script to
run) and everything after it writes into the same place. Entirely gitignored.

```bash
# 1. Discover the project's already-imported source files - creates
#    projects/My Project/ and writes sources.json into it (each rawTimeline
#    entry carries the original segment's segmentId - required by step 3)
node jianying/list_draft_sources.js --draft-name "My Project"

# 2. Classify (see silence_classifier/ docs) - amplitude/VAD only by default
node silence_classifier/classify.js --config config/rough_cut_config.json \
  --files <sourceFiles from projects/My Project/sources.json> --thresholds <per-file values> \
  --out "projects/My Project/keep_segments.json"

# 3. Insert into the existing draft - progress: projects/My Project/rough_cut_progress.json
node jianying/insert_rough_cut.js --draft-name "My Project" \
  --keep-segments "projects/My Project/keep_segments.json" \
  --raw-timeline-map "projects/My Project/sources.json"
```

**Optional add-on, only if asked for:** if short meaningful words or
acronyms are getting cut and the user wants better recall, they can run
Jianying's built-in auto-caption on the raw assembly, export the SRT (no
ChatGPT cleanup needed yet), and add `--dialogue-srt <auto-caption.srt>
--raw-timeline-map "projects/My Project/sources.json"` to the `classify.js`
call above - see root `CLAUDE.md`'s "Optional add-on: content-aware dialogue
safety net". **When using it, run `silence_classifier/qa_transcript_report.js`
against `keep_segments.json` before step 3**, not after - review/fix is a
cheap JSON edit before insert, a full redo against the draft after.

`insert_rough_cut.js` clones each kept span from the *original* video-track
segment it came from (material + every `extra_material_refs` entry - canvas/
adjustment/filter/etc., i.e. whatever color grading was applied in Jianying's
GUI - with fresh ids), retimes the clone, and consolidates every clone onto
one new video track before removing the now-fully-cloned-out originals. This
is why it needs `--raw-timeline-map`: each kept piece has to trace back to
the exact original segment (and hence its material) it was cut from, not
just its source file. An earlier version re-imported straight from the raw
file (`add-video`+`trim` per segment) instead - simpler, but could never
carry over GUI-applied grading, and left any pre-existing caption track
un-remapped against the new, shorter timeline. If the draft already has a
caption/text track, its cues are remapped onto the same compacted timeline in
the same pass - no separate re-caption step needed just to fix positions.

Runs as one in-process pass (loads the draft once, builds every clone in
memory, one save at the end) rather than a subprocess per segment, so it's
fast - seconds to tens of seconds on real footage, not the minutes a
per-segment design would take. **It's one-shot per raw import, though**: once
the originals are consumed and removed, a second run has nothing left to
clone from and fails loudly rather than guessing. To re-run against updated
`keep_segments.json` (a re-tuned threshold, a classify.js fix, etc.), restore
the draft first to a snapshot from before the previous real run
(`capcut restore "<draft>" --step N` - find N by checking
`.capcut-cli-history/draft_content.json.*.snap` for one where the original
video track still has its full segment count) and re-run from there. Writes
`projects/<draft-name>/rough_cut_progress.json` (`segmentsDone`/
`segmentsTotal`, `percent`, `status`) so progress is a file read away instead
of a guess. `--force` replaces an existing same-named track from a prior run;
`--dry-run` previews without writing.

**Standalone tool, not used by the rough-cut skill: no existing project.**
`build_draft.js` creates a brand-new draft in one call from raw files with no
Jianying project yet - faster, but this is exactly why the rough-cut skill
never calls it: `compile` always sets canvas/fps from its own spec
(1920×1080@30fps unless overridden), which would silently discard a GUI
import's own settings if one existed. Kept in the repo for manual use only;
the autonomous workflow always requires an existing draft.

```bash
node jianying/build_draft.js --keep-segments keep_segments.json --draft-name "My Rough Cut"
```

Either way, then in Jianying:
1. If Jianying was already running when you built/modified the draft,
   **restart it** - it only scans its drafts folder on startup, not live.
2. Open the draft.
3. Click **导出** (Export) top-right, set resolution/framerate, confirm.

### Subtitles: two independent tracks

Dialogue and action-summary captions are separate text tracks now, matching
how the `after.mp4` reference footage this pipeline was studied against
actually renders. Neither is local transcription:

```bash
# Dialogue: entirely manual now. Export from Jianying, re-run its auto-caption
# on the new cut sequence, export that SRT, translate via ChatGPT copy-paste,
# import back into Jianying yourself - no script call for this anymore.

# Action-summary captions: separate, optional command (see .claude/commands/action-summary.md) -
# point subtitles/build_action_manifest.js at whatever cut-timeline SRT you
# exported above; it extracts a frame + dialogue context per kept span, a
# Claude Code session fills in the caption directly, subtitles/manifest_to_srt.js
# turns that into an SRT, imported via jianying/add_subtitles.js under a distinct track name.
```

See the "Subtitles" section in the root `CLAUDE.md` for the full design
(content-aware cutting via the dialogue transcript, why action captions need
to be dialogue-driven not just visual, `subtitles/PIPELINE_PLAN.md`'s
`after.mp4` few-shot examples) and its known accuracy caveats.
`subtitles/generate_subtitles.js`/`diarize.js`/`merge_captions.js` (local
Whisper transcription, pitch-clustering speaker tags, two-line merge) have
been deleted - fully superseded by the split-track design. `subtitles/
remap_dialogue.js` is no longer called by the rough-cut skill (dialogue
reimport is manual now), but still works if you want to script the dialogue
round-trip yourself instead of doing it by hand in Jianying's UI.

### Where the draft actually gets written

`build_draft.js` does **not** hardcode a drafts-folder path. It shells out to
`capcut doctor` and uses whichever install (CapCut or JianYing, Windows or Mac) that
command reports as actually present, and fails loudly with a clear message if neither
is found rather than silently guessing. This was a deliberate fix, not the original
design: an earlier version hardcoded
`~/AppData/Local/JianyingPro/User Data/Projects/com.lveditor.draft`, and that
assumption broke silently the moment the installed Jianying version migrated its real
storage location on first launch - the script kept "succeeding" while writing drafts
into a folder Jianying's UI never actually reads, with no error to signal it. Pass
`--draft-folder <path>` to override the detected location if you ever need to.

## When to use this vs. Premiere

The Premiere path (`premiere/build_rough_cut.md`) verifies every single insert
against Premiere's live timeline state before moving to the next one — it's slow by
design, but that carefulness is what makes it trustworthy for high-accuracy work.
That doesn't scale past roughly 50 segments (each one costs several tool round trips).

This path builds the whole draft in one script call regardless of segment count —
tested working at 200+ segments — but has no equivalent live verification step; you're
trusting `capcut-cli`'s correctness plus a final duration check on the exported file,
not a segment-by-segment audit.

## Known gotchas

- **HDR conversion tool (HDR 转换工具) previously couldn't be turned on for
  clips on the rough-cut track — likely fixed now, not independently
  re-verified.** Root cause when this was first found, confirmed by reading
  `capcut-cli` itself: `add-video`'s `videoMaterial` object
  (`node_modules/capcut-cli/dist/factory.js:1028-1079`) has a fixed, minimal
  field set - path, dimensions, duration, crop, `has_audio`, a zeroed
  `video_algorithm` block - with no HDR/color-space/dynamic-range field of any
  kind, while Jianying's own GUI import actually probes the source file and
  (for real HDR-encoded footage) writes whatever field makes the toggle
  available. That was specific to the old mechanism, where every rough-cut
  segment was built via a fresh `add-video` call. `insert_rough_cut.js` no
  longer does that - it clones the *entire* original, GUI-imported material
  object verbatim (fresh id, same fields) rather than constructing a new one,
  so whatever field the GUI import wrote (HDR-related or not) survives onto
  the clone structurally, by construction, not because this was specifically
  patched. Not re-verified against real HDR-encoded footage end-to-end (this
  project's clips didn't need the toggle) - if it turns out to still be
  broken, that would mean a genuinely new root cause, not the one above.
- **Draft not found when you open Jianying**: it caches its draft list in memory;
  restart it after creating a new draft while it was already running.
- **`capcut-cli compile` refuses while Jianying is running** ("close the editor
  before writing this managed draft") - close the app before running
  `build_draft.js`, not after.
- Draft creation writes into Jianying's real user data folder alongside your own
  projects — always give `--draft-name` something clearly distinguishable from your
  actual work. `build_draft.js` deletes and replaces any existing draft with the
  same name without asking, so don't reuse a name you care about. `insert_rough_cut.js`
  is the opposite by design - it only ever targets an *existing* draft and refuses
  to touch a track name that already has segments on it unless you pass `--force`.
- **First launch of a newer Jianying build can migrate your existing drafts into its
  own recycle bin.** Observed firsthand: opening Jianying Pro 8.9.0 for the first time
  on a machine that had older drafts moved them into
  `<drafts folder>/.recycle_bin/`, indexed there with a `tm_draft_removed` timestamp -
  intact, not corrupted, but no longer showing on the home screen. This is Jianying's
  own migration behavior, unrelated to this pipeline, and predates any project this
  pipeline creates. If your own prior projects disappear after opening Jianying,
  check its own trash/recycle-bin UI inside the app to restore them - don't hand-edit
  `root_meta_info.json` to "fix" this; the app's own restore path is much safer than
  manual JSON surgery on your real project data.
- `capcut-cli`'s version-support matrix
  (`node_modules/capcut-cli/docs/version-support.md`) is the authoritative source if
  Jianying itself rejects a generated draft as corrupted - treat any summary of it
  written here (including in past versions of this file) as a snapshot that can go
  stale, not a substitute for checking the live doc. Confirmed firsthand: JianYing
  8.9.0 (well past the "6.0+ encrypted-draft era" the matrix warns about) compiles
  and registers a fresh draft without issue, because creating a brand-new draft never
  stamps version markers in the first place - the write-time version guard the matrix
  describes only applies to *mutating an existing* draft that already carries
  markers from a newer app build, which is a different operation than what
  `build_draft.js` does.
