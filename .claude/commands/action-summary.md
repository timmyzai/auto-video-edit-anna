---
description: Add auto-generated action-summary captions to an existing rough-cut draft
---

The user wants short editorial action-summary captions added to a Jianying
project that already has a rough cut assembled (via the `rough-cut` command).
Given below: $ARGUMENTS

That should contain the Jianying project name. If missing, ask for it. This
command is separate and optional — never run it automatically as part of
`rough-cut`, only when the user explicitly asks for it here. The user has
said they consider a fully manual captioning pass "very accurate" and may
prefer to skip this entirely, so don't assume it's wanted.

Follow the "Autonomous action-summary workflow" section of CLAUDE.md exactly,
step by step, running every command yourself via Bash/PowerShell. That
section covers: resolving the draft, locating `keep_segments.json` the
rough-cut command produced for it (if missing, tell the user to run
rough-cut first rather than guessing), asking the user for the path to the
cut-timeline-aligned dialogue SRT they exported from Jianying after the cut
(dialogue export/translate/reimport is manual now, so there's no fixed file
to assume), building the caption manifest (frame + dialogue-context
extraction per kept span), filling in captions yourself by reading each
span's frame and
transcript excerpt directly — few-shot primed on the real `after.mp4`
examples in `jianying/subtitles/PIPELINE_PLAN.md` (short, present-tense, narrative,
dialogue-driven when relevant — not a generic visual description) — and, past
a few hundred spans, delegating to a handful of background Agents rather than
doing all of them inline, then importing the result as its own separate text
track.

When reporting results, state plainly: this is an auto-generated pass, not
human-reviewed, and restate that explicitly rather than letting it go unsaid.

If any step's output looks wrong, stop and flag it rather than continuing with
bad data.
