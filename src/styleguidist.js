import command, { logger } from '@percy/cli-command';
import { discoverComponents } from './discovery.js';
import { shouldIncludeComponent } from './config.js';

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
    delayUploads: true
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
    throw err;
  }

  if (!components.length) {
    log.warn('No components found. Check your styleguide.config.js');
    return;
  }

  log.info(`Discovered ${components.length} component(s)`);

  // Single filter pass: CLI include/exclude + skip from JSON sidecar
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

  // Dry-run mode
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
        throw new Error('RSG mount timeout');
      }

      log.debug('RSG mounted successfully');

      for (let component of filtered) {
        try {
          let { skip, additionalSnapshots, ...compOpts } = component.percy;

          // Navigate to isolated component
          let rendered = yield page.eval(evalNavigateToComponent, component.name);

          /* istanbul ignore next: browser render timeout — requires 10s wait in browser context */
          if (!rendered) {
            log.warn(`Component "${component.name}" did not render within timeout, skipping`);
            failed++;
            continue;
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
    if (failed > 0) throw new Error(`${failed} component(s) failed to capture`);
  } finally {
    // Always finalize Percy build and close server, even on errors
    yield* percy.yield.stop();
    await server?.close();
  }
});

export default styleguidist;
