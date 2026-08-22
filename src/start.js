/* istanbul ignore file: spawning a real Styleguidist dev server is too
   heavy for the test suite; this command is exercised manually */
import command, { logger } from '@percy/cli-command';
import * as common from './common.js';
import { takeStyleguidistSnapshots } from './snapshots.js';
import { discover } from './discovery.js';
import { shouldIncludeComponent } from './config.js';
import { prepareIntelliStory, tagComponents, reportIntelliStory } from './intelli-story.js';

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
    let { config, components } = discover(flags.config, log);
    if (!components.length) {
      log.warn('No components found. Check your styleguide.config.js');
      return;
    }
    let filtered = components.filter(c => !c.percy?.skip && shouldIncludeComponent(c.name, flags));
    if (!filtered.length) {
      log.warn('All components were excluded by filters');
      return;
    }

    // The dev server bundles in memory, so IntelliStory only has a dependency
    // graph to read if the project also produced one on disk — which means
    // `styleguidist.intelliStory.statsFile` has to point at it.
    let intelliStoryConfig, statsDir;
    if (percy.config.styleguidist?.intelliStory?.enabled && !percy.dryRun) {
      let prepared = prepareIntelliStory({
        config: percy.config.styleguidist.intelliStory,
        rsgConfig: config,
        components: filtered,
        flagConfigPath: flags.config
      });

      if (prepared.skipReason) log.info(prepared.skipReason);
      else ({ intelliStoryConfig, statsDir } = prepared);
    }

    yield* percy.yield.start();
    let result;

    try {
      if (intelliStoryConfig) {
        yield* percy.yield.startBuild();
        filtered = yield tagComponents(percy, filtered, { intelliStoryConfig, statsDir, log });
      }

      result = await takeStyleguidistSnapshots(percy, {
        baseUrl,
        components: filtered,
        log
      });
      log.info(`Done: ${result.captured} captured, ${result.failed} failed`);
    } finally {
      yield* percy.yield.stop();
    }

    if (intelliStoryConfig) yield reportIntelliStory(percy, intelliStoryConfig, log);
    if (result.failed > 0) throw new Error(`${result.failed} component(s) failed to capture`);
  } finally {
    proc.kill();
  }
});

export default start;
