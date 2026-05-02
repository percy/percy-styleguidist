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

> **Note:** `execute` (arbitrary JavaScript run in the snapshot browser) is
> intentionally **not** supported via JSON sidecars. JSON files are typically
> not reviewed as carefully as JS, so accepting executable strings there
> would let any contributor land code that runs in your CI's headless
> browser. Use `.percy.yml` or the Percy programmatic API for cases that
> need to mutate component state before capture.

Components without a `.json` file use global Percy defaults from `.percy.yml`.
