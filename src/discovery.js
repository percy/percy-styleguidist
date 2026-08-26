import fs from 'fs';
import path from 'path';
import { getConfig, getSections } from './rsg-adapter.js';

function nameFromFilepath(filepath) {
  if (!filepath) return null;
  let filename = filepath.replace(/\\/g, '/').split('/').pop();
  return filename.replace(/\.\w+$/, '');
}

// JSON sidecars are not reviewed like JS — accepting arbitrary code-shaped
// keys (execute, domTransformation) opens a supply-chain RCE on CI. Block
// every key not on the allowlist; warn the operator so misconfigurations
// are visible.
const ALLOWED_COMPONENT = new Set([
  'skip', 'widths', 'minHeight', 'percyCSS', 'enableJavaScript',
  'scope', 'waitForSelector', 'waitForTimeout',
  'browsers', 'regions',
  'additionalSnapshots'
]);
const ALLOWED_ADDITIONAL = new Set([
  'name', 'prefix', 'suffix',
  'widths', 'minHeight', 'percyCSS', 'enableJavaScript',
  'scope', 'waitForSelector', 'waitForTimeout',
  'browsers', 'regions'
]);
const NAME_SHAPING = new Set(['name', 'prefix', 'suffix']);

function pickAllowed(obj, allowed, jsonPath, log, where) {
  let out = {};
  let blocked = [];
  for (let [k, v] of Object.entries(obj)) {
    if (allowed.has(k)) out[k] = v;
    else blocked.push(k);
  }
  for (let k of blocked) {
    if (log) log.warn(`Ignoring "${k}" ${where} in ${jsonPath} — not allowed in JSON sidecars`);
  }
  return { allowed: out, blocked };
}

// Read percy config from a JSON sidecar file next to the component.
// e.g., src/components/TodoApp/TodoApp.js → TodoApp.json
function readPercyConfig(filepath, configDir, log) {
  if (!filepath) return {};
  let absPath = path.resolve(configDir || '.', filepath);
  let jsonPath = absPath.replace(/\.\w+$/, '.json');
  try {
    if (fs.existsSync(jsonPath)) {
      let meta = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
      let raw = meta.percy || {};
      let { allowed: percy } = pickAllowed(raw, ALLOWED_COMPONENT, jsonPath, log, '');

      if (Array.isArray(percy.additionalSnapshots)) {
        percy.additionalSnapshots = percy.additionalSnapshots.flatMap(a => {
          /* istanbul ignore next: defensive — RSG won't produce malformed entries */
          if (!a || typeof a !== 'object') return [];
          let { allowed: stripped, blocked } = pickAllowed(a, ALLOWED_ADDITIONAL, jsonPath, log, 'in additionalSnapshot');
          // If a stripped key was the only differentiator, the variant would
          // produce an identical-to-base snapshot. Drop it loudly.
          let hasDiff = Object.keys(stripped).some(k => !NAME_SHAPING.has(k));
          if (blocked.length && !hasDiff) {
            if (log) log.warn(`Dropping additionalSnapshot in ${jsonPath} — no differentiator left after stripping ${blocked.join(',')}`);
            return [];
          }
          return [stripped];
        });
      }
      return percy;
    }
  } catch (e) {
    if (log) log.warn(`Failed to parse percy config from ${jsonPath}: ${e.message}`);
  }
  return {};
}

// Absolute path of the component's examples markdown, or null when it has none.
//
// RSG's own `getExampleFilename` resolver is used so custom conventions
// (`Readme.md`, `FolderName.md`, or a user-supplied function) are honored
// exactly as the styleguide build does. IntelliStory anchors change detection on
// this file — see `componentImportPath` in intelli-story.js.
function exampleFileFor(sourcePath, rsgConfig) {
  if (!sourcePath || typeof rsgConfig?.getExampleFilename !== 'function') return null;
  try {
    let file = rsgConfig.getExampleFilename(sourcePath);
    return (typeof file === 'string' && file && fs.existsSync(file)) ? file : null;
  } catch (e) {
    /* istanbul ignore next: a user-supplied resolver that throws */
    return null;
  }
}

// Recursively flatten RSG sections tree into a list of components.
function flattenSections(sections, configDir, log, depth = 0, rsgConfig = null) {
  if (depth > 10 || !Array.isArray(sections)) return [];

  let components = [];
  for (let section of sections) {
    if (Array.isArray(section.components)) {
      for (let comp of section.components) {
        if (!comp.slug) continue;
        let name = comp.visibleName || comp.name || nameFromFilepath(comp.filepath);
        if (!name) continue;

        // RSG reports `filepath` relative to its config directory. Absolute
        // paths are what IntelliStory needs: it rebases them onto the git
        // project root itself, which a config-relative path cannot survive.
        let sourcePath = comp.filepath ? path.resolve(configDir || '.', comp.filepath) : null;
        let metadataPath = sourcePath?.replace(/\.\w+$/, '.json');

        components.push({
          name,
          slug: comp.slug,
          filepath: comp.filepath || null,
          sourcePath,
          examplesFile: exampleFileFor(sourcePath, rsgConfig),
          metadataPath: (metadataPath && fs.existsSync(metadataPath)) ? metadataPath : null,
          percy: readPercyConfig(comp.filepath, configDir, log)
        });
      }
    }
    if (Array.isArray(section.sections)) {
      components.push(...flattenSections(section.sections, configDir, log, depth + 1, rsgConfig));
    }
  }
  return components;
}

// Exported for testing
export { flattenSections, readPercyConfig, nameFromFilepath, exampleFileFor };

// Discovery plus the resolved RSG config. IntelliStory needs the config itself
// (for `getExampleFilename`, `require`, `styles`, …), not just the components.
export function discover(configPath, log) {
  let config = getConfig(configPath);
  let sections = getSections(config);
  let components = flattenSections(sections, config.configDir, log, 0, config);

  if (log) log.debug(`Discovered ${components.length} components from ${sections.length} sections`);
  return { config, components };
}

export function discoverComponents(configPath, log) {
  return discover(configPath, log).components;
}
