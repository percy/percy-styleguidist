/* istanbul ignore file: spawning a real Styleguidist dev server is too
   heavy for the test suite; this command is exercised manually */
import command, { logger } from '@percy/cli-command';
import * as common from './common.js';
import { takeStyleguidistSnapshots } from './snapshots.js';
import { discoverComponents } from './discovery.js';
import { shouldIncludeComponent } from './config.js';

function waitForServer(url, timeoutMs = 60000) {
  let deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    let attempt = async () => {
      try {
        let res = await fetch(url, { method: 'HEAD' });
        if (res.ok || res.status < 500) return resolve();
      } catch { /* not yet listening */ }
      if (Date.now() > deadline) return reject(new Error(`Timed out waiting for ${url}`));
      setTimeout(attempt, 250);
    };
    attempt();
  });
}

export const start = command('styleguidist-start', {
  description: 'Spawn the React Styleguidist dev server and snapshot components',
  loose: true,

  flags: [...common.flags, {
    name: 'port',
    description: 'Port for the Styleguidist dev server',
    type: 'integer',
    default: 6060
  }, {
    name: 'host',
    description: 'Host for the Styleguidist dev server',
    type: 'hostname',
    default: 'localhost'
  }],

  examples: [
    '$0',
    '$0 --port 6060',
    '$0 --include "Button*"'
  ],

  percy: {
    delayUploads: true
  }
}, async function*({ percy, flags, argv, exit }) {
  if (!percy) exit(0, 'Percy is disabled');
  let log = logger('styleguidist');
  let { default: { spawn } } = yield import('cross-spawn');

  let { host, port } = flags;
  let baseUrl = `http://${host}:${port}`;

  let args = ['styleguidist', 'server', `--port=${port}`, ...argv];
  log.info(`Spawning: npx ${args.join(' ')}`);
  let proc = spawn('npx', args, { stdio: ['ignore', 'pipe', 'pipe'] });

  proc.on('error', err => log.error(`styleguidist server error: ${err.message}`));

  try {
    log.info(`Waiting for ${baseUrl} to be ready…`);
    await waitForServer(baseUrl);
    log.info(`Using Styleguidist at: ${baseUrl}`);

    // Discover first so we can early-return on empty config / all-filtered.
    let components = discoverComponents(flags.config, log);
    if (!components.length) {
      log.warn('No components found. Check your styleguide.config.js');
      return;
    }
    let filtered = components.filter(c => !c.percy?.skip && shouldIncludeComponent(c.name, flags));
    if (!filtered.length) {
      log.warn('All components were excluded by filters');
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
    }
  } finally {
    proc.kill();
  }
});

export default start;
