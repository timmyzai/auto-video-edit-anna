// Minimal SRT parse/render, shared across the pipeline (classify.js's
// --dialogue-srt, subtitles/remap_dialogue.js, subtitles/build_action_manifest.js,
// subtitles/manifest_to_srt.js). Previously duplicated near-identically in
// subtitles/generate_subtitles.js and subtitles/merge_captions.js - factored out
// once a third consumer needed the same parsing, rather than copy-pasting again.
// Deliberately not reusing capcut-cli's internal srt.js: it's not exported from
// the package's public `exports` map (only `.` -> dist/lib.js is), so importing
// its dist path directly would break under Node's package-exports enforcement.
import fs from "node:fs";
import path from "node:path";

const TS = /^(\d{1,2}):(\d{2}):(\d{2})[.,](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[.,](\d{1,3})/;

function tsToSeconds(h, m, s, ms) {
  const msPadded = `${ms}000`.slice(0, 3);
  return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(msPadded) / 1000;
}

/** Parses SRT text into [{start, end, text}] in seconds. Multi-line cue text is
 * joined with a single space - callers that need line structure preserved
 * (none currently do) should not use this. */
export function parseSrt(content) {
  const cues = [];
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length) {
    while (i < lines.length && lines[i].trim() === "") i++;
    if (i >= lines.length) break;
    if (/^\d+$/.test(lines[i].trim())) i++; // optional index line
    if (i >= lines.length) break;
    const m = TS.exec(lines[i]);
    if (!m) throw new Error(`Invalid SRT timestamp near line ${i + 1}: ${lines[i]}`);
    const start = tsToSeconds(m[1], m[2], m[3], m[4]);
    const end = tsToSeconds(m[5], m[6], m[7], m[8]);
    i++;
    const textLines = [];
    while (i < lines.length && lines[i].trim() !== "") {
      textLines.push(lines[i]);
      i++;
    }
    const text = textLines.join(" ").trim();
    if (text && end > start) cues.push({ start, end, text });
  }
  return cues;
}

export function parseSrtFile(filePath) {
  return parseSrt(fs.readFileSync(filePath, "utf-8"));
}

function pad(n, len = 2) {
  return String(n).padStart(len, "0");
}

export function toSrtTime(seconds) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const hh = Math.floor(ms / 3_600_000);
  const mm = Math.floor((ms % 3_600_000) / 60_000);
  const ss = Math.floor((ms % 60_000) / 1000);
  const mmm = ms % 1000;
  return `${pad(hh)}:${pad(mm)}:${pad(ss)},${pad(mmm, 3)}`;
}

/** cues: [{start, end, ...}]. textFn maps a cue to its rendered text (one or
 * more lines, joined with \n for a multi-line cue). */
export function renderSrt(cues, textFn = (c) => c.text) {
  return cues
    .map((c, i) => `${i + 1}\n${toSrtTime(c.start)} --> ${toSrtTime(c.end)}\n${textFn(c)}\n`)
    .join("\n");
}

export function writeSrtFile(cues, outPath, textFn = (c) => c.text) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, renderSrt(cues, textFn), "utf-8");
}
