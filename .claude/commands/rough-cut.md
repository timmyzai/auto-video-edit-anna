---
description: Run the full autonomous rough-cut pipeline against an existing Jianying project
---

The user wants a rough cut assembled inside a Jianying Pro project they've
already created: raw footage imported via Jianying's own GUI (so it auto-
configured canvas/fps for that footage — including the HDR conversion tool
toggle, HDR 转换工具, which should be on), placed on a track. Given below:
$ARGUMENTS

That should contain the Jianying project name — the only required input. If
missing, ask for it before doing anything else — don't guess. This workflow
always targets an **existing** draft found by that name — never create a new
one, and never fall back to a `raw/` folder or `jianying/build_draft.js` even
if asked to move fast; if the name doesn't resolve to a real draft, stop and
say so rather than guessing.

**Default to the fast, caption-free path.** Don't ask for or wait on an
auto-caption SRT — that's an optional add-on, not a prerequisite. Follow the
"Autonomous rough-cut workflow" section of CLAUDE.md exactly, step by step,
running every command yourself via Bash/PowerShell — the user should not need
to type or paste any commands. That section covers: resolving the draft and
reading its already-imported source files, getting a per-file silence/voice
threshold for each source, classifying with amplitude/VAD only, sanity-
checking the result, and inserting the kept segments into the existing draft
— never a new draft. `insert_rough_cut.js` clones each kept span from the
*original* segment it came from (preserving GUI-applied color grading/
effects) onto one consolidated video track, then removes the now-fully-
cloned-out originals — it does touch the existing video track by design (that
consumption is what makes grading survive), it just never touches
canvas/fps, and never creates a second draft.

Only use the "Optional add-on: content-aware dialogue safety net" part of
that section if the user explicitly asks for it (e.g. they're seeing short
meaningful words or acronyms get cut and want better recall) — it requires
them to have already run Jianying's auto-caption and exported the SRT, which
is real manual work, so don't push it unprompted. **When it is used, treat
`silence_classifier/qa_transcript_report.js` as a required part of that same
path, not a further optional step** — run it before `insert_rough_cut.js`,
against `keep_segments.json`, and actually look at what it flags (especially
the "meaningful content in a cut span" section — that should always be empty;
investigate before proceeding if it isn't) before inserting into the draft.

When reporting results, mention briefly that this content-aware safety net
and the separate, optional `action-summary` command both exist if the user
ever wants them — but keep it brief, don't dwell on it, and don't imply
either is expected as a next step.

If any step's output looks wrong, stop and flag it rather than continuing with
bad data.
