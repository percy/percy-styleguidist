import fs from 'fs';
import path from 'path';
import { getConfig, getSections } from './rsg-adapter.js';

function nameFromFilepath(filepath) {
  if (!filepath) return null;
  let filename = filepath.replace(/\\/g, '/').split('/').pop();
  return filename.replace(/\.\w+$/, '');
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
      let percy = meta.percy || {};
      // Strip `execute` from JSON sidecars. JSON files are not reviewed like JS,
      // so allowing arbitrary `page.eval` strings here is a supply-chain risk.
      if (Array.isArray(percy.additionalSnapshots)) {
        percy.additionalSnapshots = percy.additionalSnapshots.map(({ execute, ...rest }) => {
          if (execute && log) log.warn(`Ignoring "execute" in ${jsonPath} — not allowed in JSON sidecars`);
          return rest;
        });
      }
      return percy;
    }
  } catch (e) {
    if (log) log.warn(`Failed to parse percy config from ${jsonPath}: ${e.message}`);
  }
  return {};
}

// Recursively flatten RSG sections tree into a list of components.
function flattenSections(sections, configDir, log, depth = 0) {
  if (depth > 10 || !Array.isArray(sections)) return [];

  let components = [];
  for (let section of sections) {
    if (Array.isArray(section.components)) {
      for (let comp of section.components) {
        if (!comp.slug) continue;
        let name = comp.visibleName || comp.name || nameFromFilepath(comp.filepath);
        if (!name) continue;
        components.push({
          name,
          slug: comp.slug,
          filepath: comp.filepath || null,
          percy: readPercyConfig(comp.filepath, configDir, log)
        });
      }
    }
    if (Array.isArray(section.sections)) {
      components.push(...flattenSections(section.sections, configDir, log, depth + 1));
    }
  }
  return components;
}

// Exported for testing
export { flattenSections, readPercyConfig, nameFromFilepath };

export function discoverComponents(configPath, log) {
  let config = getConfig(configPath);
  let sections = getSections(config);
  let components = flattenSections(sections, config.configDir, log);

  if (log) log.debug(`Discovered ${components.length} components from ${sections.length} sections`);
  return components;
}
