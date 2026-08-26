// IntelliStory (SmartSnap) support for React Styleguidist.
//
// Mirrors the @percy/storybook integration: all of the intelligence lives in
// `applyIntelliStory` (@percy/cli-command), which collects the git diff and the
// bundler's dependency graph, enqueues a graph job against the Percy build, and
// tags each snapshot so the API can decide server-side which ones can be
// skipped. This module only translates Styleguidist's world into the shape that
// function expects — the three things Storybook gets for free:
//
//   * `importPath` — Storybook reads it off the story index; here it is derived
//     from the component's examples markdown (see `componentImportPath`),
//   * the stats directory — Styleguidist points webpack one level below the
//     directory passed to `percy styleguidist`,
//   * `configDir` — Storybook's global config is one directory; Styleguidist's
//     is a config file plus whatever it pulls in globally.
import fs from 'fs';
import path from 'path';
import { applyIntelliStory, writeIntelliStoryTrace, IntelliStoryBailError } from '@percy/cli-command';

export const DEFAULT_STATS_FILE = 'enriched-stats.json';

// Styleguidist sets webpack's `output.path` to `<styleguideDir>/build`, so a
// bundler plugin emitting next to the bundle lands one level below the directory
// passed to `percy styleguidist`. Look in both.
const STATS_SUBDIRS = ['.', 'build'];

const CONFIG_FILENAMES = [
  'styleguide.config.js',
  'styleguide.config.cjs',
  'styleguide.config.mjs',
  'styleguide.config.ts'
];

// Resolves the stats file to a `{ dir, file, found }` triple.
//
// `applyIntelliStory` takes the stats *directory* and reduces the configured
// stats file to its basename — path traversal is deliberately rejected there —
// so any directory component has to be resolved here instead.
export function resolveStatsLocation(buildDir, statsFile, invocationDir = process.cwd()) {
  let file = statsFile || DEFAULT_STATS_FILE;

  if (path.isAbsolute(file) || file.includes('/') || file.includes(path.sep)) {
    let abs = path.resolve(invocationDir, file);
    return { dir: path.dirname(abs), file: path.basename(abs), found: fs.existsSync(abs) };
  }

  if (!buildDir) return { dir: null, file, found: false };

  for (let sub of STATS_SUBDIRS) {
    let dir = path.resolve(buildDir, sub);
    if (fs.existsSync(path.join(dir, file))) return { dir, file, found: true };
  }

  // Hand back the build directory anyway so the miss is reported against the
  // path the user would expect to see.
  return { dir: path.resolve(buildDir), file, found: false };
}

