import babel from '@babel/core';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

// Node 18+ uses the `load` hook instead of `transformSource`
export async function load(url, context, next) {
  // Only transform local project files (not node_modules)
  if (url.startsWith('file://') && !url.includes('node_modules')) {
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
