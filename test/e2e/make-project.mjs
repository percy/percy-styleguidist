// Builds a throwaway React Styleguidist project inside a fresh git repo. Nested
// under percy-styleguidist so node resolves react/react-styleguidist/webpack
// from the SDK's own node_modules, and so `git rev-parse --show-toplevel` from
// inside it returns the throwaway repo rather than the SDK's.
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

export const FILES = {
  'src/lib/theme.js': `
export const theme = {
  primary: '#6c5ce7',
  danger: '#d63031',
  radius: '4px'
};
`,

  'src/globals.js': `
// Pulled in through styleguide.config.js \`require\`, so it affects every page
// and is not reachable from any single component.
export const APP_NAME = 'e2e';
`,

  'src/components/Button/Button.js': `
import React from 'react';
import { theme } from '../../lib/theme';

/** A button. */
export default function Button({ children = 'Click me', kind = 'primary' }) {
  return (
    <button style={{ background: theme[kind], borderRadius: theme.radius, color: '#fff' }}>
      {children}
    </button>
  );
}
`,
  'src/components/Button/Button.md': `
A primary button:

\`\`\`jsx
<Button>Save</Button>
\`\`\`
`,
  'src/components/Button/Button.json': `{
  "percy": {
    "widths": [375, 1280]
  }
}
`,

  'src/components/Card/Card.js': `
import React from 'react';
import Button from '../Button/Button';

/** A card with an action. */
export default function Card({ title = 'Card' }) {
  return (
    <div>
      <h3>{title}</h3>
      <Button>Action</Button>
    </div>
  );
}
`,
  'src/components/Card/Card.md': `
\`\`\`jsx
<Card title="Hello" />
\`\`\`
`,

  'src/components/Alert/Alert.js': `
import React from 'react';
import { theme } from '../../lib/theme';

/** An alert. */
export default function Alert({ children = 'Careful' }) {
  return <div style={{ color: theme.danger }}>{children}</div>;
}
`,
  'src/components/Alert/Alert.md': `
\`\`\`jsx
<Alert>Something happened</Alert>
\`\`\`
`,

  'src/components/Badge/Badge.js': `
import React from 'react';

/** A standalone badge with no shared dependencies. */
export default function Badge({ count = 3 }) {
  return <span>{count}</span>;
}
`,
  'src/components/Badge/Badge.md': `
\`\`\`jsx
<Badge count={7} />
\`\`\`
`,

  'enriched-stats-plugin.cjs': `
// Emits the dependency graph in the shape @percy/cli-command's IntelliStory
// reader expects: absolute module ids, with \`imports[]\` entries carrying
// \`{ type: 'src' | 'module', source }\`. Built from webpack's own module graph,
// so the examples-loader modules for the .md files are in here too.
const path = require('path');

module.exports = class EnrichedStatsPlugin {
  constructor(options = {}) {
    this.filename = options.filename || 'enriched-stats.json';
  }

  apply(compiler) {
    const { RawSource } = compiler.webpack.sources;

    compiler.hooks.thisCompilation.tap('EnrichedStatsPlugin', compilation => {
      compilation.hooks.processAssets.tap({
        name: 'EnrichedStatsPlugin',
        stage: compilation.constructor.PROCESS_ASSETS_STAGE_REPORT
      }, () => {
        const graph = compilation.moduleGraph;
        // One entry per resource: webpack can produce several modules for the
        // same file (e.g. \`props-loader!Button.js\` alongside \`Button.js\`), and
        // duplicate ids would be ambiguous downstream.
        const byId = new Map();

        for (const mod of compilation.modules) {
          const id = mod.resource || null;
          if (!id) continue;

          let entry = byId.get(id);
          if (!entry) {
            entry = { id, imports: [], passThroughExports: [], nonPassThroughExports: [] };
            byId.set(id, entry);
          }

          for (const connection of graph.getOutgoingConnections(mod)) {
            const dep = connection.module;
            if (!dep) continue;
            const source = dep.resource || dep.rawRequest || null;
            if (!source || source === id) continue;
            const type = path.isAbsolute(source) ? 'src' : 'module';
            if (entry.imports.some(i => i.source === source)) continue;
            entry.imports.push({ type, source });
          }
        }

        const out = JSON.stringify({
          buildId: 'rsg-e2e',
          modules: [...byId.values()]
        });

        compilation.emitAsset(this.filename, new RawSource(out));
      });
    });
  }
};
`,

  'styleguide.config.js': `
const EnrichedStatsPlugin = require('./enriched-stats-plugin.cjs');

module.exports = {
  title: 'E2E Style Guide',
  skipComponentsWithoutExample: false,
  sections: [{
    name: 'Components',
    components: 'src/components/**/*.js'
  }],
  require: [
    './src/globals.js'
  ],
  webpackConfig: {
    plugins: [new EnrichedStatsPlugin()],
    module: {
      rules: [{
        test: /\\.jsx?$/,
        exclude: /node_modules/,
        use: {
          loader: 'babel-loader',
          options: { presets: ['@babel/preset-env', '@babel/preset-react'] }
        }
      }]
    }
  }
};
`,

  'package.json': `{
  "name": "e2e-styleguide",
  "version": "1.0.0",
  "private": true
}
`,

  '.gitignore': `styleguide/
node_modules/
`
};

export function makeProject(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  for (let [rel, contents] of Object.entries(FILES)) {
    let abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contents.replace(/^\n/, ''));
  }

  let git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'e2e@example.com');
  git('config', 'user.name', 'E2E');
  git('config', 'commit.gpgsign', 'false');
  git('add', '-A');
  git('commit', '-q', '-m', 'initial');

  return dir;
}

export function commitChange(dir, relPath, append) {
  let abs = path.join(dir, relPath);
  fs.appendFileSync(abs, append);
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-q', '-m', `touch ${relPath}`], { cwd: dir, stdio: 'pipe' });
  return head(dir);
}

export function head(dir) {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
}

// The CLI's `assertSafeRef` rejects `~` and `^`, so a baseline has to be spelled
// as a plain ref or SHA -- resolve HEAD~1 here rather than passing it through.
export function prevHead(dir) {
  return execFileSync('git', ['rev-parse', 'HEAD~1'], { cwd: dir, encoding: 'utf8' }).trim();
}
