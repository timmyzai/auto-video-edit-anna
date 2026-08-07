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

Jianying Pro must be installed.

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
- `capcut-cli`'s version-support matrix (`node_modules/capcut-cli/docs/version-support.md`)
  is worth checking if Jianying itself rejects a generated draft as corrupted -
  JianYing 6.0+ encrypts its draft format and isn't writable by this tool at all;
  only the pre-6.0 plaintext era (confirmed working: 5.9.0) is supported.
