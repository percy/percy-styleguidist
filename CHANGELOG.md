# Changelog

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
