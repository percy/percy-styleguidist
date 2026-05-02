# Changelog

## 0.1.0

Initial release of `@percy/styleguidist`.

### Features
- `percy styleguidist <url|directory>` — snapshots every component example
  in your React Styleguidist instance.
- Per-component Percy configuration via JSON sidecar files
  (e.g. `Button.json` next to `Button.js`).
- `additionalSnapshots` for capturing the same component at multiple widths,
  with prefix/suffix naming.
- `--include` / `--exclude` glob and `/regex/` filtering.
- Concurrent snapshot capture honoring `percy.config.discovery.concurrency`
  (default 5 parallel workers).

### Notes
- `execute` strings in JSON sidecars are intentionally not supported; see
  README for the rationale and alternatives.
- Capture failures cause a non-zero exit by default. Set
  `PERCY_EXIT_WITH_ZERO_ON_ERROR=true` to opt into soft-fail behavior.

### Compatibility
- Node 18+
- `react-styleguidist` ≥ 11, < 14 (peer dependency)
- `@percy/cli` ≥ 1.31 (peer dependency)
