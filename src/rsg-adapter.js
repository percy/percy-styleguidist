import { createRequire } from 'module';
import { pathToFileURL } from 'url';
import path from 'path';

// Resolve from the consuming project's cwd, not the SDK's location.
const projectRequire = createRequire(
  pathToFileURL(path.join(process.cwd(), '__resolve__.js')).href
);

export function getConfig(configPath) {
  try {
    projectRequire.resolve('react-styleguidist/package.json');
  } catch (e) {
    /* istanbul ignore next: cannot test without uninstalling react-styleguidist */
    throw new Error(
      '@percy/styleguidist requires react-styleguidist.\n' +
      'Install it: npm install --save-dev react-styleguidist'
    );
  }

  return projectRequire('react-styleguidist/lib/scripts/config').default(configPath || undefined);
}

export function getSections(config) {
  return projectRequire('react-styleguidist/lib/loaders/utils/getSections').default(config.sections, config);
}
