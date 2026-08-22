import command, { logger } from '@percy/cli-command';
import * as common from './common.js';
import { configSchema } from './percy-config.js';
import { discover } from './discovery.js';
import { shouldIncludeComponent } from './config.js';
import { prepareIntelliStory, tagComponents, reportIntelliStory } from './intelli-story.js';
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
  },

  config: {
    schemas: [configSchema]
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
  let config, components;
  try {
    ({ config, components } = discover(flags.config, log));
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

  // IntelliStory selects snapshots server-side against the real Percy build, so
  // it only runs when there is a build to select against and a dependency graph
  // to reason about. Prepared before `percy.start()` so a missing stats file is
  // reported before any work is done.
  let intelliStoryConfig, statsDir;
  if (percy.config.styleguidist?.intelliStory?.enabled) {
    let prepared = prepareIntelliStory({
      config: percy.config.styleguidist.intelliStory,
      buildDir: args.serve,
      rsgConfig: config,
      components: filtered,
      flagConfigPath: flags.config
    });

    if (prepared.skipReason) {
      log.info(prepared.skipReason);
    } else {
      ({ intelliStoryConfig, statsDir } = prepared);
      log.debug(`IntelliStory: reading the dependency graph from ${statsDir}; ` +
        `bailing on changes to ${prepared.globalPaths.length} global Styleguidist path(s)`);
    }
  }

  yield* percy.yield.start();
  let result;

  try {
    // The build is otherwise created lazily on the first flush (uploads are
    // delayed), but the graph is keyed by the build id, so create it up front.
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
    // Finalizes the build, which is what makes the graph job's data readable.
    yield* percy.yield.stop();
    await server?.close();
  }

  if (intelliStoryConfig) {
    yield reportIntelliStory(percy, intelliStoryConfig, log);
  }

  if (result.failed > 0) throw new Error(`${result.failed} component(s) failed to capture`);
});

export default styleguidist;