// The Styleguidist config file that was actually loaded. RSG's config loader
// does not report which file it picked, so re-derive it: an explicit `--config`
// wins, otherwise look for the conventional names in the resolved `configDir`.
export function resolveConfigFile(rsgConfig, flagConfigPath, invocationDir = process.cwd()) {
  if (flagConfigPath) return path.resolve(invocationDir, flagConfigPath);
  if (!rsgConfig?.configDir) return null;

  for (let name of CONFIG_FILENAMES) {
    let candidate = path.join(rsgConfig.configDir, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

// Files Styleguidist pulls in globally rather than per component. They are
// reachable only from Styleguidist's own runtime entry, which lives in
// node_modules and is excluded from the graph — so a change to one is invisible
// to dependency traversal and has to force a full run, exactly as a change
// inside Storybook's `.storybook` directory does.
//
// Returned as absolute paths — plus an absolute `/**` glob per assets directory
// — which `bailOnChanges` rebases onto the repo root itself.
export function collectGlobalPaths(rsgConfig, components = [], graphIds) {
  let out = new Set();
  let dir = rsgConfig?.configDir;

  let addFile = value => {
    // Bare package specifiers (`todomvc-app-css/index.css`) are not repo files,
    // so only add what actually exists relative to the config directory.
    if (typeof value !== 'string' || !value || !dir) return;
    let abs = path.resolve(dir, value);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) out.add(abs);
  };

  if (rsgConfig) {
    for (let value of [].concat(rsgConfig.require || [])) addFile(value);
    addFile(rsgConfig.styles);
    addFile(rsgConfig.theme);
    if (typeof rsgConfig.template === 'string') addFile(rsgConfig.template);
    for (let value of Object.values(rsgConfig.styleguideComponents || {})) addFile(value);

    // A whole directory of assets served into every page.
    for (let value of [].concat(rsgConfig.assetsDir || [])) {
      if (typeof value !== 'string' || !value || !dir) continue;
      let abs = path.resolve(dir, value);
      if (fs.existsSync(abs)) out.add(`${abs.split(path.sep).join('/')}/**`);
    }
  }

  for (let component of components) {
    // Percy JSON sidecars hold snapshot options (widths, additionalSnapshots).
    // Styleguidist requires them from its own entry, so they sit outside the
    // component graph too, and a change to one changes what we capture.
    if (component?.metadataPath) out.add(component.metadataPath);

    // Examples markdown the graph does not contain. It decides everything the
    // component's page renders, but nothing depends on it as far as the graph
    // is concerned, so a change to it cannot be attributed to the component —
    // the only safe reading is "this could affect anything".
    let examples = component?.examplesFile;
    if (examples && !graphIds?.has(examples)) out.add(examples);
  }

  return [...out];
}

// Module ids present in the dependency graph, as a Set of absolute paths.
//
// Selection is keyed on a path the graph knows about, so we have to know which
// paths those are before choosing an anchor. This re-reads the stats file that
// `applyIntelliStory` will read again — wasteful on a large graph, but the
// alternative is guessing, and guessing wrong loses comparisons silently.
//
// Returns an empty Set on any failure: that makes every component fall back to
// its source and every examples file force a full run, which is the safe
// direction. `applyIntelliStory` reports the unreadable file properly.
export function readGraphIds(statsDir, statsFile) {
  try {
    let stats = JSON.parse(fs.readFileSync(path.join(statsDir, statsFile), 'utf8'));
    return new Set((stats.modules || []).map(m => m.id).filter(id => typeof id === 'string'));
  } catch {
    return new Set();
  }
}

// The file whose dependency subtree defines what a component's page renders.
//
// Ideally this is the examples markdown: Styleguidist's examples-loader turns
// `Button.md` into a module that requires `Button.js` plus everything the
// examples import, which would make it the exact analogue of a Storybook
// `*.stories.js` entry. But the Percy bundler plugin only emits modules with at
// least one ES module import or export, and the examples-loader emits
// CommonJS — so in practice the markdown is not a vertex, and neither is the
// Styleguidist entry that requires it (that lives in node_modules). Anchoring
// there would key selection on a path the graph has never heard of.
//
// So: anchor on the markdown when the graph actually contains it, and otherwise
// on the component source, which is ES module and always a vertex. Markdown
// that is not in the graph is untraceable and forces a full run instead — see
// `collectGlobalPaths`.
export function componentImportPath(component, graphIds) {
  let examples = component?.examplesFile;
  if (examples && graphIds?.has(examples)) return examples;
  return component?.sourcePath || examples || null;
}

// Assembles the `intelliStoryConfig` handed to `applyIntelliStory`, the stats
// directory to read the dependency graph from, and the graph's module ids.
// Returns `{ skipReason }` instead when IntelliStory cannot run at all.
export function prepareIntelliStory({
  config, buildDir, rsgConfig, components, flagConfigPath, invocationDir = process.cwd()
}) {
  let stats = resolveStatsLocation(buildDir, config.statsFile, invocationDir);

  if (!stats.found) {
    return {
      skipReason: stats.dir
        ? `IntelliStory: stats file "${stats.file}" not found in ${stats.dir}; running full snapshot set`
        : `IntelliStory: stats file "${stats.file}" could not be located — pass the styleguide build directory (e.g. \`percy styleguidist ./styleguide\`) or set styleguidist.intelliStory.statsFile to its path; running full snapshot set`
    };
  }

  let configFile = config.configFile
    ? path.resolve(invocationDir, config.configFile)
    : resolveConfigFile(rsgConfig, flagConfigPath, invocationDir);

  let graphIds = readGraphIds(stats.dir, stats.file);
  let globalPaths = collectGlobalPaths(rsgConfig, components, graphIds);

  return {
    graphIds,
    statsDir: stats.dir,
    intelliStoryConfig: {
      ...config,
      statsFile: stats.file,
      // `configDir` is Storybook's name for "config that affects everything".
      // The matcher takes a single-segment value at any depth and a
      // multi-segment one as a path prefix, so a config *file* works unchanged.
      configDir: configFile ?? undefined,
      bailOnChanges: [...(config.bailOnChanges || []), ...globalPaths]
    },
    globalPaths
  };
}

// Same contract as @percy/storybook's `applyIntelliStoryFilter`: run
// IntelliStory over the snapshot list and degrade to the full set on any
// failure, unless the user asked for the build to fail instead.
export async function applyIntelliStoryFilter(
  percy, snapshots, intelliStoryConfig, buildDir, log, apply = applyIntelliStory
) {
  if (!intelliStoryConfig?.enabled) return snapshots;

  try {
    return await apply(percy, snapshots, intelliStoryConfig, buildDir);
  } catch (e) {
    if (e instanceof IntelliStoryBailError) {
      log.info(e.message);
    } else {
      log.warn(`IntelliStory failed (${e.message}); running full snapshot set`);
    }
    if (intelliStoryConfig.failBuildOnFailure) throw e;
    return snapshots;
  }
}

// Runs IntelliStory over the discovered components and returns them tagged with
// what `percy.snapshot()` needs.
export async function tagComponents(percy, components, {
  intelliStoryConfig, statsDir, graphIds, log, apply
}) {
  // `applyIntelliStory` speaks in snapshots keyed by `importPath`. One entry per
  // component is enough: a component's additional snapshots share its source, so
  // they share its selection.
  let pseudoSnapshots = components.map(c => ({
    name: c.name,
    importPath: componentImportPath(c, graphIds)
  }));

  let tagged = await applyIntelliStoryFilter(
    percy, pseudoSnapshots, intelliStoryConfig, statsDir, log, apply
  );

  // A bail returns the input array untouched — no tags, so nothing to apply.
  if (tagged === pseudoSnapshots) return components;

  // Positional: `applyIntelliStory` maps over the array it was given.
  return components.map((component, i) => {
    let { intelliStory, storybookPath } = tagged[i] || {};

    if (!intelliStory) {
      // No resolvable source path — the API rejects the tag without one, so the
      // component is captured as normal. Still report `intelliStory: false` so
      // the kept/skipped tally covers every snapshot in the build.
      log.debug(`IntelliStory: no source path for "${component.name}"; it will always be captured`);
      return { ...component, intelliStory: false };
    }

    return { ...component, intelliStory: true, storybookPath };
  });
}

// Snapshot options carrying the selection tags, spread into `percy.snapshot()`.
// Empty when IntelliStory did not run, so @percy/client does not tally the build.
export function intelliStoryOptions(component) {
  if (typeof component?.intelliStory !== 'boolean') return {};
  if (!component.intelliStory) return { intelliStory: false };
  return { intelliStory: true, storybookPath: component.storybookPath };
}

// Reports the server-side outcome and writes the trace. Called after the build
// is finalized, which is when the graph job's data becomes readable. Never lets
// a reporting failure fail an otherwise-successful build.
export async function reportIntelliStory(percy, intelliStoryConfig, log, write = writeIntelliStoryTrace) {
  if (!percy.build?.id) return;

  // Derived from each snapshot create response (`skipped-via-smartsnap`), which
  // @percy/client tallies as snapshots are posted.
  let stats = percy.client.intelliStoryStats;
  if (stats) {
    let total = stats.kept + stats.skipped;
    log.info(`IntelliStory: filtered out ${stats.skipped} of ${total} snapshots with no detected changes; the remaining ${stats.kept} were processed.`);
  }

  try {
    await write(percy, intelliStoryConfig, log);
  } catch (e) {
    log.debug(`IntelliStory: failed to write trace after finalize: ${e.message}`);
  }
}
