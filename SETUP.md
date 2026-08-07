# New-laptop setup (Jianying / CapCut path only)

For setting this project up on a second Windows machine, Jianying-only — no Adobe
Premiere Pro, no `premiere-pro-mcp`. Written as a checklist so Claude Code can drive
it directly: open this project in VS Code, start Claude Code, and say "follow
SETUP.md and verify each step." Skip anything in `CLAUDE.md` / `README.md` about
Premiere or the MCP bridge; it doesn't apply to this path.

Each step below has a **Verify** line — don't check a step off without running it and
seeing the expected result.

## Phase 0 — Prerequisites (human installs, GUI steps Claude Code can't do)

- [ ] **Git** — [git-scm.com](https://git-scm.com/download/win)
- [ ] **Node.js LTS** (v20+; this repo was built/tested on v22) —
      [nodejs.org](https://nodejs.org/)
- [ ] **ffmpeg** with `ffmpeg`/`ffprobe` on `PATH`. Easiest on Windows:
      `winget install ffmpeg` (or Chocolatey: `choco install ffmpeg`), then open a
      **new** terminal so the updated `PATH` takes effect.
- [ ] **Jianying Pro (剪映专业版)** installed, and **opened at least once** (so it has
      created its real drafts folder — `build_draft.js` detects this automatically at
      runtime and fails with a clear message if it can't find one; see Phase 3).
      Any current version works for this pipeline: `build_draft.js` only ever
      *creates a brand-new draft*, which never carries the newer-app version markers
      that make some other versions refuse *existing* tool-written drafts as
      corrupted — confirmed firsthand on Jianying Pro 8.9.0. If you ever see Jianying
      report a draft as corrupted, check `node_modules/capcut-cli/docs/version-support.md`
      (after Phase 2) for the live, current compatibility matrix — don't trust a
      version claim written here or anywhere else as a substitute for that file, it
      goes stale as both Jianying and `capcut-cli` update.
- [ ] **VS Code** with the Claude Code extension, or the Claude Code CLI — logged
      into the account this project should use.
- [ ] Push access / clone access to this repo's GitHub remote.

## Phase 1 — Get the code

- [ ] Clone the repo (replace the URL with the actual one):
      ```powershell
      git clone <repo-url> auto-video-edit-anna
      cd auto-video-edit-anna
      ```
- [ ] **Verify**: `CLAUDE.md`, `README.md`, `jianying/`, `silence_classifier/`,
      `config/`, `models/silero_vad.onnx` are all present —
      `Get-ChildItem` should show all of these. `models/silero_vad.onnx` in
      particular is a ~2.3MB binary checked directly into git (not downloaded
      separately) — if it's missing or 0 bytes, the clone didn't pull LFS/binary
      content correctly.

## Phase 2 — Node environment

- [ ] ```powershell
      node --version   # expect v20+
      npm --version
      ffmpeg -version
      ffprobe -version
      ```
      **Verify**: all four print a version with no "not recognized" error. If
      `ffmpeg`/`ffprobe` fail here, fix `PATH` before continuing — everything
      downstream depends on them.
- [ ] ```powershell
      npm install
      ```
      **Verify**: completes without fatal errors. `npm audit` will report 4
      advisories (2 high against `adm-zip`, a transitive dep `onnxruntime-node`
      uses only to unzip its own bundled native binary at install time; 2 moderate
      against `uuid`, pulled in by `node-notifier` for internal notification IDs,
      never fed untrusted input) — known, already-triaged non-issues, not a setup
      failure. Confirm `node_modules/` now contains `onnxruntime-node`,
      `capcut-cli`, `cli-progress`, `ora`, and `node-notifier`.

## Phase 3 — Jianying-specific check

- [ ] Confirm Jianying is closed (`capcut-cli compile` refuses to run otherwise).
- [ ] Confirm `build_draft.js` can actually find your drafts folder — it doesn't use
      a hardcoded path (an earlier version did, and that broke silently the moment
      Jianying changed its storage layout on this machine); instead it asks
      `capcut doctor` at runtime, which checks known CapCut/JianYing install
      locations for a real, live drafts folder:
      ```powershell
      node_modules\.bin\capcut.cmd doctor
      ```
      **Verify**: the JSON output's `checks` array contains an entry with
      `"name":"draft-dir","status":"ok"` and a `detail` naming a real path (either
      the CapCut or JianYing line — whichever app you have). If both `draft-dir`
      entries say `"status":"warn"`/`"not found"`, open Jianying/CapCut once first
      so it creates its drafts folder, then re-run this check.

## Phase 4 — Config sanity check

- [ ] Open `config/rough_cut_config.json` — it should already contain tuned
      defaults (adaptive threshold on, etc.) checked into the repo. No changes
      needed to just verify the pipeline runs; per-clip threshold tuning (Phase 5,
      step 2) happens per real footage later, not here.
- [ ] **Verify**: `node -e "console.log(require('./config/rough_cut_config.json'))"`
      prints valid JSON with `adaptive_threshold: true`.

## Phase 5 — End-to-end smoke test

Use any short (10-30s), disposable test clip with audible speech — doesn't need to
be real project footage, just something to prove the pipeline runs.

- [ ] Drop it in `raw/` (this folder is gitignored except for `.gitkeep`, so it
      won't already have footage after a fresh clone).
- [ ] ```powershell
      node silence_classifier/suggest_threshold.js --file raw/<your_test_clip>
      ```
      **Verify**: prints an RMS percentile table and a suggested threshold — no
      crash. (Don't worry about picking the "right" number for a throwaway test
      clip.)
- [ ] ```powershell
      node silence_classifier/classify.js --config config/rough_cut_config.json --raw-dir raw --out keep_segments.json
      ```
      **Verify**: `keep_segments.json` is created and non-empty (`Get-Content
      keep_segments.json | Measure-Object -Line` or just open it — should list at
      least one segment with `start`/`end` times).
- [ ] ```powershell
      node silence_classifier/qa_check.js --keep-segments keep_segments.json --config config/rough_cut_config.json
      ```
      **Verify**: produces `keep_segments.qa-passed.json` and
      `keep_segments.qa-review.json` without errors.
- [ ] Confirm Jianying Pro is **closed**, then:
      ```powershell
      node jianying/build_draft.js --keep-segments keep_segments.qa-passed.json --draft-name "SETUP TEST - delete me"
      ```
      **Verify**: script exits 0 with no error, and the "Saved draft ... in ..."
      line it prints names the same folder `capcut doctor` reported in Phase 3 —
      if those two ever disagree, something is wrong with detection, not just this
      one run. Use a draft name that's obviously disposable — `build_draft.js`
      silently overwrites any existing draft with the same name.
- [ ] Open (or restart, if it was running before this step — it only scans its
      drafts folder on startup) Jianying Pro and confirm a draft named
      **"SETUP TEST - delete me"** appears in the project list and opens without
      a corruption error.
- [ ] Delete that test draft from Jianying once confirmed, and delete the test
      clip from `raw/` and the generated `keep_segments*.json` files (gitignored,
      but no reason to leave clutter).

## Done

If every box above is checked and the test draft opened cleanly in Jianying, the
laptop is ready. Real usage from here on: drop real footage in `raw/`, follow the
"Running it" section in `README.md` starting from step 2 (per-clip threshold
tuning) — step 1 (drop footage in `raw/`) is already covered by this checklist.
