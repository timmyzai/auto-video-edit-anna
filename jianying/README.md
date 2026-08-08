# CapCut / Jianying Pro pipeline

Alternative to the Premiere path (`orchestrate/build_rough_cut.md`) for turning a
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

```bash
# Build the draft (any segment count - no per-segment round trips needed)
node jianying/build_draft.js --keep-segments keep_segments.json --draft-name "My Rough Cut"
```

Then in Jianying:
1. If Jianying was already running when you built the draft, **restart it** - it
   only scans its drafts folder on startup, not live.
2. Open the draft named `"My Rough Cut"` (or whatever `--draft-name` you gave).
3. Click **导出** (Export) top-right, set resolution/framerate, confirm.

### Optional: subtitles

```bash
# Generate a two-line Simplified-Chinese SRT (speaker-tagged transcript + an
# auto-generated action caption per shot), then import it into an existing draft:
node subtitles/generate_subtitles.js --keep-segments keep_segments.json --out output/subtitles.srt
node jianying/add_subtitles.js --draft-name "My Rough Cut" --srt output/subtitles.srt
```

See the "Subtitles" section in the root `CLAUDE.md` for how this works (local
Whisper transcription, pitch-clustering speaker tags, local image-caption-model
action lines) and its known accuracy caveats. It's slow at real segment counts
(one frame-extract + two model calls per kept span) - run it in the background.

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

The Premiere path (`orchestrate/build_rough_cut.md`) verifies every single insert
against Premiere's live timeline state before moving to the next one — it's slow by
design, but that carefulness is what makes it trustworthy for high-accuracy work.
That doesn't scale past roughly 50 segments (each one costs several tool round trips).

This path builds the whole draft in one script call regardless of segment count —
tested working at 200+ segments — but has no equivalent live verification step; you're
trusting `capcut-cli`'s correctness plus a final duration check on the exported file,
not a segment-by-segment audit.

## Known gotchas

- **Draft not found when you open Jianying**: it caches its draft list in memory;
  restart it after creating a new draft while it was already running.
- **`capcut-cli compile` refuses while Jianying is running** ("close the editor
  before writing this managed draft") - close the app before running
  `build_draft.js`, not after.
- Draft creation writes into Jianying's real user data folder alongside your own
  projects — always give `--draft-name` something clearly distinguishable from your
  actual work. `build_draft.js` deletes and replaces any existing draft with the
  same name without asking, so don't reuse a name you care about.
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
