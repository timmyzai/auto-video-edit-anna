# Playbook: assemble a Premiere rough cut from `keep_segments.json`

This is written for Claude to follow, using the `premiere-pro-mcp` tools, once
`keep_segments.json` has been produced by `silence_classifier/classify.js`.

`keep_segments.json` looks like:

```json
[
  {
    "clip": "raw/A001_C002.mp4",
    "fps": 25.0,
    "duration_s": 612.4,
    "keep_seconds": [[0.0, 4.8], [13.6, 36.0], ...],
    "keep": [[0, 120], [340, 900], ...]
  },
  ...
]
```

`keep` is frame numbers at the clip's own fps — use these for in/out points so
cuts are frame-accurate. `keep_seconds` is for human-readable review/logging only.

## Steps

1. **Read `keep_segments.json`.** One entry per raw clip, clips are already in
   the order they should appear in the rough cut (`classify.js` sorts by filename
   — if the user wants a different order, re-sort this list before proceeding).

2. **Import each raw clip** into the current Premiere project with `import_media`,
   one call per `clip` path. Skip any clip already present in the project (check
   the project panel / existing project items first — don't double-import).

3. **Create a new sequence** with `create_sequence` (or `create_sequence_from_preset`)
   matching the first clip's frame rate/resolution. Name it `Rough Cut - <today's date>`
   so re-runs don't collide with a previous attempt. Do not touch any existing sequence.

4. **For each clip, for each `[in_frame, out_frame]` pair in `keep`, in order:**
   - Set the source clip's in/out points to that frame range.
   - Use `insert_from_source` (3-point edit) to append it onto the new sequence,
     immediately after whatever was inserted previously (end of the last inserted
     clip becomes the insert point for the next one — do not overwrite, do not
     leave gaps).
   - Confirm the tool call's return value reports success before moving to the
     next range; if a call fails, stop and surface the error rather than skipping
     ahead silently.

5. **After all clips are inserted, report a summary** to the user:
   - number of source clips processed
   - total raw duration vs. total rough-cut duration (and the percentage cut)
   - number of individual cuts made
   - reminder that this is a first pass — review the sequence in Premiere before
     any further editing, and re-run the classifier with adjusted
     `config/rough_cut_config.json` thresholds if too much/little got cut.

## Non-destructive by design

Nothing here deletes or modifies existing footage, bins, or sequences — it only
imports (idempotently) and creates one new sequence. Re-running after a config
change is always safe: it just produces another new sequence to compare against.
