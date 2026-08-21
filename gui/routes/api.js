// All /api/* handlers for the rough-cut GUI dashboard. Small manual dispatch
// table instead of a framework - each handler is a plain async function
// (req, res, params) => void, and the one try/catch in dispatch() turns a
// thrown HttpError (or any other error) into a JSON error body, so no
// handler needs its own boilerplate.
import fs from "node:fs";
import path from "node:path";

import { HttpError } from "../lib/http_error.js";
import { writeSseHeaders } from "../lib/sse.js";
import { listProjects } from "../lib/project_scan.js";
import {
  buildResolveDraftArgs,
  buildSuggestThresholdArgs,
  buildClassifyArgs,
  buildInsertArgs,
} from "../lib/argv_builders.js";

import { projectDir, isJianyingRunning } from "../../jianying/lib/draft_folder.js";
import { loadProgress } from "../../lib/pipeline_progress.js";

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new HttpError(400, "Request body must be valid JSON."));
      }
    });
    req.on("error", reject);
  });
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function requireSources(draftName) {
  const sourcesPath = path.join(projectDir(draftName), "sources.json");
  if (!fs.existsSync(sourcesPath)) {
    throw new HttpError(400, `No sources.json yet for "${draftName}" - run "Resolve Draft" first.`);
  }
  return readJsonFile(sourcesPath);
}

function requireKeepSegments(draftName) {
  const keepPath = path.join(projectDir(draftName), "keep_segments.json");
  if (!fs.existsSync(keepPath)) {
    throw new HttpError(400, `No keep_segments.json yet for "${draftName}" - run "Run Classification" first.`);
  }
  return readJsonFile(keepPath);
}

function summarizeKeepSegments(clips) {
  let segmentCount = 0;
  let totalKeptS = 0;
  let totalRawS = 0;
  for (const clip of clips) {
    segmentCount += clip.keep_seconds.length;
    totalRawS += clip.duration_s;
    for (const [s, e] of clip.keep_seconds) totalKeptS += e - s;
  }
  return {
    clipCount: clips.length,
    segmentCount,
    totalKeptS,
    totalRawS,
    avgSegmentS: segmentCount > 0 ? totalKeptS / segmentCount : 0,
  };
}

// Multi-video-track ambiguity is only ever announced on stderr by
// list_draft_sources.js (exact wording confirmed by reading that script) -
// scan the just-finished run's buffered output so the GUI can surface a
// dedicated banner instead of leaving it buried in the log.
function detectTrackAmbiguity(run) {
  const text = run.output.filter((o) => o.stream === "stderr").map((o) => o.text).join("");
  return /video tracks found/i.test(text) || /WARNING:.*track/i.test(text);
}

