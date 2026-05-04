import { discoverComponents } from './discovery.js';
import { shouldIncludeComponent } from './config.js';

/* istanbul ignore next: NOOP_LOG only fires when a caller passes no log */
const NOOP_LOG = {
  warn: () => {}, error: () => {}, debug: () => {}
};

// Build snapshot name from additional snapshot config.
// Exported for the CLI's dry-run path.
export function buildSnapshotName(componentName, add) {
  if (add.name) return add.name;
  let prefix = add.prefix ? add.prefix : '';
  let suffix = add.suffix ? add.suffix : '';
  return prefix + componentName + suffix;
}

/* istanbul ignore next: browser-evaluated function */
/* eslint-disable no-var, no-undef */
function evalNavigateToComponent(_, name) {
  window.location.hash = '!/' + name;

  return new Promise(function(resolve) {
    var deadline = Date.now() + 10000;
    function check() {
      var root = document.getElementById('rsg-root');
      if (root && root.innerHTML.length > 200) {
        setTimeout(function() { resolve(true); }, 300);
        return;
      }
      if (Date.now() > deadline) {
        resolve(false);
        return;
      }
      requestAnimationFrame(check);
    }
    setTimeout(check, 100);
  });
}
/* eslint-enable no-var, no-undef */

// Programmatic snapshot entry point.
//
// Caller responsibilities:
//   - have a started Percy instance (await percy.start() before calling)
//   - call await percy.stop() afterwards
//   - manage any static-file server they want to serve from
//
// opts:
//   baseUrl     (required) — Styleguidist URL (loopback or remote)
//   components  (optional) — pre-discovered components; skips discovery+filter
//   configPath  (optional) — path to styleguide.config.js (used if !components)
//   include     (optional) — string or array of include patterns
//   exclude     (optional) — string or array of exclude patterns
//   log         (optional) — logger with info/warn/error/debug
//
// Returns { captured, failed, total }. Does not throw on per-component
// failures — caller decides whether to fail the build based on `failed`.
export async function takeStyleguidistSnapshots(percy, opts = {}) {
  let log = opts.log || NOOP_LOG;
  let baseUrl = opts.baseUrl;
  if (!baseUrl) {
    throw new Error('takeStyleguidistSnapshots: opts.baseUrl is required');
  }

  let filtered;
  if (opts.components) {
    // Caller has already discovered + filtered. Trust the list.
    filtered = opts.components;
  } else {
    let discovered = discoverComponents(opts.configPath, log);
    let flags = { include: opts.include, exclude: opts.exclude };
    filtered = discovered.filter(c => {
      if (c.percy?.skip) return false;
      return shouldIncludeComponent(c.name, flags);
    });
  }

  if (!filtered.length) {
    return { captured: 0, failed: 0, total: 0 };
  }

  await percy.browser.launch();

  let captured = 0;
  let failed = 0;

  async function snapshotComponent(page, component) {
    try {
      let { skip, additionalSnapshots, ...compOpts } = component.percy;

      let rendered = await page.eval(evalNavigateToComponent, component.name);

      /* istanbul ignore next: browser render timeout — requires 10s wait in browser context */
      if (!rendered) {
        log.warn(`Component "${component.name}" did not render within timeout, skipping`);
        failed++;
        return;
      }

      let snapshot = await page.snapshot({ name: component.name });

      percy.snapshot({
        ...snapshot,
        ...compOpts,
        name: component.name,
        url: `${baseUrl}?id=${component.slug}`
      });

      captured++;
      log.debug(`Captured: ${component.name}`);

      for (let additional of (additionalSnapshots || [])) {
        try {
          let { prefix, suffix, name: addName, ...addOpts } = additional;
          let name = buildSnapshotName(component.name, { name: addName, prefix, suffix });
          let addSnapshot = await page.snapshot({ name });

          percy.snapshot({
            ...addSnapshot,
            ...compOpts,
            ...addOpts,
            name,
            url: `${baseUrl}?id=${component.slug}-${encodeURIComponent(name)}`
          });

          captured++;
          log.debug(`Captured additional: ${name}`);
        } catch (err) {
          log.error(`Failed additional "${component.name}": ${err.message || err}`);
          failed++;
        }
      }
    } catch (err) {
      log.error(`Failed "${component.name}": ${err.message || err}`);
      failed++;
    }
  }

  // Cooperative cancellation: first worker to throw sets `aborted`,
  // siblings stop draining between components.
  let aborted = false;
  let firstErr;

  let queue = filtered.slice();
  async function worker() {
    let page;
    try {
      page = await percy.browser.page({
        networkIdleTimeout: percy.config.discovery?.networkIdleTimeout
      });
      await page.goto(baseUrl);

      /* istanbul ignore next: browser-evaluated function */
      /* eslint-disable no-var */
      let mounted = await page.eval(function waitForMount() {
        return new Promise(function(resolve) {
          var deadline = Date.now() + 30000;
          function check() {
            var root = document.getElementById('rsg-root');
            if (root && root.children.length > 0) return resolve(true);
            if (Date.now() > deadline) return resolve(false);
            setTimeout(check, 200);
          }
          check();
        });
      });
      /* eslint-enable no-var */

      if (!mounted) {
        log.error('RSG did not mount within 30 seconds');
        throw new Error('RSG mount timeout');
      }

      // eslint-disable-next-line no-unmodified-loop-condition
      while (!aborted && queue.length) {
        await snapshotComponent(page, queue.shift());
      }
    } catch (err) {
      aborted = true;
      firstErr = firstErr || err;
    } finally {
      /* istanbul ignore next: defensive — page.close errors during teardown shouldn't mask the real failure */
      try { await page?.close(); } catch { /* swallow */ }
    }
  }

  let concurrency = Math.min(
    percy.config.styleguidist?.concurrency ?? percy.config.discovery?.concurrency ?? 5,
    filtered.length
  );
  log.debug(`Snapshotting with concurrency=${concurrency}`);

  await Promise.all(
    Array.from({ length: concurrency }, () => worker())
  );

  if (firstErr) throw firstErr;

  return { captured, failed, total: filtered.length };
}
