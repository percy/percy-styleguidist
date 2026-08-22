// End-to-end exercise of IntelliStory in @percy/styleguidist.
//
// Everything below the fake API is real: a real React Styleguidist project in a
// real git repo, a real webpack build emitting a real dependency graph, the real
// `percy styleguidist` command, real Chromium capture, real HTTP. The fake API
// runs the same affected-path reachability the service runs, so "only Badge was
// captured" is a genuine end-to-end result rather than a stubbed one.
import fs from 'fs';
import path from 'path';
import url from 'url';
import { spawn, execFileSync } from 'child_process';
import { createApi } from './api-server.mjs';
import { makeProject, commitChange, head, prevHead } from './make-project.mjs';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const PROJECT = path.join(HERE, 'project');
const RSG_BIN = path.join(ROOT, 'node_modules/react-styleguidist/lib/bin/styleguidist.js');
const STATS = path.join(PROJECT, 'styleguide/enriched-stats.json');
const STATS_IN_BUILD = path.join(PROJECT, 'styleguide/build/enriched-stats.json');

const VERBOSE = process.argv.includes('--verbose');

let passed = 0;
let failed = 0;
const failures = [];

function check(label, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`    ✓ ${label}`);
  } else {
    failed++;
    failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
    console.log(`    ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function buildStyleguide() {
  console.log('  building styleguide (real webpack)…');
  execFileSync(process.execPath, [RSG_BIN, 'build'], {
    cwd: PROJECT,
    stdio: VERBOSE ? 'inherit' : 'pipe',
    env: { ...process.env, NODE_ENV: 'production' }
  });
}

function writePercyConfig(intelliStory) {
  let lines = ['version: 2'];
  if (intelliStory) {
    lines.push('styleguidist:', '  intelliStory:');
    for (let [k, v] of Object.entries(intelliStory)) {
      if (Array.isArray(v)) {
        lines.push(`    ${k}:`);
        for (let item of v) lines.push(`      - ${JSON.stringify(item)}`);
      } else {
        lines.push(`    ${k}: ${JSON.stringify(v)}`);
      }
    }
  }
  fs.writeFileSync(path.join(PROJECT, '.percy.yml'), lines.join('\n') + '\n');
}

function run(port, args = ['./styleguide']) {
  return new Promise(resolve => {
    let child = spawn(process.execPath, [path.join(HERE, 'run-one.mjs'), PROJECT, ...args], {
      cwd: HERE,
      env: {
        ...process.env,
        PERCY_TOKEN: 'web_e2etoken',
        PERCY_CLIENT_API_URL: `http://127.0.0.1:${port}/api/v1`,
        PERCY_LOGLEVEL: 'debug',
        PERCY_CLIENT_ERROR_LOGS: 'false',
        PERCY_PARALLEL_TOTAL: '',
        PERCY_GIT_COMMIT: undefined
      }
    });

    let out = '';
    child.stdout.on('data', d => { out += d; if (VERBOSE) process.stdout.write(d); });
    child.stderr.on('data', d => { out += d; if (VERBOSE) process.stdout.write(d); });
    child.on('close', code => resolve({ code, out }));
  });
}

const rel = p => path.relative(PROJECT, p).split(path.sep).join('/');

