// Lists projects/<name>/ folders that have a pipeline_progress.json, for the
// GUI's resume picker. projects/ is entirely gitignored/regenerated (see
// CLAUDE.md) - an empty or missing folder is the normal "nothing run yet"
// state, not an error.
import fs from "node:fs";
import path from "node:path";

import { repoRoot } from "./run_registry.js";
import { loadProgress } from "../../lib/pipeline_progress.js";

export function listProjects() {
  const projectsDir = path.join(repoRoot, "projects");
  if (!fs.existsSync(projectsDir)) return [];
  const entries = fs.readdirSync(projectsDir, { withFileTypes: true }).filter((e) => e.isDirectory());
  const projects = [];
  for (const entry of entries) {
    const progressPath = path.join(projectsDir, entry.name, "pipeline_progress.json");
    if (!fs.existsSync(progressPath)) continue;
    try {
      const progress = loadProgress(progressPath);
      const done = progress.stages.filter((s) => s.status === "completed" || s.status === "skipped").length;
      projects.push({
        name: entry.name,
        updatedAt: progress.updatedAt,
        stagesDone: done,
        stagesTotal: progress.stages.length,
      });
    } catch {
      // Corrupt/partial progress file mid-write - skip it rather than 500ing the whole list.
    }
  }
  projects.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return projects;
}
