// In-memory registry of spawned pipeline-script child processes, one active
// run per project (draft name) at a time. This is the single source of truth
// for "what's running right now" - the server holds it, not the browser, so
// multiple tabs/refreshes all see the same state instead of racing each other
// into duplicate spawns.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { HttpError } from "./http_error.js";
import { sendEvent } from "./sse.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(__dirname, "..", "..");

export class RunRegistry {
  #runs = new Map(); // draftName -> run

  // scriptPath is repo-root-relative (e.g. "jianying/list_draft_sources.js"),
  // matching argv_builders.js's output - args[0] there IS the script path.
  start(draftName, stageId, argv) {
    const existing = this.#runs.get(draftName);
    if (existing?.status === "running") {
      throw new HttpError(409, `A step is already running for "${draftName}" (${existing.stageId}).`);
    }
    const [scriptPath, ...args] = argv;
    const child = spawn(process.execPath, [path.join(repoRoot, scriptPath), ...args], { cwd: repoRoot });
    const run = {
      draftName,
      stageId,
      argv,
      status: "running",
      exitCode: null,
      startedAt: Date.now(),
      finishedAt: null,
      output: [],
      listeners: new Set(),
    };
    child.stdout.on("data", (buf) => this.#append(run, "stdout", buf));
    child.stderr.on("data", (buf) => this.#append(run, "stderr", buf));
    child.on("error", (err) => {
      this.#append(run, "stderr", Buffer.from(`\n[failed to start: ${err.message}]\n`));
      run.status = "failed";
      run.exitCode = null;
      run.finishedAt = Date.now();
      this.#broadcast(run, "end", { code: null });
    });
    child.on("close", (code) => {
      if (run.status !== "running") return; // already handled by the error listener above
      run.status = code === 0 ? "success" : "failed";
      run.exitCode = code;
      run.finishedAt = Date.now();
      this.#broadcast(run, "end", { code });
    });
    this.#runs.set(draftName, run);
    return run;
  }

  #append(run, stream, buf) {
    const text = buf.toString("utf-8");
    run.output.push({ stream, text, t: Date.now() });
    this.#broadcast(run, "chunk", { stream, text });
  }

  #broadcast(run, event, data) {
    for (const res of run.listeners) sendEvent(res, event, data);
  }

  get(draftName) {
    return this.#runs.get(draftName);
  }

  // Replays buffered output to a newly-(re)connecting SSE client before
  // switching to live events, so a browser refresh mid-run doesn't lose the
  // transcript so far.
  attach(draftName, res) {
    const run = this.#runs.get(draftName);
    if (!run) throw new HttpError(404, "No run for this project yet.");
    for (const { stream, text } of run.output) sendEvent(res, "chunk", { stream, text });
    if (run.status !== "running") sendEvent(res, "end", { code: run.exitCode });
    run.listeners.add(res);
    res.on("close", () => run.listeners.delete(res));
    return run;
  }
}
