#!/usr/bin/env node
// Entry point for the local rough-cut GUI dashboard: `npm run gui`.
// Plain node:http - no framework, no build step. Serves gui/public/ as
// static files and dispatches /api/* to gui/routes/api.js. Spawns the same
// CLI scripts a human/Claude would type from the repo root; never mutates
// pipeline scripts' own behavior.
import http from "node:http";
import { spawn } from "node:child_process";

import { serveStatic } from "./routes/static.js";
import { buildRoutes, dispatch } from "./routes/api.js";
import { RunRegistry } from "./lib/run_registry.js";

const DEFAULT_PORT = 4173;

const runRegistry = new RunRegistry();
const routes = buildRoutes(runRegistry);

const server = http.createServer((req, res) => {
  if (req.method === "GET" && !req.url.startsWith("/api/")) {
    if (serveStatic(req, res)) return;
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
    return;
  }
  dispatch(routes, req, res);
});

function openBrowser(url) {
  if (process.platform !== "win32") {
    console.log(`Open ${url} in your browser.`);
    return;
  }
  try {
    spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true }).unref();
  } catch {
    console.log(`Open ${url} in your browser.`);
  }
}

function listen(port, attemptsLeft = 10) {
  server.listen(port, "127.0.0.1", () => {
    const url = `http://127.0.0.1:${port}`;
    console.log(`Rough-cut dashboard running at ${url}`);
    openBrowser(url);
  });
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE" && attemptsLeft > 0) {
      server.removeAllListeners("error");
      listen(port + 1, attemptsLeft - 1);
      return;
    }
    console.error(`Failed to start dashboard server: ${err.message}`);
    process.exit(1);
  });
}

listen(DEFAULT_PORT);
