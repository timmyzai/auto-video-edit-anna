---
description: Run the full autonomous rough-cut pipeline on a raw footage file
---

The user wants a rough cut produced from a raw footage file. The file (path, or
description of where it lives) is: $ARGUMENTS

If no file/path was given above, ask the user for it before doing anything else.

Follow the "Autonomous rough-cut workflow" section of CLAUDE.md exactly, step by
step, running every command yourself via Bash/PowerShell — the user should not
need to type or paste any commands. That section covers: moving the file into
`raw/` (and checking for a stray human-edited reference clip to move out first),
running `suggest_threshold.js`, writing the threshold into
`config/rough_cut_config.json`, running `classify.js`, sanity-checking the
output, building the Jianying/CapCut draft, generating and importing
speaker-tagged subtitles + action captions (default, not opt-in — only skip if
the user explicitly says no subtitles this run), and reporting results back with
a reminder that Export is a manual step plus the two subtitle-quality caveats
(speaker tags are a pitch/energy heuristic, not real diarization; action
captions are auto-generated, not human-reviewed).

If any step's output looks wrong, stop and flag it rather than continuing with
bad data.
