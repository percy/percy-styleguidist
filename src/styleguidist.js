import command, { logger } from '@percy/cli-command';
import * as common from './common.js';
import { discoverComponents } from './discovery.js';
import { shouldIncludeComponent } from './config.js';
import { takeStyleguidistSnapshots, buildSnapshotName } from './snapshots.js';
import start from './start.js';

export const styleguidist = command('styleguidist', {
  description: 'Snapshot React Styleguidist components',
  commands: [start],

  args: [{
    name: 'url|directory',
    description: 'Styleguidist URL or build output directory',
    attribute: val => /^https?:\/\//.test(val) ? 'url' : 'serve',
    required: true
  }],

  flags: [...common.flags],

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

  // Discovery + filter live in the CLI so we can log "Discovered N",
  // honor dry-run, and return early when filters exclude everything —
  // none of which the programmatic API needs to do.
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

  yield* percy.yield.start();
  try {
    let { captured, failed } = await takeStyleguidistSnapshots(percy, {
      baseUrl,
      components: filtered,
      log
    });
    log.info(`Done: ${captured} captured, ${failed} failed`);
    if (failed > 0) throw new Error(`${failed} component(s) failed to capture`);
  } finally {
    yield* percy.yield.stop();
    await server?.close();
  }
});

export default styleguidist;