export function buildRoutes(runRegistry) {
  return [
    { method: "GET", pattern: /^\/api\/projects$/, handler: () => ({ projects: listProjects() }) },

    {
      method: "POST",
      pattern: /^\/api\/projects$/,
      handler: async (req) => {
        const body = await readJsonBody(req);
        const draftName = (body.draftName || "").trim();
        if (!draftName) throw new HttpError(400, "draftName is required.");
        projectDir(draftName); // creates projects/<name>/ if missing
        return { name: draftName };
      },
    },

    {
      method: "GET",
      pattern: /^\/api\/projects\/([^/]+)\/progress$/,
      handler: (req, res, [name]) => {
        const progressPath = path.join(projectDir(name), "pipeline_progress.json");
        if (!fs.existsSync(progressPath)) throw new HttpError(404, "No progress yet - nothing has run for this project.");
        return loadProgress(progressPath);
      },
    },

    {
      method: "GET",
      pattern: /^\/api\/projects\/([^/]+)\/sources$/,
      handler: (req, res, [name]) => {
        const sourcesPath = path.join(projectDir(name), "sources.json");
        if (!fs.existsSync(sourcesPath)) throw new HttpError(404, "sources.json not written yet.");
        return readJsonFile(sourcesPath);
      },
    },

    {
      method: "GET",
      pattern: /^\/api\/projects\/([^/]+)\/keep-segments$/,
      handler: (req, res, [name]) => {
        const keepPath = path.join(projectDir(name), "keep_segments.json");
        if (!fs.existsSync(keepPath)) throw new HttpError(404, "keep_segments.json not written yet.");
        return summarizeKeepSegments(readJsonFile(keepPath));
      },
    },

    {
      method: "GET",
      pattern: /^\/api\/projects\/([^/]+)\/jianying-status$/,
      handler: () => ({ running: isJianyingRunning() }),
    },

    {
      method: "POST",
      pattern: /^\/api\/projects\/([^/]+)\/resolve-draft$/,
      handler: async (req, res, [name]) => {
        const body = await readJsonBody(req);
        const argv = buildResolveDraftArgs({ draftName: name, draftFolder: body.draftFolder, trackIndex: body.trackIndex });
        const run = runRegistry.start(name, "resolve_draft", argv);
        return { stageId: "resolve_draft", started: true, runStartedAt: run.startedAt };
      },
      status: 202,
    },

    {
      method: "POST",
      pattern: /^\/api\/projects\/([^/]+)\/suggest-threshold$/,
      handler: async (req, res, [name]) => {
        const body = await readJsonBody(req);
        const { sourceFiles } = requireSources(name);
        const argv = buildSuggestThresholdArgs({ draftName: name, sourceFiles, targetPercentile: body.targetPercentile });
        const run = runRegistry.start(name, "suggest_threshold", argv);
        return { stageId: "suggest_threshold", started: true, runStartedAt: run.startedAt };
      },
      status: 202,
    },

    {
      method: "POST",
      pattern: /^\/api\/projects\/([^/]+)\/classify$/,
      handler: async (req, res, [name]) => {
        const body = await readJsonBody(req);
        const { sourceFiles } = requireSources(name);
        if (!Array.isArray(body.thresholds) || body.thresholds.length !== sourceFiles.length) {
          throw new HttpError(400, `thresholds must be an array of ${sourceFiles.length} number(s), one per source file.`);
        }
        const argv = buildClassifyArgs({ draftName: name, sourceFiles, thresholds: body.thresholds });
        const run = runRegistry.start(name, "classify_amplitude", argv);
        return { stageId: "classify_amplitude", started: true, runStartedAt: run.startedAt };
      },
      status: 202,
    },

    {
      method: "POST",
      pattern: /^\/api\/projects\/([^/]+)\/insert$/,
      handler: async (req, res, [name]) => {
        const body = await readJsonBody(req);
        requireKeepSegments(name);
        requireSources(name);
        if (isJianyingRunning()) {
          throw new HttpError(409, "Jianying is currently running - close it, then try again.");
        }
        const argv = buildInsertArgs({ draftName: name, trackName: body.trackName, force: body.force, dryRun: body.dryRun });
        const run = runRegistry.start(name, "insert", argv);
        return { stageId: "insert", started: true, runStartedAt: run.startedAt };
      },
      status: 202,
    },

    {
      method: "GET",
      pattern: /^\/api\/projects\/([^/]+)\/warnings$/,
      handler: (req, res, [name]) => {
        const run = runRegistry.get(name);
        return { trackAmbiguity: run ? detectTrackAmbiguity(run) : false };
      },
    },

    {
      method: "GET",
      pattern: /^\/api\/projects\/([^/]+)\/stream$/,
      handler: (req, res, [name]) => {
        // Check the run exists BEFORE writing SSE headers - attach() throwing
        // after headers are already sent would crash trying to writeHead again
        // in dispatch()'s catch block.
        if (!runRegistry.get(name)) throw new HttpError(404, "No run for this project yet.");
        writeSseHeaders(res);
        runRegistry.attach(name, res);
        return undefined; // response is handled directly, dispatcher must not also write JSON
      },
      streaming: true,
    },
  ];
}

export async function dispatch(routes, req, res) {
  const url = req.url.split("?")[0];
  const route = routes.find((r) => r.method === req.method && r.pattern.test(url));
  if (!route) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `No API route for ${req.method} ${url}` }));
    return;
  }
  const match = route.pattern.exec(url);
  const params = match.slice(1).map((p) => decodeURIComponent(p));
  try {
    const result = await route.handler(req, res, params);
    if (route.streaming) return; // handler already wrote directly to res (SSE)
    res.writeHead(route.status || 200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result ?? {}));
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message || String(err) }));
  }
}
