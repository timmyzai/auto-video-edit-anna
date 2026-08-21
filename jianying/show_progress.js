#!/usr/bin/env node
// Live viewer for projects/<name>/pipeline_progress.json - the single
// progress file every stage of the rough-cut pipeline (mechanical CLI
// scripts and Claude's own manifest-review passes alike) writes into. See
// lib/pipeline_progress.js for the writing side.
//
// Usage:
//   node jianying/show_progress.js --draft-name "<name>"            # one-shot
//   node jianying/show_progress.js --draft-name "<name>" --watch     # live, refreshes every 3s
//   node jianying/show_progress.js --draft-name "<name>" --watch --interval-s 1
import fs from "node:fs";
import path from "node:path";

import { projectDir } from "./lib/draft_folder.js";
import { loadProgress, renderProgress } from "../lib/pipeline_progress.js";

function parseArgs(argv) {
  const out = { intervalS: 3 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--watch") { out.watch = true; continue; }
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      out[key] = argv[i + 1];
      i++;
    }
  }
  if (!out.draftName) {
    throw new Error('Usage: show_progress.js --draft-name "<name>" [--watch] [--interval-s N]');
  }
  return out;
}

function render(progressPath) {
  if (!fs.existsSync(progressPath)) {
    console.log(`No pipeline_progress.json yet at ${progressPath} - nothing has started.`);
    return;
  }
  console.log(renderProgress(loadProgress(progressPath)));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const progressPath = path.join(projectDir(args.draftName), "pipeline_progress.json");

  if (!args.watch) {
    render(progressPath);
    return;
  }

  const intervalMs = Math.max(1, Number(args.intervalS)) * 1000;
  console.log(`Watching ${progressPath} (Ctrl+C to stop)...\n`);
  const tick = () => {
    console.clear();
    console.log(`Watching ${progressPath} - refreshing every ${intervalMs / 1000}s (Ctrl+C to stop)\n`);
    render(progressPath);
  };
  tick();
  setInterval(tick, intervalMs);
}

main();