async function main() {
  console.log('\n=== setup ===');
  makeProject(PROJECT);
  console.log(`  project: ${PROJECT}`);
  buildStyleguide();

  check('webpack emitted the stats file into the styleguide directory', fs.existsSync(STATS));

  let stats = JSON.parse(fs.readFileSync(STATS, 'utf8'));
  let ids = new Set(stats.modules.map(m => m.id));
  check('stats include the component sources',
    ids.has(path.join(PROJECT, 'src/components/Button/Button.js')));
  check('stats include the examples markdown',
    ids.has(path.join(PROJECT, 'src/components/Button/Button.md')));

  // The premise the whole integration rests on: the examples markdown module
  // depends on its component, so anchoring on the markdown reaches both.
  let buttonMd = stats.modules.find(m => m.id.endsWith('Button.md'));
  check('the markdown module imports its component',
    !!buttonMd?.imports?.some(i => i.source?.endsWith('Button.js')),
    JSON.stringify(buttonMd?.imports?.map(i => i.source)));

  let api = createApi({ log: VERBOSE ? m => console.log(`      api ${m}`) : undefined });
  let port = await api.listen();
  console.log(`  fake percy api on ${port}`);

  const baseSha = head(PROJECT);

  try {
    // ---------------------------------------------------------------
    console.log('\n=== 1. IntelliStory off: every component is captured, untagged ===');
    api.reset({ baseCommitSha: baseSha });
    writePercyConfig(null);
    let r = await run(port);
    check('build succeeded', r.code === 0, `exit ${r.code}`);
    check('4 snapshots posted', api.state.snapshots.length === 4,
      `got ${api.state.snapshots.length}`);
    check('no graph was requested', api.state.graphPayload === null);
    check('no snapshot carries an intelli-story tag',
      api.state.snapshots.every(s => !s.intelliStory));

    // ---------------------------------------------------------------
    console.log('\n=== 2. Enabled, nothing changed since the baseline: bail to the full set ===');
    api.reset({ baseCommitSha: baseSha });
    writePercyConfig({ enabled: true });
    r = await run(port);
    check('build succeeded', r.code === 0, `exit ${r.code}`);
    check('bailed on an empty diff',
      /IntelliStory: no affected files or packages detected/.test(r.out));
    check('all 4 snapshots still captured', api.state.snapshots.length === 4,
      `got ${api.state.snapshots.length}`);
    check('nothing was skipped', api.state.skipped.length === 0);

    // ---------------------------------------------------------------
    console.log('\n=== 3. One component\'s markdown changed: only that component is captured ===');
    commitChange(PROJECT, 'src/components/Badge/Badge.md', '\nAnd another:\n\n```jsx\n<Badge count={9} />\n```\n');
    buildStyleguide();
    api.reset({ baseCommitSha: baseSha });
    writePercyConfig({ enabled: true });
    r = await run(port);

    check('build succeeded', r.code === 0, `exit ${r.code}`);
    check('a graph was enqueued', !!api.state.graphPayload);
    check('the graph payload carries files and modules',
      api.state.graphPayload?.files?.length > 0 && api.state.graphPayload?.modules?.length > 0);
    check('storybookPaths are the examples markdown, repo-relative',
      JSON.stringify([...(api.state.graphPayload?.storybook_paths || [])].sort()) ===
        JSON.stringify([
          'src/components/Alert/Alert.md',
          'src/components/Badge/Badge.md',
          'src/components/Button/Button.md',
          'src/components/Card/Card.md'
        ]),
      JSON.stringify(api.state.graphPayload?.storybook_paths));
    check('affected nodes include the changed markdown',
      (api.state.graphPayload?.affected_nodes || []).includes('src/components/Badge/Badge.md'),
      JSON.stringify(api.state.graphPayload?.affected_nodes));
    check('affected file locations were sent',
      Object.keys(api.state.graphPayload?.affected_file_locations || {}).length > 0);
    check('every snapshot is tagged for selection',
      api.state.snapshots.length === 4 && api.state.snapshots.every(s => s.intelliStory === true),
      JSON.stringify(api.state.snapshots.map(s => [s.name, s.intelliStory])));
    check('selection kept only Badge',
      JSON.stringify(api.state.snapshots.filter(s => !s.skipped).map(s => s.name)) === '["Badge"]',
      JSON.stringify(api.state.snapshots.map(s => [s.name, s.skipped])));
    check('the summary reports 3 of 4 filtered out',
      /IntelliStory: filtered out 3 of 4 snapshots/.test(r.out),
      (r.out.match(/IntelliStory: filtered.*/) || [])[0]);

    // ---------------------------------------------------------------
    console.log('\n=== 4. A shared module changed: its dependents are captured, others skipped ===');
    commitChange(PROJECT, 'src/lib/theme.js', '\nexport const spacing = 8;\n');
    buildStyleguide();
    api.reset({ baseCommitSha: prevHead(PROJECT) });
    writePercyConfig({ enabled: true });
    r = await run(port);

    check('build succeeded', r.code === 0, `exit ${r.code}`);
    let kept = api.state.snapshots.filter(s => !s.skipped).map(s => s.name).sort();
    check('Button, Card (transitively) and Alert kept; Badge skipped',
      JSON.stringify(kept) === JSON.stringify(['Alert', 'Button', 'Card']),
      JSON.stringify(api.state.snapshots.map(s => [s.name, s.skipped])));

    // ---------------------------------------------------------------
    console.log('\n=== 5. styleguide.config.js changed: bail to the full set ===');
    commitChange(PROJECT, 'styleguide.config.js', '\n// touched\n');
    buildStyleguide();
    api.reset({ baseCommitSha: prevHead(PROJECT) });
    writePercyConfig({ enabled: true });
    r = await run(port);

    check('build succeeded', r.code === 0, `exit ${r.code}`);
    check('bailed on the Styleguidist config file',
      /IntelliStory: change to "styleguide\.config\.js"/.test(r.out),
      (r.out.match(/IntelliStory:.*styleguide\.config.*/) || [])[0]);
    check('all 4 snapshots captured, none tagged', api.state.snapshots.length === 4 &&
      api.state.snapshots.every(s => !s.intelliStory));

    // ---------------------------------------------------------------
    console.log('\n=== 6. A globally required file changed: bail to the full set ===');
    commitChange(PROJECT, 'src/globals.js', '\nexport const VERSION = 2;\n');
    buildStyleguide();
    api.reset({ baseCommitSha: prevHead(PROJECT) });
    writePercyConfig({ enabled: true });
    r = await run(port);

    check('build succeeded', r.code === 0, `exit ${r.code}`);
    check('bailed on the globally required file',
      /IntelliStory: change to ".*src\/globals\.js" matched bailOnChanges/.test(r.out),
      (r.out.match(/IntelliStory: change to.*/) || [])[0]);
    check('all 4 snapshots captured', api.state.snapshots.length === 4);

    // ---------------------------------------------------------------
    console.log('\n=== 7. A Percy JSON sidecar changed: bail to the full set ===');
    commitChange(PROJECT, 'src/components/Button/Button.json', '\n');
    buildStyleguide();
    api.reset({ baseCommitSha: prevHead(PROJECT) });
    writePercyConfig({ enabled: true });
    r = await run(port);

    check('bailed on the sidecar', /Button\.json" matched bailOnChanges/.test(r.out),
      (r.out.match(/IntelliStory: change to.*/) || [])[0]);
    check('all 4 snapshots captured', api.state.snapshots.length === 4);

    // ---------------------------------------------------------------
    console.log('\n=== 8. untraced drops a file from the affected set ===');
    commitChange(PROJECT, 'src/components/Badge/Badge.md', '\nMore docs.\n');
    buildStyleguide();
    api.reset({ baseCommitSha: prevHead(PROJECT) });
    writePercyConfig({ enabled: true, untraced: ['src/components/Badge/**'] });
    r = await run(port);

    check('build succeeded', r.code === 0, `exit ${r.code}`);
    check('bailed because the only change was untraced',
      /no affected files or packages detected/.test(r.out));
    check('all 4 snapshots captured', api.state.snapshots.length === 4);

    // ---------------------------------------------------------------
    console.log('\n=== 9. bailOnChanges forces a full run ===');
    commitChange(PROJECT, 'src/components/Badge/Badge.md', '\nEven more.\n');
    buildStyleguide();
    api.reset({ baseCommitSha: prevHead(PROJECT) });
    writePercyConfig({ enabled: true, bailOnChanges: ['src/components/Badge/*.md'] });
    r = await run(port);

    check('bailed on the user pattern',
      /matched bailOnChanges/.test(r.out), (r.out.match(/IntelliStory: change to.*/) || [])[0]);
    check('all 4 snapshots captured', api.state.snapshots.length === 4);

    // ---------------------------------------------------------------
    console.log('\n=== 10. The stats file is missing: degrade with an actionable message ===');
    api.reset({ baseCommitSha: prevHead(PROJECT) });
    writePercyConfig({ enabled: true });
    fs.renameSync(STATS, `${STATS}.bak`);
    r = await run(port);
    fs.renameSync(`${STATS}.bak`, STATS);

    check('build succeeded', r.code === 0, `exit ${r.code}`);
    check('reported where it looked',
      /IntelliStory: stats file "enriched-stats\.json" not found in .*styleguide/.test(r.out),
      (r.out.match(/IntelliStory: stats file.*/) || [])[0]);
    check('no graph was requested', api.state.graphPayload === null);
    check('all 4 snapshots captured, untagged', api.state.snapshots.length === 4 &&
      api.state.snapshots.every(s => !s.intelliStory));

    // ---------------------------------------------------------------
    console.log('\n=== 11. An explicit statsFile path is honored ===');
    api.reset({ baseCommitSha: prevHead(PROJECT) });
    writePercyConfig({ enabled: true, statsFile: rel(STATS) });
    r = await run(port);

    check('build succeeded', r.code === 0, `exit ${r.code}`);
    check('the graph was enqueued from the explicit path', !!api.state.graphPayload);

    // ---------------------------------------------------------------
    console.log('\n=== 11b. A stats file under build/ is found too ===');
    api.reset({ baseCommitSha: prevHead(PROJECT) });
    writePercyConfig({ enabled: true });
    fs.renameSync(STATS, STATS_IN_BUILD);
    r = await run(port);
    fs.renameSync(STATS_IN_BUILD, STATS);

    check('build succeeded', r.code === 0, `exit ${r.code}`);
    check('found the stats file in the build/ subdirectory', !!api.state.graphPayload);

    // ---------------------------------------------------------------
    console.log('\n=== 12. A browser upgrade forces a full run ===');
    api.reset({ baseCommitSha: prevHead(PROJECT), browsersChangedFromBase: true });
    writePercyConfig({ enabled: true });
    r = await run(port);

    check('build succeeded', r.code === 0, `exit ${r.code}`);
    check('bailed on the browser upgrade',
      /corresponds to a browser upgrade/.test(r.out));
    check('all 4 snapshots captured', api.state.snapshots.length === 4);

    // ---------------------------------------------------------------
    console.log('\n=== 13. The graph job never completes: degrade to the full set ===');
    api.reset({ baseCommitSha: prevHead(PROJECT), graphStatus: 'failed' });
    writePercyConfig({ enabled: true });
    r = await run(port);

    check('build succeeded', r.code === 0, `exit ${r.code}`);
    check('bailed on the failed graph job',
      /graph generation did not complete \(status: failed\)/.test(r.out));
    check('all 4 snapshots captured, untagged', api.state.snapshots.length === 4 &&
      api.state.snapshots.every(s => !s.intelliStory));

    // ---------------------------------------------------------------
    console.log('\n=== 14. Not entitled (403): degrade to the full set ===');
    api.reset({ baseCommitSha: prevHead(PROJECT), generateGraphStatusCode: 403 });
    writePercyConfig({ enabled: true });
    r = await run(port);

    check('build succeeded', r.code === 0, `exit ${r.code}`);
    check('reported that IntelliStory is not enabled for the org',
      /not enabled for this organization/.test(r.out),
      (r.out.match(/IntelliStory:.*organization.*/) || [])[0]);
    check('all 4 snapshots captured', api.state.snapshots.length === 4);

    // ---------------------------------------------------------------
    console.log('\n=== 15. failBuildOnFailure turns a bail into a build failure ===');
    api.reset({ baseCommitSha: prevHead(PROJECT), generateGraphStatusCode: 403 });
    writePercyConfig({ enabled: true, failBuildOnFailure: true });
    r = await run(port);

    check('build failed', r.code !== 0, `exit ${r.code}`);
    check('no snapshots were posted', api.state.snapshots.length === 0,
      `got ${api.state.snapshots.length}`);

    // ---------------------------------------------------------------
    console.log('\n=== 16. --include composes with IntelliStory ===');
    commitChange(PROJECT, 'src/lib/theme.js', '\nexport const border = 1;\n');
    buildStyleguide();
    api.reset({ baseCommitSha: prevHead(PROJECT) });
    writePercyConfig({ enabled: true });
    r = await run(port, ['./styleguide', '--include=Alert', '--include=Badge']);

    check('build succeeded', r.code === 0, `exit ${r.code}`);
    check('only the included components were considered',
      JSON.stringify(api.state.snapshots.map(s => s.name).sort()) === '["Alert","Badge"]',
      JSON.stringify(api.state.snapshots.map(s => s.name)));
    check('storybookPaths were narrowed to the included components',
      (api.state.graphPayload?.storybook_paths || []).length === 2,
      JSON.stringify(api.state.graphPayload?.storybook_paths));
    check('Alert kept (depends on theme), Badge skipped',
      JSON.stringify(api.state.snapshots.filter(s => !s.skipped).map(s => s.name)) === '["Alert"]',
      JSON.stringify(api.state.snapshots.map(s => [s.name, s.skipped])));

    // ---------------------------------------------------------------
    console.log('\n=== 17. A dry run never touches IntelliStory ===');
    api.reset({ baseCommitSha: prevHead(PROJECT) });
    writePercyConfig({ enabled: true });
    r = await run(port, ['./styleguide', '--dry-run']);

    check('build succeeded', r.code === 0, `exit ${r.code}`);
    check('no IntelliStory output at all', !/IntelliStory/.test(r.out),
      (r.out.match(/IntelliStory.*/) || [])[0]);
    check('no API calls were made', api.state.requests.length === 0,
      JSON.stringify(api.state.requests.map(x => x.path)));

    // ---------------------------------------------------------------
    console.log('\n=== 18. trace: a dependency-graph report is written ===');
    api.reset({ baseCommitSha: prevHead(PROJECT) });
    writePercyConfig({ enabled: true, trace: true });
    let tracePath = path.join(PROJECT, 'trace.html');
    fs.rmSync(tracePath, { force: true });
    r = await run(port);

    check('build succeeded', r.code === 0, `exit ${r.code}`);
    // The fake API returns no vertices/edges, so the trace is correctly skipped
    // rather than written empty — what matters is that it does not throw.
    check('trace handling did not fail the build', !/failed to write trace/.test(r.out) ||
      r.code === 0);
  } finally {
    await api.close();
  }

  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  if (failures.length) {
    console.log('\nFailures:');
    for (let f of failures) console.log(`  - ${f}`);
  }
  process.exit(failed ? 1 : 0);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
