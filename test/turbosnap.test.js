import {
  extractModuleEdges,
  captureWebpackStats,
  getTurboSnapFilter
} from '../src/turbosnap.js';

// Helper: create a minimal log stub that records calls per level.
function makeLog() {
  let log = {
    calls: { debug: [], info: [], warn: [], error: [] }
  };
  for (let level of ['debug', 'info', 'warn', 'error']) {
    log[level] = (...args) => log.calls[level].push(args.join(' '));
  }
  return log;
}

// Helper: build the `deps` override object for getTurboSnapFilter.
function makeDeps({ execFileSync, rsgBuild, httpPostJson } = {}) {
  return {
    execFileSync: execFileSync || (() => ''),
    rsgBuild: rsgBuild || ((_cfg, cb) => cb(null, {
      hasErrors: () => false,
      toJson: () => ({ modules: [] })
    })),
    httpPostJson: httpPostJson || (async () => ({
      data: { attributes: { 'affected-file-paths': [], bail: false } }
    }))
  };
}

const VALID_SHA = 'a'.repeat(40);

describe('turbosnap', () => {
  describe('extractModuleEdges', () => {
    it('handles webpack 4 shape (moduleName)', () => {
      let edges = extractModuleEdges({
        modules: [{
          name: './src/Button.js',
          identifier: '/abs/Button.js',
          reasons: [
            { moduleName: './src/App.js' },
            { moduleName: './src/Home.js' }
          ]
        }]
      });
      expect(edges.length).toBe(1);
      expect(edges[0].name).toBe('./src/Button.js');
      expect(edges[0].reasons.length).toBe(2);
      expect(edges[0].reasons[0].moduleName).toBe('./src/App.js');
    });

    it('handles webpack 5 shape (resolvedModule)', () => {
      let edges = extractModuleEdges({
        modules: [{
          name: './src/Input.js',
          identifier: '/abs/Input.js',
          reasons: [{ resolvedModule: './src/Form.js' }]
        }]
      });
      expect(edges[0].reasons[0].resolvedModule).toBe('./src/Form.js');
    });

    it('handles module field alongside moduleName/resolvedModule', () => {
      let edges = extractModuleEdges({
        modules: [{
          name: 'x.js',
          reasons: [{ module: './a.js' }, { moduleName: './b.js', resolvedModule: './b.js' }]
        }]
      });
      expect(edges[0].reasons.length).toBe(2);
    });

    it('filters out reasons with no moduleName/resolvedModule/module', () => {
      let edges = extractModuleEdges({
        modules: [{
          name: 'x.js',
          reasons: [{ moduleName: './a.js' }, { type: 'cjs require' }, {}]
        }]
      });
      expect(edges[0].reasons.length).toBe(1);
      expect(edges[0].reasons[0].moduleName).toBe('./a.js');
    });

    it('returns empty array when statsJson has no modules', () => {
      expect(extractModuleEdges({})).toEqual([]);
      expect(extractModuleEdges({ modules: null })).toEqual([]);
    });

    it('handles modules without reasons', () => {
      let edges = extractModuleEdges({ modules: [{ name: 'x.js' }] });
      expect(edges[0].reasons).toEqual([]);
    });
  });

  describe('captureWebpackStats', () => {
    it('resolves with stats.toJson() output on success', async () => {
      let fakeRsgBuild = (_cfg, cb) => cb(null, {
        hasErrors: () => false,
        toJson: () => ({ modules: [{ name: 'a.js' }] })
      });
      let result = await captureWebpackStats({}, fakeRsgBuild);
      expect(result.modules.length).toBe(1);
    });

    it('rejects when rsgBuild yields err', async () => {
      let fakeRsgBuild = (_cfg, cb) => cb(new Error('bundler fail'));
      await expectAsync(captureWebpackStats({}, fakeRsgBuild))
        .toBeRejectedWithError('bundler fail');
    });

    it('rejects when stats is null', async () => {
      let fakeRsgBuild = (_cfg, cb) => cb(null, null);
      await expectAsync(captureWebpackStats({}, fakeRsgBuild))
        .toBeRejectedWithError(/no stats/);
    });

    it('rejects when stats has webpack errors', async () => {
      let fakeRsgBuild = (_cfg, cb) => cb(null, {
        hasErrors: () => true,
        toJson: () => ({ errors: ['Module not found: X'] })
      });
      await expectAsync(captureWebpackStats({}, fakeRsgBuild))
        .toBeRejectedWithError(/Module not found/);
    });

    it('rejects when toJson throws', async () => {
      let fakeRsgBuild = (_cfg, cb) => cb(null, {
        hasErrors: () => false,
        toJson: () => { throw new Error('toJson boom'); }
      });
      await expectAsync(captureWebpackStats({}, fakeRsgBuild))
        .toBeRejectedWithError(/toJson boom/);
    });

    it('rejects when rsgBuild itself throws synchronously', async () => {
      let fakeRsgBuild = () => { throw new Error('sync fail'); };
      await expectAsync(captureWebpackStats({}, fakeRsgBuild))
        .toBeRejectedWithError('sync fail');
    });
  });

  describe('getTurboSnapFilter', () => {
    let log;
    let percy;
    let components;

    beforeEach(() => {
      log = makeLog();
      // percy.build.id is needed now that getTurboSnapFilter prefers
      // percy.client.turbosnap() (in-process) over the HTTP hop.
      // Tests that exercise the HTTP path set percy.client = null to
      // force the fallback.
      percy = {
        port: 5338,
        build: { id: 'test-build-1', baselineCommitSha: VALID_SHA },
        client: null
      };
      components = [
        { name: 'Button', filepath: 'src/components/Button/Button.js' },
        { name: 'Input', filepath: 'src/components/Input/Input.js' },
        { name: 'Card', filepath: 'src/components/Card/Card.js' }
      ];
    });

    it('returns null + debug when no baseline SHA', async () => {
      percy.build.baselineCommitSha = null;
      let result = await getTurboSnapFilter({ percy, rsgConfig: {}, components, log }, makeDeps());
      expect(result).toBeNull();
      expect(log.calls.debug.join('\n')).toMatch(/No baseline commit available/);
    });

    it('returns null + warn when baseline SHA has invalid format', async () => {
      percy.build.baselineCommitSha = 'not-a-valid-sha';
      let result = await getTurboSnapFilter({ percy, rsgConfig: {}, components, log }, makeDeps());
      expect(result).toBeNull();
      expect(log.calls.warn.join('\n')).toMatch(/Invalid baseline SHA format/);
    });

    it('returns null + debug when git diff fails', async () => {
      let deps = makeDeps({
        execFileSync: () => { throw new Error('not a git repo'); }
      });
      let result = await getTurboSnapFilter({ percy, rsgConfig: {}, components, log }, deps);
      expect(result).toBeNull();
      expect(log.calls.debug.join('\n')).toMatch(/git diff failed/);
    });

    it('skips stats capture on empty diff and forwards the request for server-side handling', async () => {
      // Empty git diff no longer short-circuits locally. Server decides what
      // to do (carry-forward or bail); SDK sees an "0 affected" response and
      // snapshots nothing. We assert: no RSG rebuild, no stats sent, API called.
      let rsgBuildCalled = false;
      let posted;
      let deps = makeDeps({
        execFileSync: () => '',
        rsgBuild: (_cfg, cb) => { rsgBuildCalled = true; cb(null, {}); },
        httpPostJson: async (_url, body) => {
          posted = body;
          return { data: { attributes: { 'affected-file-paths': [], bail: false } } };
        }
      });

      let result = await getTurboSnapFilter({ percy, rsgConfig: {}, components, log }, deps);

      expect(rsgBuildCalled).toBe(false);
      expect(posted.changedFiles).toEqual([]);
      expect(posted.webpackStatsGz).toBeNull();
      // "0 components affected" → empty Set (not null), so caller skips capture.
      expect(result instanceof Set).toBe(true);
      expect(result.size).toBe(0);
    });

    it('returns null + debug when RSG build() returns err', async () => {
      let deps = makeDeps({
        execFileSync: () => 'src/components/Button/Button.js\n',
        rsgBuild: (_cfg, cb) => cb(new Error('webpack crashed'))
      });
      let result = await getTurboSnapFilter({ percy, rsgConfig: {}, components, log }, deps);
      expect(result).toBeNull();
      expect(log.calls.debug.join('\n')).toMatch(/webpack stats capture failed.*webpack crashed/);
    });

    it('returns null + debug when RSG build has webpack errors', async () => {
      let deps = makeDeps({
        execFileSync: () => 'src/components/Button/Button.js\n',
        rsgBuild: (_cfg, cb) => cb(null, {
          hasErrors: () => true,
          toJson: () => ({ errors: ['Cannot resolve'] })
        })
      });
      let result = await getTurboSnapFilter({ percy, rsgConfig: {}, components, log }, deps);
      expect(result).toBeNull();
      expect(log.calls.debug.join('\n')).toMatch(/webpack stats capture failed/);
    });

    it('returns null + warn when API returns bail: true', async () => {
      let deps = makeDeps({
        execFileSync: () => 'src/components/Button/Button.js\n',
        httpPostJson: async () => ({
          data: { attributes: { bail: true, 'bail-reason': 'feature flag off' } }
        })
      });
      let result = await getTurboSnapFilter({ percy, rsgConfig: {}, components, log }, deps);
      expect(result).toBeNull();
      expect(log.calls.warn.join('\n')).toMatch(/bailed.*feature flag off/);
    });

    it('returns null + warn when HTTP errors', async () => {
      let deps = makeDeps({
        execFileSync: () => 'src/components/Button/Button.js\n',
        httpPostJson: async () => { throw new Error('ECONNREFUSED'); }
      });
      let result = await getTurboSnapFilter({ percy, rsgConfig: {}, components, log }, deps);
      expect(result).toBeNull();
      expect(log.calls.warn.join('\n')).toMatch(/API call failed.*ECONNREFUSED/);
    });

    it('returns null + warn on timeout', async () => {
      let deps = makeDeps({
        execFileSync: () => 'src/components/Button/Button.js\n',
        httpPostJson: async () => { throw new Error('Timeout after 30000ms'); }
      });
      let result = await getTurboSnapFilter({ percy, rsgConfig: {}, components, log }, deps);
      expect(result).toBeNull();
      expect(log.calls.warn.join('\n')).toMatch(/API call failed.*Timeout/);
    });

    it('returns null + warn on non-2xx HTTP (surfaced as error from httpPostJson)', async () => {
      let deps = makeDeps({
        execFileSync: () => 'src/components/Button/Button.js\n',
        httpPostJson: async () => { throw new Error('HTTP 500: server error'); }
      });
      let result = await getTurboSnapFilter({ percy, rsgConfig: {}, components, log }, deps);
      expect(result).toBeNull();
      expect(log.calls.warn.join('\n')).toMatch(/API call failed.*HTTP 500/);
    });

    it('returns empty Set + info when API returns 0 affected components', async () => {
      let deps = makeDeps({
        execFileSync: () => 'README.md\n',
        httpPostJson: async () => ({
          data: { attributes: { 'affected-file-paths': [], bail: false } }
        })
      });
      let result = await getTurboSnapFilter({ percy, rsgConfig: {}, components, log }, deps);
      expect(result instanceof Set).toBe(true);
      expect(result.size).toBe(0);
      expect(log.calls.info.join('\n')).toMatch(/0 components affected/);
    });

    it('returns lowercased Set when API returns affected paths (happy path)', async () => {
      let deps = makeDeps({
        execFileSync: () => 'src/components/Button/Button.js\n',
        httpPostJson: async () => ({
          data: {
            attributes: {
              'affected-file-paths': [
                'src/components/Button/Button.js',
                'src/components/Input/Input.js',
                'src/components/Card/Card.js'
              ],
              bail: false
            }
          }
        })
      });
      // Add 10 components total, expect 3 in the filter
      components = Array.from({ length: 10 }, (_, i) => ({
        name: `Comp${i}`,
        filepath: `src/components/Comp${i}/Comp${i}.js`
      }));
      components.push(
        { name: 'Button', filepath: 'src/components/Button/Button.js' },
        { name: 'Input', filepath: 'src/components/Input/Input.js' },
        { name: 'Card', filepath: 'src/components/Card/Card.js' }
      );
      let result = await getTurboSnapFilter({ percy, rsgConfig: {}, components, log }, deps);
      expect(result instanceof Set).toBe(true);
      expect(result.size).toBe(3);
      expect(result.has('src/components/button/button.js')).toBe(true);
      expect(result.has('src/components/input/input.js')).toBe(true);
      expect(result.has('src/components/card/card.js')).toBe(true);
      expect(log.calls.info.join('\n')).toMatch(/3\/\d+ components affected/);
    });

    it('sends the expected payload to /percy/turbosnap', async () => {
      let captured = null;
      let deps = makeDeps({
        execFileSync: () => 'src/components/Button/Button.js\n',
        rsgBuild: (_cfg, cb) => cb(null, {
          hasErrors: () => false,
          toJson: () => ({ modules: [{ name: './Button.js', reasons: [{ moduleName: './App.js' }] }] })
        }),
        httpPostJson: async (url, body, _opts) => {
          captured = { url, body };
          return { data: { attributes: { 'affected-file-paths': ['src/components/Button/Button.js'] } } };
        }
      });
      await getTurboSnapFilter({ percy, rsgConfig: {}, components, log }, deps);
      expect(captured.url).toBe('http://localhost:5338/percy/turbosnap');
      expect(captured.body.changedFiles).toEqual(['src/components/Button/Button.js']);
      expect(typeof captured.body.webpackStatsGz).toBe('string');
      expect(captured.body.webpackStatsGz.length).toBeGreaterThan(0);
      expect(captured.body.componentFilePaths).toEqual([
        'src/components/Button/Button.js',
        'src/components/Input/Input.js',
        'src/components/Card/Card.js'
      ]);
    });

    it('uses PERCY_SERVER_ADDRESS env var when set', async () => {
      let oldEnv = process.env.PERCY_SERVER_ADDRESS;
      process.env.PERCY_SERVER_ADDRESS = 'http://127.0.0.1:9999';
      try {
        let captured = null;
        let deps = makeDeps({
          execFileSync: () => 'x.js\n',
          httpPostJson: async (url, _body) => {
            captured = url;
            return { data: { attributes: { 'affected-file-paths': [] } } };
          }
        });
        await getTurboSnapFilter({ percy, rsgConfig: {}, components, log }, deps);
        expect(captured).toBe('http://127.0.0.1:9999/percy/turbosnap');
      } finally {
        if (oldEnv === undefined) delete process.env.PERCY_SERVER_ADDRESS;
        else process.env.PERCY_SERVER_ADDRESS = oldEnv;
      }
    });

    it('passes SHA validation for mixed case hex', async () => {
      percy.build.baselineCommitSha = 'AbCdEf'.repeat(6) + 'abcd'; // 40 hex chars, mixed case
      let deps = makeDeps({
        execFileSync: () => 'x.js\n',
        httpPostJson: async () => ({ data: { attributes: { 'affected-file-paths': [] } } })
      });
      let result = await getTurboSnapFilter({ percy, rsgConfig: {}, components, log }, deps);
      expect(result).toBeDefined(); // Not the "invalid format" fallback
      expect(log.calls.warn.find(l => l.match(/Invalid baseline SHA format/))).toBeUndefined();
    });

    it('rejects SHA that is too short', async () => {
      percy.build.baselineCommitSha = 'abc123';
      let result = await getTurboSnapFilter({ percy, rsgConfig: {}, components, log }, makeDeps());
      expect(result).toBeNull();
      expect(log.calls.warn.join('\n')).toMatch(/Invalid baseline SHA format/);
    });

    it('rejects SHA with non-hex characters', async () => {
      percy.build.baselineCommitSha = 'z'.repeat(40);
      let result = await getTurboSnapFilter({ percy, rsgConfig: {}, components, log }, makeDeps());
      expect(result).toBeNull();
    });

    it('handles percy.build undefined gracefully', async () => {
      let result = await getTurboSnapFilter({
        percy: { port: 5338 }, rsgConfig: {}, components, log
      }, makeDeps());
      expect(result).toBeNull();
      expect(log.calls.debug.join('\n')).toMatch(/No baseline commit/);
    });

    it('filters out null filepaths when sending component_file_paths', async () => {
      components = [
        { name: 'Button', filepath: 'src/Button.js' },
        { name: 'Unknown', filepath: null }
      ];
      let captured = null;
      let deps = makeDeps({
        execFileSync: () => 'x.js\n',
        httpPostJson: async (_url, body) => {
          captured = body;
          return { data: { attributes: { 'affected-file-paths': [] } } };
        }
      });
      await getTurboSnapFilter({ percy, rsgConfig: {}, components, log }, deps);
      expect(captured.componentFilePaths).toEqual(['src/Button.js']);
    });
  });
});
