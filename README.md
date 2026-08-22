# @percy/styleguidist
[![Version](https://img.shields.io/npm/v/@percy/styleguidist.svg)](https://npmjs.org/package/@percy/styleguidist)

[Percy](https://percy.io) visual testing for [React Styleguidist](https://react-styleguidist.js.org/) components.

## Installation

```bash
npm install --save-dev @percy/cli @percy/styleguidist
```

## Usage

Build your styleguide, then run Percy:

```bash
# Build the styleguide
npx styleguidist build

# Run Percy snapshots
export PERCY_TOKEN="your-token"
percy styleguidist ./styleguide
```

Or with a running dev server:

```bash
percy styleguidist http://localhost:6060
```

Or run the dev server **and** Percy in one step:

```bash
export PERCY_TOKEN="your-token"
percy styleguidist-start --port 6060
```

## Commands

### `percy styleguidist`

```
Usage:
  $ percy styleguidist [options] <url|directory>

Options:
  -i, --include <pattern>   Include components matching pattern
  -e, --exclude <pattern>   Exclude components matching pattern
  --config <path>           Path to styleguide.config.js

Examples:
  $ percy styleguidist ./styleguide
  $ percy styleguidist http://localhost:6060
  $ percy styleguidist ./styleguide --include "Button*"
  $ percy styleguidist ./styleguide --exclude "Internal*"
```

## IntelliStory (SmartSnap)

IntelliStory skips snapshots whose source cannot have changed since the baseline
build. The SDK collects two things — the files changed since the baseline
(`git diff`) and your bundler's dependency graph — and sends them to Percy; the
API builds the graph and decides, as each snapshot is posted, which ones can
carry their baseline forward instead of being captured again.

It is opt-in, and **any** failure degrades to a full snapshot run rather than
breaking the build.

### Requirements

1. **A dependency graph in the styleguide build.** Add the Percy bundler plugin
   to your `styleguide.config.js` `webpackConfig` so the build emits
   `enriched-stats.json`:

   ```js
   module.exports = {
     webpackConfig: {
       plugins: [new PercySmartSnapPlugin()]
     }
   };
   ```

   Styleguidist writes assets into the directory you pass to
   `percy styleguidist`, so the file is found automatically there or in its
   `build/` subdirectory. Anywhere else, point `statsFile` at it.

2. **A build directory, not a URL.** Selection is keyed on the dependency graph,
   so `percy styleguidist ./styleguide` is the supported form. URL mode and
   `percy styleguidist-start` work only if you separately built the styleguide
   and point `statsFile` at the resulting stats file.

3. **A git repository** with the baseline commit present. Shallow clones that
   do not contain it fall back to a full run.

### Configuration

```yaml
# .percy.yml
version: 2
styleguidist:
  intelliStory:
    enabled: true
```

| Option | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `false` | Turn IntelliStory on |
| `baseline` | string | *(from the API)* | Git ref to diff against. Must be a plain ref or SHA — `HEAD~1` and other revision expressions are rejected. Defaults to the base build's commit as predicted by Percy |
| `statsFile` | string | `enriched-stats.json` | A bare filename is looked for in the styleguide build directory and its `build/` subdirectory; a path with directories is resolved relative to where you ran the command |
| `configFile` | string | *(auto-detected)* | Your `styleguide.config.js`. Defaults to `--config`, or the file Styleguidist discovered |
| `untraced` | string[] | `[]` | Globs for files that should never mark a component as affected (e.g. `README.md`) |
| `bailOnChanges` | string[] | `[]` | Globs that force a full run when they change |
| `failBuildOnFailure` | boolean | `false` | Fail the build instead of falling back to a full run |
| `trace` | boolean | `false` | Write a `trace.html` dependency-graph report |

Globs in `untraced` and `bailOnChanges` are relative to the directory you ran
`percy styleguidist` from. Prefix with `<rootDir>/` to anchor them at the
repository root instead.

### What anchors a component

A component's "story" is its **examples markdown** (`Button.md`), not its source
file. Styleguidist's examples-loader compiles the markdown into a module that
imports the component and everything the examples themselves use, so the whole
rendered page is reachable from it — which means editing the examples selects
the component, exactly as editing the component does. Components with no
examples file fall back to their source file.

### What forces a full run

Some Styleguidist configuration sits outside the per-component dependency graph
— it is reachable only from Styleguidist's own runtime entry — so a change to it
cannot be attributed to individual components. IntelliStory runs the full set
when any of these change:

- `styleguide.config.js` (or whatever `configFile` resolves to)
- files listed in the config's `require`
- `styles`, `theme`, a string `template`, `styleguideComponents` targets, and
  anything under `assetsDir`
- the per-component Percy JSON sidecars (they decide *what* gets captured)
- `package.json` / lockfile changes that cannot be resolved to specific packages
- a browser upgrade on the Percy project

### Output

```
[percy] IntelliStory: filtered out 42 of 50 snapshots with no detected changes; the remaining 8 were processed.
```

When IntelliStory cannot run, the reason is logged and the full set is captured:

```
[percy] IntelliStory: stats file "enriched-stats.json" not found in /app/styleguide; running full snapshot set
[percy] IntelliStory: no affected files or packages detected after filtering; running full snapshot set
```

> The IntelliStory engine is shared with `@percy/storybook`, so a few of its
> messages say "story" or "Storybook config directory" where they mean
> "component" or your `styleguide.config.js`.

## Other Percy Config

```yaml
# .percy.yml
version: 2
styleguidist:
  # Browser pages used to capture components in parallel.
  # Defaults to discovery.concurrency, or 5.
  concurrency: 5
```

## Per-Component Configuration

Add a JSON sidecar file next to your component to configure Percy options:

```
src/components/Button/
  Button.js       # component
  Button.md       # RSG examples
  Button.json     # Percy config (optional)
```

```json
{
  "percy": {
    "widths": [375, 1280],
    "percyCSS": ".tooltip { display: none; }",
    "scope": ".button-wrapper",
    "browsers": ["chrome", "firefox"],
    "regions": [
      {
        "elementSelector": { "elementCSS": ".dynamic-content" },
        "algorithm": "ignore"
      }
    ],
    "additionalSnapshots": [
      { "suffix": " - Mobile", "widths": [375] },
      { "prefix": "Tablet ", "widths": [768] }
    ]
  }
}
```

### Supported Options

| Option | Type | Description |
|---|---|---|
| `skip` | boolean | Skip this component |
| `widths` | int[] | Viewport widths |
| `minHeight` | int | Minimum viewport height |
| `browsers` | string[] | Browsers to render (`chrome`, `firefox`, etc.) |
| `percyCSS` | string | CSS injected before capture |
| `scope` | string | CSS selector to scope the snapshot |
| `domTransformation` | string | JS to transform DOM before capture |
| `enableJavaScript` | boolean | Keep JS enabled in Percy rendering |
| `waitForSelector` | string | Wait for selector before capture |
| `waitForTimeout` | int | Wait ms before capture |
| `regions` | array | Ignore/layout regions for visual diffing |
| `additionalSnapshots` | array | Extra snapshots with different options |

### Additional Snapshot Options

| Option | Type | Description |
|---|---|---|
| `name` | string | Full snapshot name (overrides prefix/suffix) |
| `prefix` | string | Prefix added to component name |
| `suffix` | string | Suffix added to component name |
| `widths` | int[] | Override widths for this snapshot |
| `percyCSS` | string | Override CSS for this snapshot |

> **Note on JSON sidecar safety:** sidecars are loaded from disk, not
> reviewed like JS, so we **only honor an allowlist** of non-executable
> options: the keys in the two tables above. Anything else (including
> `execute` and `domTransformation`) is dropped at read time with a
> warning. If an `additionalSnapshots` entry's only differentiator was a
> stripped key (so it would just duplicate the base snapshot), the entry
> itself is dropped with a `Dropping additionalSnapshot ...` warning.
>
> For state-mutating snapshots, configure `execute` in `.percy.yml` (which
> is committed alongside JS code and reviewed) or drive captures through
> the Percy programmatic API.

Components without a `.json` file use global Percy defaults from `.percy.yml`.

## Programmatic API

For custom orchestration (combining with other Percy plugins, filtering by
git diff, integrating with a test runner), drive captures from JS:

```js
import { Percy } from '@percy/core';
import { takeStyleguidistSnapshots } from '@percy/styleguidist';

const percy = new Percy({ delayUploads: true });
await percy.start();

try {
  const result = await takeStyleguidistSnapshots(percy, {
    baseUrl: 'http://localhost:6060',
    configPath: './styleguide.config.cjs',
    include: ['Button*'],
    exclude: ['Internal*']
  });
  console.log(`Captured ${result.captured}/${result.total}`);
} finally {
  await percy.stop();
}
```

`takeStyleguidistSnapshots(percy, opts)` returns `{ captured, failed, total }`.
It does not throw on per-component failures — your code decides whether to
fail the build based on the counters.

Options:
- `baseUrl` *(required)* — Styleguidist URL
- `configPath` *(optional)* — path to `styleguide.config.js`
- `include` / `exclude` *(optional)* — arrays of patterns
- `components` *(optional)* — pre-discovered components; skips internal
  discovery + filtering
- `log` *(optional)* — logger with `warn`/`error`/`debug` methods

IntelliStory is orchestrated by the command, not by this function — it has to
create the Percy build before any snapshot is posted. To drive it yourself, tag
the components and pass them in via `components`:

```js
import {
  discover, prepareIntelliStory, tagComponents, reportIntelliStory,
  takeStyleguidistSnapshots
} from '@percy/styleguidist';

const { config, components } = discover('./styleguide.config.js');
const { intelliStoryConfig, statsDir, skipReason } = prepareIntelliStory({
  config: { enabled: true },
  buildDir: './styleguide',
  rsgConfig: config,
  components
});

await percy.start();
let tagged = components;

if (!skipReason) {
  await percy.startBuild();
  tagged = await tagComponents(percy, components, { intelliStoryConfig, statsDir, log });
}

await takeStyleguidistSnapshots(percy, { baseUrl, components: tagged, log });
await percy.stop();
if (!skipReason) await reportIntelliStory(percy, intelliStoryConfig, log);
```
