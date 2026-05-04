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
