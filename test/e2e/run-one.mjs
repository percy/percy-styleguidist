// Runs one `percy styleguidist` invocation in its own process, against the fake
// Percy API. Isolated per scenario so nothing (env, module state, percy config,
// logger buffers) leaks between them.
//
// usage: node run-one.mjs <projectDir> <arg...>
const [projectDir, ...argv] = process.argv.slice(2);

process.chdir(projectDir);

// @percy/client reads the API URL at module load, so this has to be set before
// the SDK (and its transitive @percy/* imports) are loaded. It is set by the
// parent via env; asserted here so a missing one fails loudly rather than
// silently talking to percy.io.
if (!process.env.PERCY_CLIENT_API_URL) {
  console.error('PERCY_CLIENT_API_URL is not set');
  process.exit(2);
}

let { styleguidist } = await import('../../src/index.js');

try {
  await styleguidist(argv);
  process.exit(0);
} catch (e) {
  console.error(`COMMAND FAILED: ${e.message}`);
  process.exit(e.exitCode ?? 1);
}
