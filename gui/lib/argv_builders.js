// Pure functions building each pipeline script's argv array from GUI state.
// Kept dependency-free and side-effect-free on purpose - directly smoke
// testable with `node -e "import(...).then(m => console.log(m.buildX(...)))"`
// without spinning up the server. Scripts are always invoked with
// cwd: repoRoot (see run_registry.js), so every path here is repo-root-relative,
// matching how these scripts are already run from the CLI today.

export function buildResolveDraftArgs({ draftName, draftFolder, trackIndex }) {
  return [
    "jianying/list_draft_sources.js",
    "--draft-name", draftName,
    ...(draftFolder ? ["--draft-folder", draftFolder] : []),
    ...(trackIndex != null ? ["--track-index", String(trackIndex)] : []),
  ];
}

export function buildSuggestThresholdArgs({ draftName, sourceFiles, targetPercentile }) {
  return [
    "silence_classifier/suggest_threshold.js",
    "--files", sourceFiles.join(","),
    "--draft-name", draftName,
    ...(targetPercentile ? ["--target-percentile", String(targetPercentile)] : []),
  ];
}

export function buildClassifyArgs({ draftName, sourceFiles, thresholds }) {
  return [
    "silence_classifier/classify.js",
    "--config", "config/rough_cut_config.json",
    "--files", sourceFiles.join(","),
    "--thresholds", thresholds.join(","),
    "--out", `projects/${draftName}/keep_segments.json`,
  ];
}

export function buildInsertArgs({ draftName, trackName, force, dryRun }) {
  return [
    "jianying/insert_rough_cut.js",
    "--draft-name", draftName,
    "--keep-segments", `projects/${draftName}/keep_segments.json`,
    "--raw-timeline-map", `projects/${draftName}/sources.json`,
    ...(trackName && trackName !== "Rough Cut" ? ["--track-name", trackName] : []),
    ...(force ? ["--force"] : []),
    ...(dryRun ? ["--dry-run"] : []),
  ];
}
