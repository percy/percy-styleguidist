// A stand-in for the Percy API, just complete enough to run a real build end to
// end. The IntelliStory endpoints are not stubs: `generate-graph` runs the same
// reachability the real service runs (a storybookPath is affected when anything
// reachable from it through the module graph changed), and the snapshot endpoint
// reports `skipped-via-smartsnap` for the ones that selection rules out. That is
// what makes the assertions in run.mjs meaningful.
import http from 'http';

const toPosix = p => String(p).split('\\').join('/');

export function createApi({ log = () => {} } = {}) {
  let state = {
    requests: [],
    build: null,
    baseCommitSha: null,
    browsersChangedFromBase: false,
    graphPayload: null,
    affectedStorybookPaths: null,
    snapshots: [],
    skipped: [],
    graphStatus: 'done',
    generateGraphStatusCode: 201
  };

  // Mirrors the server-side selection: walk the module graph out from each
  // storybookPath and keep it when any file it can reach has changed.
  function selectAffected({ files, modules, storybook_paths: paths, affected_nodes: affected }) {
    let index = new Map((files || []).map((f, i) => [toPosix(f), i]));
    let changed = new Set((affected || []).map(toPosix));

    let edges = new Map();
    for (let m of modules || []) {
      if (typeof m.id !== 'number') continue;
      let out = edges.get(m.id) || [];
      for (let group of [m.imports, m.passThroughExports]) {
        for (let e of group || []) {
          if (e && e.type === 'src' && typeof e.source === 'number') out.push(e.source);
        }
      }
      edges.set(m.id, out);
    }

    let affectedPaths = new Set();
    for (let raw of paths || []) {
      let start = index.get(toPosix(raw));
      if (start === undefined) {
        // Not in the graph at all — the real service cannot prove it unaffected,
        // so it stays in the run.
        affectedPaths.add(toPosix(raw));
        continue;
      }

      let seen = new Set([start]);
      let stack = [start];
      let hit = false;
      while (stack.length) {
        let node = stack.pop();
        if (changed.has(toPosix(files[node]))) { hit = true; break; }
        for (let next of edges.get(node) || []) {
          if (!seen.has(next)) { seen.add(next); stack.push(next); }
        }
      }
      if (hit) affectedPaths.add(toPosix(raw));
    }

    return affectedPaths;
  }

  const server = http.createServer((req, res) => {
    let chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      let raw = Buffer.concat(chunks);
      let body;
      try { body = JSON.parse(raw.toString('utf8')); } catch { body = null; }

      let path = req.url.replace('/api/v1', '');
      state.requests.push({ method: req.method, path, body });
      log(`${req.method} ${path}`);

      const send = (code, data) => {
        let payload = typeof data === 'string' ? data : JSON.stringify(data ?? {});
        res.writeHead(code, {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload)
        });
        res.end(payload);
      };

      // --- builds ---
      if (req.method === 'POST' && path === '/builds') {
        state.build = { id: '123' };
        return send(201, {
          data: {
            id: '123',
            attributes: { 'build-number': 1, 'web-url': 'http://localhost/percy/123' }
          }
        });
      }

      if (req.method === 'POST' && /^\/builds\/\d+\/finalize/.test(path)) {
        return send(200, { success: true });
      }

      // --- IntelliStory ---
      if (path.startsWith('/intelli_story/snapshot-name-to-commit')) {
        return send(200, {
          base_build_commit_sha: state.baseCommitSha,
          browsers_changed_from_base: state.browsersChangedFromBase
        });
      }

      if (req.method === 'POST' && path === '/intelli_story/generate-graph') {
        if (state.generateGraphStatusCode !== 201) {
          return send(state.generateGraphStatusCode, { errors: [{ detail: 'not entitled' }] });
        }
        state.graphPayload = body;
        state.affectedStorybookPaths = selectAffected(body);
        log(`  graph: ${body.storybook_paths?.length} storybookPaths, ` +
            `${body.affected_nodes?.length} affected nodes, ` +
            `${body.modules?.length} modules -> ` +
            `${state.affectedStorybookPaths.size} affected`);
        return send(201, { data: { id: 'graph-1' } });
      }

      if (path.startsWith('/job_status') && path.includes('intelli_story_graph')) {
        return send(200, { status: state.graphStatus, data: {} });
      }

      if (path.startsWith('/job_status')) {
        return send(200, { 4567: { status: true, nextPoll: 8, error: null } });
      }

      // --- snapshots ---
      if (req.method === 'POST' && /^\/builds\/\d+\/snapshots$/.test(path)) {
        let attrs = body?.data?.attributes || {};
        let resources = body?.data?.relationships?.resources?.data || [];
        let id = String(4567 + state.snapshots.length);

        let intelliStory = attrs['intelli-story'];
        let storybookPath = attrs['storybook-path'];
        let skipped = !!intelliStory && !!state.affectedStorybookPaths &&
          !state.affectedStorybookPaths.has(toPosix(storybookPath));

        state.snapshots.push({ id, name: attrs.name, intelliStory, storybookPath, skipped });
        if (skipped) state.skipped.push(attrs.name);

        return send(201, {
          data: {
            id,
            attributes: { ...attrs, 'skipped-via-smartsnap': skipped },
            relationships: {
              'missing-resources': { data: skipped ? [] : resources.map(({ id }) => ({ id })) }
            }
          }
        });
      }

      if (req.method === 'POST' && /^\/snapshots\/\d+\/finalize/.test(path)) {
        return send(200, { success: true });
      }

      if (req.method === 'POST' && /^\/builds\/\d+\/resources/.test(path)) {
        return send(200, { success: true });
      }

      // Everything else the CLI happens to ask for.
      if (path.startsWith('/discovery/device-details')) return send(200, { data: [] });
      if (path.startsWith('/project-domain-configs')) {
        return send(200, { data: { id: 'dc', type: 'projects', attributes: { 'allowed-domains': [] } } });
      }
      if (path === '/logs') return send(200, 'sha');

      log(`  (unhandled) ${req.method} ${path}`);
      return send(200, {});
    });
  });

  return {
    state,
    reset(overrides = {}) {
      state.requests = [];
      state.build = null;
      state.graphPayload = null;
      state.affectedStorybookPaths = null;
      state.snapshots = [];
      state.skipped = [];
      state.graphStatus = 'done';
      state.generateGraphStatusCode = 201;
      state.browsersChangedFromBase = false;
      Object.assign(state, overrides);
    },
    listen() {
      return new Promise(resolve => {
        server.listen(0, '127.0.0.1', () => resolve(server.address().port));
      });
    },
    close() {
      return new Promise(resolve => server.close(resolve));
    }
  };
}
