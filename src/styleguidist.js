import command, { logger } from '@percy/cli-command';
import { discoverComponents } from './discovery.js';
import { shouldIncludeComponent } from './config.js';
import { getTurboSnapFilter } from './turbosnap.js';
import { getConfig } from './rsg-adapter.js';

// Build snapshot name from additional snapshot config
function buildSnapshotName(componentName, add) {
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

export const styleguidist = command('styleguidist', {
  description: 'Snapshot React Styleguidist components',

  args: [{
    name: 'url|directory',
    description: 'Styleguidist URL or build output directory',
    attribute: val => /^https?:\/\//.test(val) ? 'url' : 'serve',
    required: true
  }],

  flags: [{
    name: 'include',
    description: 'Pattern matching component names to include in snapshots',
    type: 'pattern',
    multiple: true,
    short: 'i'
  }, {
    name: 'exclude',
    description: 'Pattern matching component names to exclude from snapshots',
    type: 'pattern',
    multiple: true,
    short: 'e'
  }, {
    name: 'config',
    description: 'Path to styleguide.config.js',
    type: 'string'
  }],

  examples: [
    '$0 ./styleguide',
    '$0 http://localhost:6060'
  ],

  percy: {
    // delayUploads intentionally left false: TurboSnap needs percy.build.id
    // (set by the snapshots-queue start handler) BEFORE snapshotting begins.
    // With delayUploads:true, the start handler is deferred until first
    // snapshot, which is too late for TurboSnap to narrow the component set.
  }

}, async function*({ percy, args, flags, exit }) {
  if (!percy) exit(0, 'Percy is disabled');
  let log = logger('styleguidist');
  let { createServer } = yield import('@percy/cli-command/utils');

  let server = args.serve && await createServer({ ...args, cleanUrls: true }).listen();
  let baseUrl = args.url ?? server?.address();

  log.info(`Using Styleguidist at: ${baseUrl}`);

  // Discover components via Node.js config resolution.
  // Each component includes percy config from its JSON sidecar file.
  let components;
  try {
    components = discoverComponents(flags.config, log);
  } catch (err) {
    log.error(`Component discovery failed: ${err.message}`);
    exit(1, err.message);
  }

  if (!components.length) {
    log.warn('No components found. Check your styleguide.config.js');
    return;
  }

  log.info(`Discovered ${components.length} component(s)`);

  // Apply CLI include/exclude + sidecar skip filters first. Order: these
  // compose with TurboSnap (below) — TurboSnap narrows AFTER the caller's
  // intent filters so we never add components the user excluded.
  let filtered = components.filter(c => {
    if (c.percy?.skip) {
      log.debug(`Skipping: ${c.name} (skip: true in ${c.name}.json)`);
      return false;
    }
    return shouldIncludeComponent(c.name, flags);
  });

  if (filtered.length < components.length) {
    log.info(`Snapshotting ${filtered.length} of ${components.length} components (filtered)`);
  }

  if (!filtered.length) {
    log.warn('All components were excluded by filters');
    return;
  }

  // Dry-run mode — list what would be snapshotted (no server, no TurboSnap)
  if (percy.dryRun) {
    for (let comp of filtered) {
      log.info(`Snapshot found: ${comp.name}`);
      for (let add of (comp.percy.additionalSnapshots || [])) {
        let name = buildSnapshotName(comp.name, add);
        log.info(`Snapshot found: ${name}`);
      }
    }
    await server?.close();
    return;
  }

  // Start Percy build and launch browser.
  // Outer try/finally ensures cleanup on any failure after start.
  yield* percy.yield.start();

  // TurboSnap — narrow components based on which ones are affected by the
  // diff between HEAD and the baseline commit. Runs AFTER percy.yield.start()
  // because it depends on percy.build.baselineCommitSha (set during build
  // creation) and on the local @percy/core server being up for the POST.
  try {
    let rsgConfig = getConfig(flags.config);
    let turboSnapSet = await getTurboSnapFilter({
      percy,
      rsgConfig,
      components: filtered,
      log
    });
    if (turboSnapSet !== null) {
      let narrowed = filtered.filter(c =>
        c.filepath && turboSnapSet.has(c.filepath.toLowerCase())
      );
      if (narrowed.length === 0) {
        // Zero components need capturing. Finalize the build with no snapshots;
        // Percy's server-side carry-forward inherits every baseline snapshot
        // into this build, so the UI still shows all components as unchanged.
        log.info('TurboSnap: 0 components affected — carrying forward from baseline');
        yield* percy.yield.stop();
        return;
      }
      filtered = narrowed;
    }
  } catch (err) {
    // TurboSnap must never block the build — fall back to full snapshot.
    log.debug(`TurboSnap: unexpected error (${err.message}), snapshotting all`);
  }

  try {
    yield percy.browser.launch();

    let captured = 0;
    let failed = 0;

    let page = yield percy.browser.page({
      networkIdleTimeout: percy.config.discovery?.networkIdleTimeout
    });

    try {
      await page.goto(baseUrl);

      // Wait for RSG to mount
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
        exit(1, 'RSG mount timeout');
      }

      log.debug('RSG mounted successfully');

      for (let component of filtered) {
        try {
          let { skip, additionalSnapshots, ...compOpts } = component.percy;

          // Navigate to isolated component
          let rendered = yield page.eval(evalNavigateToComponent, component.name);

          /* istanbul ignore next: browser render timeout — requires 10s wait in browser context */
          if (!rendered) {
            log.warn(`Component "${component.name}" did not render within timeout, snapshot may be incomplete`);
          }

          // Capture base snapshot
          let snapshot = await page.snapshot({ name: component.name });

          percy.snapshot({
            ...snapshot,
            ...compOpts,
            name: component.name,
            url: `${baseUrl}?id=${component.slug}`
          });

          captured++;
          log.debug(`Captured: ${component.name}`);

          // Process additional snapshots
          for (let additional of (additionalSnapshots || [])) {
            try {
              let { prefix, suffix, name: addName, execute, ...addOpts } = additional;

              if (execute) {
                await page.eval(execute);
                await new Promise(r => setTimeout(r, 500));
              }

              let addSnapshot = await page.snapshot({ name: component.name });
              let name = buildSnapshotName(component.name, { name: addName, prefix, suffix });

              percy.snapshot({
                ...addSnapshot,
                ...compOpts,
                ...addOpts,
                name,
                url: `${baseUrl}?id=${component.slug}-${encodeURIComponent(name)}`
              });

              captured++;
              log.debug(`Captured additional: ${name}`);

              if (execute) {
                yield page.eval(evalNavigateToComponent, component.name);
              }
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
    } finally {
      await page?.close();
    }

    log.info(`Done: ${captured} captured, ${failed} failed`);
  } finally {
    // Always finalize Percy build and close server, even on errors
    yield* percy.yield.stop();
    await server?.close();
  }
});

export default styleguidist;
