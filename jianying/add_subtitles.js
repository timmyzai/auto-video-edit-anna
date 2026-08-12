#!/usr/bin/env node
// Imports a Simplified-Chinese SRT (see subtitles/generate_subtitles.js) into an
// *existing* Jianying/CapCut draft as a new text track, via capcut-cli's
// `import-srt` (one text segment per SRT cue). Jianying must be closed first, same
// constraint as build_draft.js's `compile` - it refuses to write a draft that's
// currently open.
//
// Usage:
//   node jianying/add_subtitles.js --draft-name "初剪" --srt output/subtitles.srt
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { detectDraftFolder, capcutBinPath } from "./lib/draft_folder.js";

function parseArgs(argv) {
  const out = { trackName: "字幕 (Simplified Chinese)" };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, "").replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    out[key] = argv[i + 1];
  }
  if (!out.draftName || !out.srt) {
    throw new Error(
      "Usage: add_subtitles.js --draft-name <name> --srt <path> [--draft-folder <dir>] [--track-name <name>] [--font-size <n>] [--color <#RRGGBB>]"
    );
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(args.srt)) throw new Error(`SRT file not found: ${args.srt}`);

  const capcutBin = capcutBinPath();
  const draftFolder = args.draftFolder || detectDraftFolder(capcutBin);
  const draftPath = path.join(draftFolder, args.draftName);
  if (!fs.existsSync(draftPath)) {
    throw new Error(`No draft named "${args.draftName}" found in ${draftFolder}. Check the name (capcut projects "${args.draftName}") or pass --draft-folder.`);
  }

  const q = (s) => `"${s}"`; // shell:true on Windows needs explicit quoting for any path with spaces
  const cliArgs = ["import-srt", q(draftPath), q(path.resolve(args.srt)), "--track-name", q(args.trackName)];
  if (args.fontSize) cliArgs.push("--font-size", args.fontSize);
  if (args.color) cliArgs.push("--color", args.color);

  console.error(`Importing ${args.srt} into "${args.draftName}"...`);
  const result = spawnSync(q(capcutBin), cliArgs, {
    encoding: "utf-8",
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.status !== 0) {
    console.error(result.stdout);
    console.error(result.stderr);
    throw new Error(`capcut import-srt exited with code ${result.status}`);
  }
  console.error(result.stdout);
  console.error(`Subtitles imported into "${args.draftName}". Restart Jianying if it was already open, then review before exporting.`);
}

main();
