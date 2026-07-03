import babel from '@babel/core';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

// Project root (this file lives in test/)
const projectRoot = new URL('../', import.meta.url).href;

// Node 18+ uses the `load` hook instead of `transformSource`
export async function load(url, context, next) {
  // Only transform this project's own files (not node_modules, and not files
  // outside the repo). Scoping to the project root matters: when @percy/*
  // packages are yarn-linked from a CLI git build, node resolves the symlinks
  // to their real path outside this repo (no `node_modules` segment), and
  // transforming those files here would force-label the CLI's CJS dist files
  // as `format: 'module'` — stripping their exports and breaking CJS/ESM
  // interop (e.g. "'@percy/sdk-utils' does not provide an export named
  // 'default'"). Deferring to the default loader keeps interop intact.
  if (url.startsWith(projectRoot) && !url.includes('node_modules')) {
    let filename = fileURLToPath(url);
    let source = readFileSync(filename, 'utf-8');

    let result = await babel.transformAsync(source, {
      filename,
      babelrcRoots: ['.']
    });

    if (result?.code) {
      return {
        format: 'module',
        source: result.code,
        shortCircuit: true
      };
    }
  }

  return next(url, context);
}
