# Changelog

## 1.1.0

### Features

- **IntelliStory (SmartSnap)** — opt-in filtering that skips snapshots whose
  source cannot have changed since the baseline build. The SDK collects the git
  diff and the bundler's dependency graph; Percy decides server-side which
  snapshots carry their baseline forward.

  ```yaml
  # .percy.yml
  version: 2
  styleguidist:
    intelliStory:
      enabled: true
  ```

  Requires `@percy/bundler-plugin-smartsnap` in your `styleguide.config.js`
  `webpackConfig` to emit `enriched-stats.json`, a build directory (not a URL),
  and enough git history for the base build's commit to be present — a shallow
  CI clone (`actions/checkout` defaults to `fetch-depth: 1`) makes every build
  fall back to the full set. See the README for the full option list and the
  cases that force a full run.

  Components are anchored on their source file. Changes to examples markdown
  cannot be traced through the dependency graph, so they force a full run
  rather than being silently attributed to nothing — doc-only changes get no
  reduction for now.

- `.percy.yml` schema for the `styleguidist` key. This never existed, so
  `@percy/config` treated `styleguidist:` as an unknown property and removed
  it — meaning the previously undocumented `styleguidist.concurrency` option
  had no effect. It works now.

### Requirements

- `@percy/cli` peer range narrowed to `^1.32.7`. IntelliStory's engine
  (`applyIntelliStory`) ships in `@percy/cli-command` 1.32.7, so earlier CLI
  versions cannot run it.

### Internal

- CI tests node 20 and 22; node 18 was dropped because the dev dependency tree
  now requires >= 20. `engines.node` deliberately stays `>=18` — dev
  dependencies do not constrain consumers, so the package still runs there,
  it is simply no longer covered by CI.

## 0.1.0

Initial release of `@percy/styleguidist`.

### Features
- `percy styleguidist <url|directory>` — snapshots every component example
  in your React Styleguidist instance.
- `percy styleguidist-start [--port N]` — spawns the Styleguidist dev
  server, waits for it, and captures in one command. Convenience for CI.
- **Programmatic API**: `import { takeStyleguidistSnapshots } from '@percy/styleguidist'`.
  Drive captures from JS for custom orchestration (combine with other
  Percy plugins, filter by git diff, integrate with a test runner).
- Per-component Percy configuration via JSON sidecar files
  (e.g. `Button.json` next to `Button.js`).
- `additionalSnapshots` for capturing the same component at multiple widths,
  with prefix/suffix naming.
- `--include` / `--exclude` glob and `/regex/` filtering.
- Concurrent snapshot capture honoring `percy.config.styleguidist.concurrency`
  (or `percy.config.discovery.concurrency`, default 5 parallel workers).

### Notes
- JSON sidecar fields go through an **allowlist**. Code-shaped keys
  (`execute`, `domTransformation`) and any unknown key are dropped at
  read time with a warning. Use `.percy.yml` or the programmatic API
  if you need to mutate component state before capture.
- An `additionalSnapshots` entry whose only differentiator was a
  stripped key (so it would just duplicate the base snapshot) is
  dropped entirely with a `Dropping additionalSnapshot ...` warning.
- Snapshot workers cooperate on cancellation: when one worker fails,
  siblings stop draining the queue. Avoids long hangs on `RSG mount
  timeout` against broken builds.
- Concurrency knob precedence:
  `percy.config.styleguidist.concurrency` → `percy.config.discovery.concurrency` → `5`.
- Capture failures cause a non-zero exit by default. Set
  `PERCY_EXIT_WITH_ZERO_ON_ERROR=true` to opt into soft-fail behavior.
- `prepack` rebuilds `dist/` automatically on `npm publish`/`npm pack`,
  so a stale `dist/` cannot ship.

### Compatibility
- Node 18+
- `react-styleguidist` ≥ 11, < 14 (peer dependency)
- `@percy/cli` ≥ 1.31 (peer dependency)
