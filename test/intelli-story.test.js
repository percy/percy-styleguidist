import fs from 'fs';
import os from 'os';
import path from 'path';
import { IntelliStoryBailError } from '@percy/cli-command';
import {
  DEFAULT_STATS_FILE,
  readGraphIds,
  resolveStatsLocation,
  resolveConfigFile,
  collectGlobalPaths,
  componentImportPath,
  prepareIntelliStory,
  applyIntelliStoryFilter,
  tagComponents,
  intelliStoryOptions,
  reportIntelliStory
} from '../src/intelli-story.js';

// This spec deliberately does not call `setupTest()` — it exercises real path
// and filesystem resolution against real temp directories.
describe('IntelliStory (styleguidist)', () => {
  let tmp;

  function mkLog() {
    return {
      info: jasmine.createSpy('info'),
      warn: jasmine.createSpy('warn'),
      debug: jasmine.createSpy('debug')
    };
  }

  function write(relPath, contents = '') {
    let abs = path.join(tmp, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contents);
    return abs;
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'percy-rsg-is-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // --- resolveStatsLocation ---

  describe('resolveStatsLocation', () => {
    it('finds a bare filename directly in the build directory', () => {
      let build = path.join(tmp, 'styleguide');
      write('styleguide/enriched-stats.json', '{}');

      expect(resolveStatsLocation(build, undefined)).toEqual({
        dir: build, file: DEFAULT_STATS_FILE, found: true
      });
    });

    it('finds a bare filename in the build/ subdirectory webpack writes to', () => {
      let build = path.join(tmp, 'styleguide');
      write('styleguide/build/enriched-stats.json', '{}');

      expect(resolveStatsLocation(build, 'enriched-stats.json')).toEqual({
        dir: path.join(build, 'build'), file: 'enriched-stats.json', found: true
      });
    });

    it('prefers the build directory itself over its build/ subdirectory', () => {
      let build = path.join(tmp, 'styleguide');
      write('styleguide/enriched-stats.json', '{}');
      write('styleguide/build/enriched-stats.json', '{}');

      expect(resolveStatsLocation(build, undefined).dir).toEqual(build);
    });

    it('reports the build directory when the stats file is missing', () => {
      let build = path.join(tmp, 'styleguide');
      fs.mkdirSync(build);

      expect(resolveStatsLocation(build, undefined)).toEqual({
        dir: build, file: DEFAULT_STATS_FILE, found: false
      });
    });

    it('resolves a relative path with directories against the invocation directory', () => {
      write('out/deep/stats.json', '{}');

      expect(resolveStatsLocation(null, 'out/deep/stats.json', tmp)).toEqual({
        dir: path.join(tmp, 'out', 'deep'), file: 'stats.json', found: true
      });
    });

    it('resolves an absolute stats path', () => {
      let abs = write('elsewhere/stats.json', '{}');

      expect(resolveStatsLocation(null, abs, tmp)).toEqual({
        dir: path.dirname(abs), file: 'stats.json', found: true
      });
    });

    it('reports not-found for a path with directories that does not exist', () => {
      expect(resolveStatsLocation(null, 'out/nope.json', tmp).found).toBe(false);
    });

    it('has nowhere to look without a build directory or an explicit path', () => {
      expect(resolveStatsLocation(null, undefined, tmp)).toEqual({
        dir: null, file: DEFAULT_STATS_FILE, found: false
      });
    });
  });

  // --- resolveConfigFile ---

  describe('resolveConfigFile', () => {
    it('prefers an explicit --config flag', () => {
      expect(resolveConfigFile({ configDir: tmp }, 'custom/sg.config.js', tmp))
        .toEqual(path.join(tmp, 'custom', 'sg.config.js'));
    });

    it('discovers the conventional config file in the RSG config directory', () => {
      let cfg = write('styleguide.config.cjs', 'module.exports = {}');
      expect(resolveConfigFile({ configDir: tmp })).toEqual(cfg);
    });

    it('returns null when no conventional config file exists', () => {
      expect(resolveConfigFile({ configDir: tmp })).toBeNull();
    });

    it('returns null without a config directory', () => {
      expect(resolveConfigFile(null)).toBeNull();
      expect(resolveConfigFile({})).toBeNull();
    });
  });

  // --- collectGlobalPaths ---

  describe('collectGlobalPaths', () => {
    it('returns nothing without an RSG config', () => {
      expect(collectGlobalPaths(null)).toEqual([]);
      expect(collectGlobalPaths(undefined, [{ metadataPath: null }])).toEqual([]);
    });

    it('collects globally required files but skips bare package specifiers', () => {
      let global = write('src/global.css', 'body{}');

      let result = collectGlobalPaths({
        configDir: tmp,
        require: ['src/global.css', 'todomvc-app-css/index.css']
      });

      expect(result).toEqual([global]);
    });

    it('collects styles, theme and a string template', () => {
      let styles = write('styles.js', '');
      let theme = write('theme.js', '');
      let template = write('tpl.html', '');

      let result = collectGlobalPaths({ configDir: tmp, styles, theme, template });

      expect(result).toEqual(jasmine.arrayContaining([styles, theme, template]));
      expect(result.length).toBe(3);
    });

    it('ignores a template given as an object', () => {
      expect(collectGlobalPaths({ configDir: tmp, template: { head: {} } })).toEqual([]);
    });

    it('collects styleguideComponents overrides', () => {
      let wrapper = write('styleguide/Wrapper.js', '');

      let result = collectGlobalPaths({
        configDir: tmp,
        styleguideComponents: { Wrapper: 'styleguide/Wrapper.js' }
      });

      expect(result).toEqual([wrapper]);
    });

    it('collects an assets directory as a recursive glob', () => {
      fs.mkdirSync(path.join(tmp, 'assets'));

      let result = collectGlobalPaths({ configDir: tmp, assetsDir: 'assets' });

      expect(result).toEqual([`${path.join(tmp, 'assets').split(path.sep).join('/')}/**`]);
    });

    it('collects multiple assets directories and skips non-strings', () => {
      fs.mkdirSync(path.join(tmp, 'a'));
      fs.mkdirSync(path.join(tmp, 'b'));

      let result = collectGlobalPaths({ configDir: tmp, assetsDir: ['a', '', 'b', 7, 'missing'] });

      expect(result.length).toBe(2);
      expect(result.every(p => p.endsWith('/**'))).toBe(true);
    });

    it('does not collect a directory where a file is expected', () => {
      fs.mkdirSync(path.join(tmp, 'styles'));
      expect(collectGlobalPaths({ configDir: tmp, styles: 'styles' })).toEqual([]);
    });

    it('collects Percy JSON sidecars from the discovered components', () => {
      let sidecar = write('src/Button/Button.json', '{}');

      let result = collectGlobalPaths({ configDir: tmp }, [
        { metadataPath: sidecar },
        { metadataPath: null },
        {}
      ]);

      expect(result).toEqual([sidecar]);
    });

    it('collects examples markdown the graph cannot trace', () => {
      let md = '/repo/src/Button/Button.md';
      expect(collectGlobalPaths({ configDir: tmp }, [{ examplesFile: md }], new Set()))
        .toEqual([md]);
    });

    it('leaves traceable examples markdown out of the bail set', () => {
      let md = '/repo/src/Button/Button.md';
      expect(collectGlobalPaths({ configDir: tmp }, [{ examplesFile: md }], new Set([md])))
        .toEqual([]);
    });

    it('deduplicates', () => {
      let global = write('src/global.css', '');
      let result = collectGlobalPaths({
        configDir: tmp,
        require: ['src/global.css', './src/global.css'],
        styles: 'src/global.css'
      });

      expect(result).toEqual([global]);
    });
  });

  // --- componentImportPath ---

  describe('readGraphIds', () => {
    it('reads the module ids out of the stats file', () => {
      write('sg/enriched-stats.json', JSON.stringify({
        modules: [{ id: '/a/B.js' }, { id: '/a/C.js' }, { id: 7 }, {}]
      }));

      let ids = readGraphIds(path.join(tmp, 'sg'), 'enriched-stats.json');
      expect([...ids].sort()).toEqual(['/a/B.js', '/a/C.js']);
    });

    it('is empty for a missing or malformed stats file', () => {
      expect(readGraphIds(tmp, 'nope.json').size).toBe(0);
      write('sg/bad.json', '{ not json');
      expect(readGraphIds(path.join(tmp, 'sg'), 'bad.json').size).toBe(0);
    });

    it('is empty when the stats file carries no modules', () => {
      write('sg/empty.json', JSON.stringify({ buildId: 'x' }));
      expect(readGraphIds(path.join(tmp, 'sg'), 'empty.json').size).toBe(0);
    });
  });

  describe('componentImportPath', () => {
    let component = {
      examplesFile: '/repo/src/Button/Button.md',
      sourcePath: '/repo/src/Button/Button.js'
    };

    it('anchors on the examples markdown when the graph contains it', () => {
      let ids = new Set(['/repo/src/Button/Button.md']);
      expect(componentImportPath(component, ids)).toEqual('/repo/src/Button/Button.md');
    });

    // The real bundler plugin only emits modules with an ES import/export, and
    // Styleguidist's examples-loader emits CommonJS -- so this is the usual case.
    it('anchors on the component source when the markdown is not a vertex', () => {
      let ids = new Set(['/repo/src/Button/Button.js']);
      expect(componentImportPath(component, ids)).toEqual('/repo/src/Button/Button.js');
    });

    it('anchors on the source when there is no graph to consult', () => {
      expect(componentImportPath(component)).toEqual('/repo/src/Button/Button.js');
      expect(componentImportPath(component, new Set())).toEqual('/repo/src/Button/Button.js');
    });

    it('falls back to the markdown when there is no source path', () => {
      expect(componentImportPath({ examplesFile: '/repo/a/B.md' }, new Set()))
        .toEqual('/repo/a/B.md');
    });

    it('is null when neither is known', () => {
      expect(componentImportPath({}, new Set())).toBeNull();
      expect(componentImportPath(null, new Set())).toBeNull();
    });
  });

  // --- prepareIntelliStory ---

  describe('prepareIntelliStory', () => {
    it('skips with the build directory in the message when the stats file is missing', () => {
      let build = path.join(tmp, 'styleguide');
      fs.mkdirSync(build);

      let { skipReason, intelliStoryConfig } = prepareIntelliStory({
        config: { enabled: true }, buildDir: build, invocationDir: tmp
      });

      expect(intelliStoryConfig).toBeUndefined();
      expect(skipReason).toMatch(/stats file "enriched-stats\.json" not found in/);
      expect(skipReason).toContain(build);
    });

    it('skips with actionable advice when there is nowhere to look', () => {
      let { skipReason } = prepareIntelliStory({ config: { enabled: true }, invocationDir: tmp });

      expect(skipReason).toMatch(/could not be located/);
      expect(skipReason).toMatch(/percy styleguidist \.\/styleguide/);
      expect(skipReason).toMatch(/statsFile/);
    });

    it('reads the graph and anchors components on paths it contains', () => {
      let md = write('src/Button/Button.md', '');
      write('styleguide/enriched-stats.json', JSON.stringify({ modules: [{ id: md }] }));

      let prepared = prepareIntelliStory({
        config: { enabled: true },
        buildDir: path.join(tmp, 'styleguide'),
        rsgConfig: { configDir: tmp },
        components: [{ examplesFile: md, sourcePath: write('src/Button/Button.js', '') }],
        invocationDir: tmp
      });

      // In the graph, so it is traceable: anchor there, and do not bail on it.
      expect(prepared.graphIds.has(md)).toBe(true);
      expect(prepared.globalPaths).toEqual([]);
    });

    it('bails on examples markdown the graph does not contain', () => {
      let md = write('src/Button/Button.md', '');
      write('styleguide/enriched-stats.json', JSON.stringify({ modules: [] }));

      let prepared = prepareIntelliStory({
        config: { enabled: true },
        buildDir: path.join(tmp, 'styleguide'),
        rsgConfig: { configDir: tmp },
        components: [{ examplesFile: md }],
        invocationDir: tmp
      });

      expect(prepared.globalPaths).toEqual([md]);
      expect(prepared.intelliStoryConfig.bailOnChanges).toEqual([md]);
    });

    it('builds the config, resolving the stats directory and the config file', () => {
      write('styleguide/build/enriched-stats.json', '{}');
      let configFile = write('styleguide.config.js', '');
      let sidecar = write('src/Button/Button.json', '{}');
      let globalCss = write('src/global.css', '');

      let prepared = prepareIntelliStory({
        config: { enabled: true, baseline: 'main', bailOnChanges: ['docs/**'] },
        buildDir: path.join(tmp, 'styleguide'),
        rsgConfig: { configDir: tmp, require: ['src/global.css'] },
        components: [{ metadataPath: sidecar }],
        invocationDir: tmp
      });

      expect(prepared.graphIds instanceof Set).toBe(true);

      expect(prepared.statsDir).toEqual(path.join(tmp, 'styleguide', 'build'));
      expect(prepared.intelliStoryConfig).toEqual(jasmine.objectContaining({
        enabled: true,
        baseline: 'main',
        statsFile: 'enriched-stats.json',
        configDir: configFile
      }));
      // User patterns first, then the Styleguidist globals.
      expect(prepared.intelliStoryConfig.bailOnChanges).toEqual(['docs/**', globalCss, sidecar]);
      expect(prepared.globalPaths).toEqual([globalCss, sidecar]);
    });

    it('honors an explicit configFile over the discovered one', () => {
      write('styleguide/enriched-stats.json', '{}');
      write('styleguide.config.js', '');

      let prepared = prepareIntelliStory({
        config: { enabled: true, configFile: 'config/sg.js' },
        buildDir: path.join(tmp, 'styleguide'),
        rsgConfig: { configDir: tmp },
        invocationDir: tmp
      });

      expect(prepared.intelliStoryConfig.configDir).toEqual(path.join(tmp, 'config', 'sg.js'));
    });

    it('leaves configDir undefined when no config file can be found', () => {
      write('styleguide/enriched-stats.json', '{}');

      let prepared = prepareIntelliStory({
        config: { enabled: true },
        buildDir: path.join(tmp, 'styleguide'),
        rsgConfig: { configDir: tmp },
        invocationDir: tmp
      });

      expect(prepared.intelliStoryConfig.configDir).toBeUndefined();
    });
  });

  // --- applyIntelliStoryFilter ---

  describe('applyIntelliStoryFilter', () => {
    let percy, log, snapshots, statsDir;

    beforeEach(() => {
      percy = { client: {} };
      log = mkLog();
      snapshots = [{ name: 'A', importPath: '/repo/a.md' }, { name: 'B', importPath: '/repo/b.md' }];
      statsDir = './styleguide';
    });

    it('returns the full set unchanged when IntelliStory is disabled', async () => {
      let apply = jasmine.createSpy('apply');
      expect(await applyIntelliStoryFilter(percy, snapshots, { enabled: false }, statsDir, log, apply))
        .toBe(snapshots);
      expect(apply).not.toHaveBeenCalled();
    });

    it('returns the full set unchanged when there is no IntelliStory config', async () => {
      let apply = jasmine.createSpy('apply');
      expect(await applyIntelliStoryFilter(percy, snapshots, undefined, statsDir, log, apply))
        .toBe(snapshots);
      expect(apply).not.toHaveBeenCalled();
    });

    it('returns the tagged set on success', async () => {
      let tagged = [{ ...snapshots[0], intelliStory: true }];
      let config = { enabled: true, baseline: 'main' };
      let apply = jasmine.createSpy('apply').and.resolveTo(tagged);

      expect(await applyIntelliStoryFilter(percy, snapshots, config, statsDir, log, apply)).toBe(tagged);
      expect(apply).toHaveBeenCalledWith(percy, snapshots, config, statsDir);
      expect(log.info).not.toHaveBeenCalled();
      expect(log.warn).not.toHaveBeenCalled();
    });

    it('logs a bail at info level and falls back to the full set', async () => {
      let apply = () => Promise.reject(new IntelliStoryBailError('nothing changed'));

      expect(await applyIntelliStoryFilter(percy, snapshots, { enabled: true }, statsDir, log, apply))
        .toBe(snapshots);
      expect(log.info).toHaveBeenCalledWith('nothing changed');
      expect(log.warn).not.toHaveBeenCalled();
    });

    it('warns and falls back to the full set on a generic error', async () => {
      let apply = () => Promise.reject(new Error('boom'));

      expect(await applyIntelliStoryFilter(percy, snapshots, { enabled: true }, statsDir, log, apply))
        .toBe(snapshots);
      expect(log.warn).toHaveBeenCalledWith('IntelliStory failed (boom); running full snapshot set');
      expect(log.info).not.toHaveBeenCalled();
    });

    it('re-throws a generic error when failBuildOnFailure is set', async () => {
      let err = new Error('boom');
      let config = { enabled: true, failBuildOnFailure: true };

      await expectAsync(
        applyIntelliStoryFilter(percy, snapshots, config, statsDir, log, () => Promise.reject(err))
      ).toBeRejectedWith(err);
      expect(log.warn).toHaveBeenCalled();
    });

    it('re-throws a bail when failBuildOnFailure is set', async () => {
      let err = new IntelliStoryBailError('nothing changed');
      let config = { enabled: true, failBuildOnFailure: true };

      await expectAsync(
        applyIntelliStoryFilter(percy, snapshots, config, statsDir, log, () => Promise.reject(err))
      ).toBeRejectedWith(err);
      expect(log.info).toHaveBeenCalledWith('nothing changed');
    });
  });

  // --- tagComponents ---

  describe('tagComponents', () => {
    let percy, log, components;

    beforeEach(() => {
      percy = { client: {} };
      log = mkLog();
      components = [
        { name: 'Button', examplesFile: '/repo/src/Button/Button.md', sourcePath: '/repo/src/Button/Button.js' },
        { name: 'Input', examplesFile: null, sourcePath: '/repo/src/Input/Input.js' },
        { name: 'Ghost', examplesFile: null, sourcePath: null }
      ];
    });

    it('sends one pseudo-snapshot per component, anchored on its examples file', async () => {
      // Mirrors what applyIntelliStory does: a snapshot is only taggable when
      // its source path resolved.
      let apply = jasmine.createSpy('apply').and.callFake((p, snapshots) => (
        Promise.resolve(snapshots.map(s => ({
          ...s, intelliStory: !!s.importPath, storybookPath: s.importPath ?? undefined
        })))
      ));

      let result = await tagComponents(percy, components, {
        intelliStoryConfig: { enabled: true },
        statsDir: './styleguide',
        graphIds: new Set(['/repo/src/Button/Button.md']),
        log,
        apply
      });

      // Button's markdown is a vertex so it anchors there; Input has none.
      expect(apply.calls.argsFor(0)[1]).toEqual([
        { name: 'Button', importPath: '/repo/src/Button/Button.md' },
        { name: 'Input', importPath: '/repo/src/Input/Input.js' },
        { name: 'Ghost', importPath: null }
      ]);
      expect(result.map(c => c.name)).toEqual(['Button', 'Input', 'Ghost']);
      expect(result.map(c => c.intelliStory)).toEqual([true, true, false]);
      expect(result.map(c => c.storybookPath)).toEqual([
        '/repo/src/Button/Button.md', '/repo/src/Input/Input.js', undefined
      ]);
    });

    it('leaves a component with no resolvable source path untagged but reported', async () => {
      let apply = () => Promise.resolve([
        { intelliStory: true, storybookPath: 'src/Button/Button.md' },
        { intelliStory: true, storybookPath: 'src/Input/Input.js' },
        { intelliStory: false, storybookPath: undefined }
      ]);

      let result = await tagComponents(percy, components, {
        intelliStoryConfig: { enabled: true }, statsDir: './styleguide', log, apply
      });

      expect(result[0]).toEqual(jasmine.objectContaining({ intelliStory: true, storybookPath: 'src/Button/Button.md' }));
      expect(result[2]).toEqual(jasmine.objectContaining({ intelliStory: false }));
      expect(result[2].storybookPath).toBeUndefined();
      expect(log.debug).toHaveBeenCalledWith(
        'IntelliStory: no source path for "Ghost"; it will always be captured');
    });

    it('treats a short response as untagged rather than mis-assigning tags', async () => {
      let apply = () => Promise.resolve([{ intelliStory: true, storybookPath: 'src/Button/Button.md' }]);

      let result = await tagComponents(percy, components, {
        intelliStoryConfig: { enabled: true }, statsDir: './styleguide', log, apply
      });

      expect(result[0].intelliStory).toBe(true);
      expect(result[1].intelliStory).toBe(false);
      expect(result[2].intelliStory).toBe(false);
    });

    it('returns the components untouched when IntelliStory bails', async () => {
      let apply = () => Promise.reject(new IntelliStoryBailError('nothing changed'));

      let result = await tagComponents(percy, components, {
        intelliStoryConfig: { enabled: true }, statsDir: './styleguide', log, apply
      });

      expect(result).toBe(components);
      expect(result.every(c => c.intelliStory === undefined)).toBe(true);
      expect(log.info).toHaveBeenCalledWith('nothing changed');
    });

    it('propagates a failure when failBuildOnFailure is set', async () => {
      let apply = () => Promise.reject(new Error('boom'));

      await expectAsync(tagComponents(percy, components, {
        intelliStoryConfig: { enabled: true, failBuildOnFailure: true },
        statsDir: './styleguide',
        log,
        apply
      })).toBeRejectedWithError('boom');
    });
  });

  // --- intelliStoryOptions ---

  describe('intelliStoryOptions', () => {
    it('is empty when IntelliStory did not run', () => {
      expect(intelliStoryOptions({ name: 'Button' })).toEqual({});
      expect(intelliStoryOptions(null)).toEqual({});
    });

    it('reports an untagged component so the tally stays complete', () => {
      expect(intelliStoryOptions({ intelliStory: false })).toEqual({ intelliStory: false });
    });

    it('carries the source path for a tagged component', () => {
      expect(intelliStoryOptions({ intelliStory: true, storybookPath: 'src/Button/Button.md' }))
        .toEqual({ intelliStory: true, storybookPath: 'src/Button/Button.md' });
    });
  });

  // --- reportIntelliStory ---

  describe('reportIntelliStory', () => {
    let log;

    beforeEach(() => { log = mkLog(); });

    it('does nothing without a build', async () => {
      let write = jasmine.createSpy('write');
      await reportIntelliStory({ build: undefined, client: {} }, {}, log, write);
      expect(write).not.toHaveBeenCalled();
      expect(log.info).not.toHaveBeenCalled();
    });

    it('summarizes the server-side selection outcome', async () => {
      let percy = { build: { id: '123' }, client: { intelliStoryStats: { kept: 2, skipped: 3 } } };

      await reportIntelliStory(percy, { trace: false }, log, () => Promise.resolve());

      expect(log.info).toHaveBeenCalledWith(
        'IntelliStory: filtered out 3 of 5 snapshots with no detected changes; the remaining 2 were processed.');
    });

    it('writes the trace and skips the summary when nothing was tallied', async () => {
      let percy = { build: { id: '123' }, client: {} };
      let config = { trace: true };
      let write = jasmine.createSpy('write').and.resolveTo();

      await reportIntelliStory(percy, config, log, write);

      expect(log.info).not.toHaveBeenCalled();
      expect(write).toHaveBeenCalledWith(percy, config, log);
    });

    it('defaults to the real trace writer, which is a no-op when trace is off', async () => {
      let percy = { build: { id: '123' }, client: {} };
      await expectAsync(reportIntelliStory(percy, { trace: false }, log)).toBeResolved();
      expect(log.debug).not.toHaveBeenCalled();
    });

    it('never lets a trace failure fail the build', async () => {
      let percy = { build: { id: '123' }, client: {} };

      await expectAsync(reportIntelliStory(percy, { trace: true }, log,
        () => Promise.reject(new Error('disk full')))).toBeResolved();

      expect(log.debug).toHaveBeenCalledWith(
        'IntelliStory: failed to write trace after finalize: disk full');
    });
  });
});
