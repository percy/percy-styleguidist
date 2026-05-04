#!/usr/bin/env node
'use strict';

// Don't print the banner when installed as a transitive dependency.
if (process.env.npm_config_global || process.env.CI) return;

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const bold = useColor ? '\x1b[1m' : '';
const cyan = useColor ? '\x1b[36m' : '';
const green = useColor ? '\x1b[32m' : '';
const dim = useColor ? '\x1b[2m' : '';
const reset = useColor ? '\x1b[0m' : '';

console.log('');
console.log(bold + cyan + '  @percy/styleguidist installed.' + reset);
console.log('');
console.log('  Quickstart:');
console.log('    1. Build the styleguide: ' + green + 'npx styleguidist build' + reset);
console.log('    2. Set your token:       ' + green + 'export PERCY_TOKEN="…"' + reset);
console.log('    3. Run Percy:            ' + green + 'percy styleguidist ./styleguide' + reset);
console.log('');
console.log('  Or run dev server + Percy in one step:');
console.log('    ' + green + 'percy styleguidist-start' + reset);
console.log('');
console.log(dim + '  Docs: https://github.com/percy/percy-styleguidist#readme' + reset);
console.log('');
