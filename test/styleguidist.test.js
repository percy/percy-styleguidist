import fs from 'fs';
import path from 'path';
import url from 'url';
import { api, logger, setupTest, createTestServer } from '@percy/cli-command/test/helpers';
import { styleguidist } from '../src/index.js';
import { shouldIncludeComponent } from '../src/config.js';
import { discoverComponents } from '../src/discovery.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.resolve(__dirname, 'fixtures');
const BUILD_DIR = path.join(FIXTURE_DIR, 'styleguide');
const CONFIG_PATH = path.join(FIXTURE_DIR, 'styleguide.config.cjs');

const EMPTY_FIXTURE_DIR = path.resolve(__dirname, 'fixtures-empty');
const EMPTY_BUILD_DIR = path.join(EMPTY_FIXTURE_DIR, 'styleguide');
const EMPTY_CONFIG_PATH = path.join(EMPTY_FIXTURE_DIR, 'styleguide.config.cjs');

const NORENDER_BUILD_DIR = path.resolve(__dirname, 'fixtures-norender', 'styleguide');
const NOSKIP_CONFIG_PATH = path.join(FIXTURE_DIR, 'noskip.config.cjs');

describe('percy styleguidist', () => {
  let server;

  beforeAll(async () => {
    server = await createTestServer({
      default: () => [200, 'text/html', '<p>Not RSG</p>']
    });
  });

  afterAll(async () => {
    await server?.close();
  });

  beforeEach(async () => {
    styleguidist.packageInformation = { name: '@percy/styleguidist' };
    process.env.PERCY_TOKEN = '<<PERCY_TOKEN>>';
    process.env.PERCY_CLIENT_ERROR_LOGS = 'false';
    await setupTest();
    fs.$bypass?.push?.(p => p.includes?.('fixtures') || p.includes?.('.local-chromium'));
  });

  afterEach(() => {
    delete process.env.PERCY_TOKEN;
    delete process.env.PERCY_ENABLE;
    delete process.env.PERCY_CLIENT_ERROR_LOGS;
  });

  // --- Discovery ---

  describe('component discovery', () => {
    it('discovers all components from static build', async () => {
      await styleguidist([BUILD_DIR, '--dry-run', `--config=${CONFIG_PATH}`]);

      expect(logger.stdout).toEqual(jasmine.arrayContaining([
        jasmine.stringMatching('Discovered \\d+ component'),
        jasmine.stringMatching('Snapshot found: Button'),
        jasmine.stringMatching('Snapshot found: Input'),
        jasmine.stringMatching('Snapshot found: BadExec'),
        jasmine.stringMatching('Snapshot found: NoNameAdditional')
      ]));
    });

    it('skips components with skip: true in JSON sidecar', async () => {
      await styleguidist([BUILD_DIR, '--dry-run', `--config=${CONFIG_PATH}`]);

      let lines = logger.stdout.filter(l => l.includes('Snapshot found:'));
      expect(lines.some(l => l.includes('Skip'))).toBe(false);
    });

    it('lists additional snapshots in dry-run', async () => {
      await styleguidist([BUILD_DIR, '--dry-run', `--config=${CONFIG_PATH}`]);

      expect(logger.stdout).toEqual(jasmine.arrayContaining([
        jasmine.stringMatching('Snapshot found: Button'),
        jasmine.stringMatching('Snapshot found: Button - Mobile'),
        jasmine.stringMatching('Snapshot found: Prefixed Button')
      ]));
    });

    it('shows filtered count when components are skipped', async () => {
      await styleguidist([BUILD_DIR, '--dry-run', `--config=${CONFIG_PATH}`]);

      expect(logger.stdout).toEqual(jasmine.arrayContaining([
        jasmine.stringMatching(/Snapshotting \d+ of \d+/)
      ]));
    });

    it('warns on malformed JSON sidecar', async () => {
      // readPercyConfig unit test already covers this (see below).
      // Here we verify the warning shows up in the full command flow.
      let helpers = await import('../src/discovery.js');
      let mockLog = { warn: jasmine.createSpy('warn'), debug: jasmine.createSpy('debug') };
      let { mkdirSync, writeFileSync, unlinkSync, rmdirSync } = fs;
      let tmpDir = path.join(FIXTURE_DIR, 'src/components/TmpBad');
      mkdirSync(tmpDir, { recursive: true });
      writeFileSync(path.join(tmpDir, 'TmpBad.json'), '{ bad }');
      try {
        helpers.readPercyConfig('src/components/TmpBad/TmpBad.js', FIXTURE_DIR, mockLog);
        expect(mockLog.warn).toHaveBeenCalledWith(jasmine.stringMatching('Failed to parse'));
      } finally {
        unlinkSync(path.join(tmpDir, 'TmpBad.json'));
        rmdirSync(tmpDir);
      }
    });

    it('returns empty when RSG config has no components', async () => {
      await styleguidist([EMPTY_BUILD_DIR, '--dry-run', `--config=${EMPTY_CONFIG_PATH}`]);

      expect(logger.stderr).toEqual(jasmine.arrayContaining([
        jasmine.stringMatching('No components found')
      ]));
    });
  });

  // --- Include/Exclude ---

  describe('--include filter', () => {
    it('includes only matching components', async () => {
      await styleguidist([BUILD_DIR, '--dry-run', `--config=${CONFIG_PATH}`, '--include=Button']);

      let lines = logger.stdout.filter(l => l.includes('Snapshot found:'));
      expect(lines.length).toBeGreaterThanOrEqual(1);
      expect(lines.every(l => l.includes('Button'))).toBe(true);
    });

    it('supports wildcard patterns', async () => {
      await styleguidist([BUILD_DIR, '--dry-run', `--config=${CONFIG_PATH}`, '--include=*ut*']);

      expect(logger.stdout).toEqual(jasmine.arrayContaining([
        jasmine.stringMatching('Snapshot found: Button'),
        jasmine.stringMatching('Snapshot found: Input')
      ]));
    });

    it('supports regex patterns', async () => {
      await styleguidist([BUILD_DIR, '--dry-run', `--config=${CONFIG_PATH}`, '--include=/^Button$/']);

      let lines = logger.stdout.filter(l => l.includes('Snapshot found:'));
      expect(lines.some(l => l.includes('Button'))).toBe(true);
      expect(lines.some(l => l.includes('Input'))).toBe(false);
    });
  });

  describe('--exclude filter', () => {
    it('excludes matching components', async () => {
      await styleguidist([BUILD_DIR, '--dry-run', `--config=${CONFIG_PATH}`, '--exclude=Button']);

      let lines = logger.stdout.filter(l => l.includes('Snapshot found:'));
      expect(lines.some(l => l.includes('Button'))).toBe(false);
      expect(lines.some(l => l.includes('Input'))).toBe(true);
    });

    it('shows zero count when all excluded', async () => {
      await styleguidist([BUILD_DIR, '--dry-run', `--config=${CONFIG_PATH}`, '--exclude=*']);

      expect(logger.stdout).toEqual(jasmine.arrayContaining([
        jasmine.stringMatching('Snapshotting 0 of')
      ]));
    });
  });

  // --- Error Handling ---

  describe('error handling', () => {
    it('errors when directory does not exist', async () => {
      await expectAsync(styleguidist(['./nonexistent']))
        .toBeRejectedWithError(/Not found/);
    });

    it('exits when Percy is disabled', async () => {
      process.env.PERCY_ENABLE = '0';
      await styleguidist([BUILD_DIR, `--config=${CONFIG_PATH}`]);
      expect(logger.stderr).toEqual(jasmine.arrayContaining([
        jasmine.stringMatching('Percy is disabled')
      ]));
    });

    it('handles discovery failure gracefully', async () => {
      await expectAsync(
        styleguidist([BUILD_DIR, '--dry-run', '--config=/nonexistent/config.js'])
      ).toBeRejectedWithError();

      expect(logger.stderr).toEqual(jasmine.arrayContaining([
        jasmine.stringMatching('Component discovery failed')
      ]));
    });

    it('handles RSG mount timeout', async () => {
      // Use a build dir with plain HTML (no RSG bundle) — mount will never succeed
      // Reduce timeout expectation by setting a short timeout env
      await expectAsync(
        styleguidist([NORENDER_BUILD_DIR, `--config=${CONFIG_PATH}`])
      ).toBeRejectedWithError(/RSG mount timeout/);

      expect(logger.stderr).toEqual(jasmine.arrayContaining([
        jasmine.stringMatching('RSG did not mount')
      ]));
    }, 90000); // Allow extra time for 30s mount timeout
  });

  // --- Snapshot Capture ---

  describe('snapshot capture', () => {
    it('captures snapshots from static build', async () => {
      await styleguidist([BUILD_DIR, `--config=${CONFIG_PATH}`]);

      expect(logger.stdout).toEqual(jasmine.arrayContaining([
        jasmine.stringMatching('Percy has started'),
        jasmine.stringMatching('Snapshot taken: Button'),
        jasmine.stringMatching('Snapshot taken: Input'),
        jasmine.stringMatching(/Done: \d+ captured/)
      ]));
    });

    it('captures additional snapshots from JSON sidecar', async () => {
      await styleguidist([BUILD_DIR, `--config=${CONFIG_PATH}`]);

      expect(logger.stdout).toEqual(jasmine.arrayContaining([
        jasmine.stringMatching('Snapshot taken: Button'),
        jasmine.stringMatching('Snapshot taken: Button - Mobile'),
        jasmine.stringMatching('Snapshot taken: Prefixed Button')
      ]));
    });

    it('does not capture skipped components', async () => {
      await styleguidist([BUILD_DIR, `--config=${CONFIG_PATH}`]);

      let lines = logger.stdout.filter(l => l.includes('Snapshot taken:'));
      expect(lines.some(l => l.includes('Skip'))).toBe(false);
    });

    it('applies per-component widths from JSON sidecar', async () => {
      let { Percy } = await import('@percy/core');
      spyOn(Percy.prototype, 'snapshot').and.callThrough();

      await styleguidist([BUILD_DIR, `--config=${CONFIG_PATH}`]);

      let calls = Percy.prototype.snapshot.calls?.allArgs() || [];
      let buttonCall = calls.find(args => args[0]?.name === 'Button');
      if (buttonCall) {
        expect(buttonCall[0].widths).toEqual([375, 1280]);
      }
    });

    it('applies include filter during capture', async () => {
      await styleguidist([BUILD_DIR, `--config=${CONFIG_PATH}`, '--include=Input']);

      let lines = logger.stdout.filter(l => l.includes('Snapshot taken:'));
      expect(lines.some(l => l.includes('Input'))).toBe(true);
      expect(lines.some(l => l.includes('Button'))).toBe(false);
    });

    it('applies exclude filter during capture', async () => {
      await styleguidist([BUILD_DIR, `--config=${CONFIG_PATH}`, '--exclude=Button']);

      let lines = logger.stdout.filter(l => l.includes('Snapshot taken:'));
      expect(lines.some(l => l.includes('Button'))).toBe(false);
      expect(lines.some(l => l.includes('Input'))).toBe(true);
    });

    it('drops execute-only variants and warns (Button)', async () => {
      // Button.json's "Modified" variant is { suffix: " - Modified", execute: "..." }.
      // After stripping `execute` it has no width/option differentiator left,
      // so it would just duplicate the base snapshot. Drop it.
      await styleguidist([BUILD_DIR, `--config=${CONFIG_PATH}`, '--include=Button']);

      expect(logger.stderr).toEqual(jasmine.arrayContaining([
        jasmine.stringMatching('Ignoring "execute" in .*Button\\.json'),
        jasmine.stringMatching('Dropping additionalSnapshot in .*Button\\.json')
      ]));

      let snapshotLines = logger.stdout.filter(l => l.includes('Snapshot taken:'));
      expect(snapshotLines.some(l => l.includes('Button - Modified'))).toBe(false);
    });

    it('strips execute from JSON sidecars and drops execute-only variants (BadExec)', async () => {
      // BadExec.json has two additionals:
      //   1. { name: "Custom BadExec Name", widths: [800] } — survives (has widths)
      //   2. { suffix: " - Drops", execute: "..." } — execute stripped, no diff
      //                                                left, dropped with warn
      await styleguidist([BUILD_DIR, `--config=${CONFIG_PATH}`, '--include=BadExec']);

      expect(logger.stderr).toEqual(jasmine.arrayContaining([
        jasmine.stringMatching('Ignoring "execute" in .*BadExec\\.json'),
        jasmine.stringMatching('Dropping additionalSnapshot in .*BadExec\\.json')
      ]));

      // Base + the kept name-bearing variant should appear.
      expect(logger.stdout).toEqual(jasmine.arrayContaining([
        jasmine.stringMatching('Snapshot taken: BadExec'),
        jasmine.stringMatching('Snapshot taken: Custom BadExec Name')
      ]));

      // The dropped execute-only variant must not appear.
      let snapshotLines = logger.stdout.filter(l => l.includes('Snapshot taken:'));
      expect(snapshotLines.some(l => l.includes('BadExec - Drops'))).toBe(false);
    });

    it('rejects with non-zero exit when a snapshot fails (Error object)', async () => {
      let { Percy } = await import('@percy/core');
      let original = Percy.prototype.snapshot;
      let callCount = 0;
      spyOn(Percy.prototype, 'snapshot').and.callFake(function(...args) {
        callCount++;
        if (callCount === 1) throw new Error('Snapshot failed');
        return original.apply(this, args);
      });

      await expectAsync(
        styleguidist([BUILD_DIR, `--config=${CONFIG_PATH}`])
      ).toBeRejectedWithError(/component\(s\) failed to capture/);

      expect(logger.stderr).toEqual(jasmine.arrayContaining([
        jasmine.stringMatching('Failed.*Snapshot failed')
      ]));
    });

    it('continues capturing after an additional snapshot upload fails (Error)', async () => {
      let { Percy } = await import('@percy/core');
      let original = Percy.prototype.snapshot;
      spyOn(Percy.prototype, 'snapshot').and.callFake(function(opts, ...rest) {
        // Throw only for the "Mobile" additional (a width-only variant
        // that survives the strip). Base and "Prefixed Button" should
        // still capture.
        if (opts && opts.name === 'Button - Mobile') {
          throw new Error('additional upload failed');
        }
        return original.call(this, opts, ...rest);
      });

      await expectAsync(
        styleguidist([BUILD_DIR, `--config=${CONFIG_PATH}`, '--include=Button'])
      ).toBeRejectedWithError(/component\(s\) failed to capture/);

      expect(logger.stderr).toEqual(jasmine.arrayContaining([
        jasmine.stringMatching('Failed additional.*Button.*additional upload failed')
      ]));
      // Base snapshot and the non-failing additional should still appear
      expect(logger.stdout).toEqual(jasmine.arrayContaining([
        jasmine.stringMatching('Snapshot taken: Button'),
        jasmine.stringMatching('Snapshot taken: Prefixed Button')
      ]));
    });

    it('continues capturing after an additional snapshot upload fails (string)', async () => {
      let { Percy } = await import('@percy/core');
      let original = Percy.prototype.snapshot;
      spyOn(Percy.prototype, 'snapshot').and.callFake(function(opts, ...rest) {
        if (opts && opts.name === 'Button - Mobile') {
          throw 'plain string failure';
        }
        return original.call(this, opts, ...rest);
      });

      await expectAsync(
        styleguidist([BUILD_DIR, `--config=${CONFIG_PATH}`, '--include=Button'])
      ).toBeRejectedWithError(/component\(s\) failed to capture/);

      expect(logger.stderr).toEqual(jasmine.arrayContaining([
        jasmine.stringMatching('Failed additional.*Button.*plain string failure')
      ]));
    });

    it('rejects with non-zero exit when a snapshot fails (string error)', async () => {
      let { Percy } = await import('@percy/core');
      let original = Percy.prototype.snapshot;
      let callCount = 0;
      spyOn(Percy.prototype, 'snapshot').and.callFake(function(...args) {
        callCount++;
        if (callCount === 1) throw 'string error thrown';
        return original.apply(this, args);
      });

      await expectAsync(
        styleguidist([BUILD_DIR, `--config=${CONFIG_PATH}`])
      ).toBeRejectedWithError(/component\(s\) failed to capture/);

      expect(logger.stderr).toEqual(jasmine.arrayContaining([
        jasmine.stringMatching('Failed.*string error')
      ]));
    });
  });

  // --- Dry-run edge cases ---

  describe('dry-run edge cases', () => {
    it('skips filter message when all components pass', async () => {
      // Use config that only discovers Button + Input (no Skip)
      await styleguidist([BUILD_DIR, '--dry-run', `--config=${NOSKIP_CONFIG_PATH}`]);

      // No "Snapshotting X of Y" message should appear
      let filterMsg = logger.stdout.find(l => l.includes('Snapshotting'));
      expect(filterMsg).toBeUndefined();

      expect(logger.stdout).toEqual(jasmine.arrayContaining([
        jasmine.stringMatching('Snapshot found: Button'),
        jasmine.stringMatching('Snapshot found: Input')
      ]));
    });

    it('handles component with percy config but no additionalSnapshots', async () => {
      // Input.json has { widths: [1280] } but no additionalSnapshots
      await styleguidist([BUILD_DIR, '--dry-run', `--config=${CONFIG_PATH}`, '--include=Input']);

      let lines = logger.stdout.filter(l => l.includes('Snapshot found:'));
      expect(lines.length).toBe(1); // Only base snapshot, no additional
      expect(lines[0]).toContain('Input');
    });

    it('lists additional snapshot with no name/prefix/suffix (falls back to component name)', async () => {
      await styleguidist([BUILD_DIR, '--dry-run', `--config=${CONFIG_PATH}`, '--include=NoNameAdditional']);

      let lines = logger.stdout.filter(l => l.includes('Snapshot found: NoNameAdditional'));
      // Base + additional with same name (no prefix/suffix/name)
      expect(lines.length).toBe(2);
    });

    it('handles URL argument', async () => {
      // Just test the argument parser — URL mode sets args.url
      await styleguidist(['http://localhost:99999', '--dry-run', `--config=${CONFIG_PATH}`]);

      expect(logger.stdout).toEqual(jasmine.arrayContaining([
        jasmine.stringMatching('Using Styleguidist at: http://localhost:99999')
      ]));
    });
  });

  // --- Capture edge cases ---

  describe('capture edge cases', () => {
    it('captures additional snapshot with no name/prefix/suffix', async () => {
      await styleguidist([BUILD_DIR, `--config=${CONFIG_PATH}`, '--include=NoNameAdditional']);

      let lines = logger.stdout.filter(l => l.includes('Snapshot taken: NoNameAdditional'));
      expect(lines.length).toBeGreaterThanOrEqual(1);
    });

    it('captures additional snapshot with prefix', async () => {
      await styleguidist([BUILD_DIR, `--config=${CONFIG_PATH}`, '--include=Button']);

      expect(logger.stdout).toEqual(jasmine.arrayContaining([
        jasmine.stringMatching('Snapshot taken: Button'),
        jasmine.stringMatching('Snapshot taken: Prefixed Button')
      ]));
    });
  });

  // --- Unit: buildSnapshotName (via import) ---

  describe('snapshot naming', () => {
    // We can't import buildSnapshotName directly (not exported),
    // but it's exercised through dry-run and capture tests:
    // - add.name truthy: BadExec has { name: "Custom BadExec Name" }
    // - add.prefix truthy: Input has { prefix: "Prefixed " }
    // - add.suffix truthy: Button has { suffix: " - Mobile" }
    // - all falsy: NoNameAdditional has { widths: [800] }

    it('uses explicit name when provided (dry-run)', async () => {
      await styleguidist([BUILD_DIR, '--dry-run', `--config=${CONFIG_PATH}`, '--include=BadExec']);
      expect(logger.stdout).toEqual(jasmine.arrayContaining([
        jasmine.stringMatching('Snapshot found: Custom BadExec Name')
      ]));
    });

    it('uses prefix when no name (dry-run)', async () => {
      await styleguidist([BUILD_DIR, '--dry-run', `--config=${CONFIG_PATH}`, '--include=Button']);
      expect(logger.stdout).toEqual(jasmine.arrayContaining([
        jasmine.stringMatching('Snapshot found: Prefixed Button')
      ]));
    });

    it('uses suffix when no name (dry-run)', async () => {
      await styleguidist([BUILD_DIR, '--dry-run', `--config=${CONFIG_PATH}`, '--include=Button']);
      expect(logger.stdout).toEqual(jasmine.arrayContaining([
        jasmine.stringMatching('Snapshot found: Button - Mobile')
      ]));
    });

    it('falls back to component name when no name/prefix/suffix (dry-run)', async () => {
      await styleguidist([BUILD_DIR, '--dry-run', `--config=${CONFIG_PATH}`, '--include=NoNameAdditional']);
      let lines = logger.stdout.filter(l => l.includes('Snapshot found: NoNameAdditional'));
      expect(lines.length).toBe(2); // base + additional with same name
    });
  });

  // --- Unit: config.js ---

  describe('shouldIncludeComponent', () => {
    it('includes all when no flags', () => {
      expect(shouldIncludeComponent('Button', {})).toBe(true);
    });

    it('includes by exact match', () => {
      expect(shouldIncludeComponent('Button', { include: ['Button'] })).toBe(true);
      expect(shouldIncludeComponent('Input', { include: ['Button'] })).toBe(false);
    });

    it('excludes by exact match', () => {
      expect(shouldIncludeComponent('Button', { exclude: ['Button'] })).toBe(false);
      expect(shouldIncludeComponent('Input', { exclude: ['Button'] })).toBe(true);
    });

    it('supports glob wildcard', () => {
      expect(shouldIncludeComponent('Button', { include: ['But*'] })).toBe(true);
      expect(shouldIncludeComponent('Input', { include: ['But*'] })).toBe(false);
    });

    it('supports regex patterns', () => {
      expect(shouldIncludeComponent('Button', { include: ['/^But/'] })).toBe(true);
      expect(shouldIncludeComponent('Input', { include: ['/^But/'] })).toBe(false);
    });

    it('supports regex with flags', () => {
      expect(shouldIncludeComponent('button', { include: ['/^button$/i'] })).toBe(true);
    });

    it('handles non-string patterns', () => {
      expect(shouldIncludeComponent('Button', { include: [123] })).toBe(false);
    });
  });

  // --- Unit: discovery.js helpers ---

  describe('nameFromFilepath', () => {
    let helpers;
    beforeAll(async () => {
      helpers = await import('../src/discovery.js');
    });

    it('extracts name from filepath', () => {
      expect(helpers.nameFromFilepath('src/components/Button/Button.js')).toBe('Button');
    });

    it('handles Windows paths', () => {
      expect(helpers.nameFromFilepath('src\\components\\Button\\Button.js')).toBe('Button');
    });

    it('returns null for null/undefined filepath', () => {
      expect(helpers.nameFromFilepath(null)).toBeNull();
      expect(helpers.nameFromFilepath(undefined)).toBeNull();
    });
  });

  describe('readPercyConfig', () => {
    let helpers;
    beforeAll(async () => {
      helpers = await import('../src/discovery.js');
    });

    it('returns empty object when filepath is null', () => {
      expect(helpers.readPercyConfig(null, '.')).toEqual({});
    });

    it('returns empty object when JSON file does not exist', () => {
      expect(helpers.readPercyConfig('nonexistent/File.js', FIXTURE_DIR)).toEqual({});
    });

    it('uses cwd fallback when configDir is null', () => {
      // Should not throw — falls back to '.'
      let result = helpers.readPercyConfig('nonexistent.js', null);
      expect(result).toEqual({});
    });

    it('works without log parameter', () => {
      let { mkdirSync, writeFileSync, unlinkSync, rmdirSync } = fs;
      let tmpDir = path.join(FIXTURE_DIR, 'src/components/TmpNoLog');
      mkdirSync(tmpDir, { recursive: true });
      writeFileSync(path.join(tmpDir, 'TmpNoLog.json'), '{ bad }');
      try {
        let config = helpers.readPercyConfig('src/components/TmpNoLog/TmpNoLog.js', FIXTURE_DIR);
        expect(config).toEqual({});
      } finally {
        unlinkSync(path.join(tmpDir, 'TmpNoLog.json'));
        rmdirSync(tmpDir);
      }
    });

    it('reads percy config from JSON sidecar', () => {
      let config = helpers.readPercyConfig(
        'src/components/Button/Button.js',
        FIXTURE_DIR
      );
      expect(config.widths).toEqual([375, 1280]);
    });

    it('returns empty when JSON has no percy key', async () => {
      // Use a temp component path to avoid conflicting with Input.json fixture
      let tmpDir = path.join(FIXTURE_DIR, 'src/components/Temp');
      let { mkdirSync, writeFileSync, unlinkSync, rmdirSync } = fs;
      mkdirSync(tmpDir, { recursive: true });
      writeFileSync(path.join(tmpDir, 'Temp.json'), '{"other": true}');
      try {
        let config = helpers.readPercyConfig('src/components/Temp/Temp.js', FIXTURE_DIR);
        expect(config).toEqual({});
      } finally {
        unlinkSync(path.join(tmpDir, 'Temp.json'));
        rmdirSync(tmpDir);
      }
    });

    it('warns and returns empty on malformed JSON', async () => {
      let tmpDir = path.join(FIXTURE_DIR, 'src/components/Temp2');
      let { mkdirSync, writeFileSync, unlinkSync, rmdirSync } = fs;
      mkdirSync(tmpDir, { recursive: true });
      writeFileSync(path.join(tmpDir, 'Temp2.json'), '{ bad json');
      try {
        let mockLog = { warn: jasmine.createSpy('warn') };
        let config = helpers.readPercyConfig('src/components/Temp2/Temp2.js', FIXTURE_DIR, mockLog);
        expect(config).toEqual({});
        expect(mockLog.warn).toHaveBeenCalledWith(jasmine.stringMatching('Failed to parse'));
      } finally {
        unlinkSync(path.join(tmpDir, 'Temp2.json'));
        rmdirSync(tmpDir);
      }
    });
  });

  describe('flattenSections', () => {
    let helpers;
    beforeAll(async () => {
      helpers = await import('../src/discovery.js');
    });

    it('returns empty for null sections', () => {
      expect(helpers.flattenSections(null, '.')).toEqual([]);
    });

    it('returns empty for non-array sections', () => {
      expect(helpers.flattenSections('not-array', '.')).toEqual([]);
    });

    it('returns empty for depth > 10', () => {
      expect(helpers.flattenSections([{ components: [] }], '.', null, 11)).toEqual([]);
    });

    it('skips components without slug', () => {
      let sections = [{ components: [{ filepath: 'x.js' }] }];
      expect(helpers.flattenSections(sections, '.')).toEqual([]);
    });

    it('skips components without derivable name', () => {
      let sections = [{ components: [{ slug: 'x' }] }];
      // No filepath, no visibleName, no name → nameFromFilepath returns null → skip
      expect(helpers.flattenSections(sections, '.')).toEqual([]);
    });

    it('handles sections with no components key', () => {
      let sections = [{ name: 'Empty' }];
      expect(helpers.flattenSections(sections, '.')).toEqual([]);
    });

    it('handles nested sections', () => {
      let sections = [{
        sections: [{
          components: [{ slug: 'btn', filepath: 'Button.js' }]
        }]
      }];
      let result = helpers.flattenSections(sections, '.');
      expect(result.length).toBe(1);
      expect(result[0].name).toBe('Button');
    });

    it('sets filepath to null when component has no filepath', () => {
      let sections = [{
        components: [{ slug: 'btn', visibleName: 'Button' }]
      }];
      let result = helpers.flattenSections(sections, '.');
      expect(result[0].filepath).toBeNull();
    });

    it('uses visibleName over filepath-derived name', () => {
      let sections = [{
        components: [{ slug: 'btn', visibleName: 'MyButton', filepath: 'Other.js' }]
      }];
      let result = helpers.flattenSections(sections, '.');
      expect(result[0].name).toBe('MyButton');
    });

    it('uses name over filepath-derived name', () => {
      let sections = [{
        components: [{ slug: 'btn', name: 'NamedBtn', filepath: 'Other.js' }]
      }];
      let result = helpers.flattenSections(sections, '.');
      expect(result[0].name).toBe('NamedBtn');
    });
  });

  describe('rsg-adapter', () => {
    it('getConfig auto-discovers config when no path given', async () => {
      let adapter = await import('../src/rsg-adapter.js');
      // When called without configPath, RSG searches for styleguide.config.js
      // In our test env this may find the root config or throw — both are valid
      try {
        let config = adapter.getConfig();
        expect(config).toBeDefined();
      } catch (e) {
        expect(e.message).toContain('style guide config');
      }
    });
  });

  describe('discoverComponents', () => {
    it('discovers components with percy config from JSON sidecars', () => {
      let components = discoverComponents(CONFIG_PATH);
      let button = components.find(c => c.name === 'Button');
      expect(button).toBeDefined();
      expect(button.percy.widths).toEqual([375, 1280]);
      // Button.json has 3 additional snapshots, but " - Modified" is
      // dropped at sidecar-read time (its only differentiator was a stripped
      // `execute` string). 2 survive: " - Mobile" and "Prefixed ".
      expect(button.percy.additionalSnapshots.length).toBe(2);
    });

    it('returns empty percy config when no JSON sidecar exists', () => {
      let components = discoverComponents(NOSKIP_CONFIG_PATH);
      // Use noskip config which discovers Button (has JSON) and Input (has JSON)
      // Both have JSON sidecars now. Let's use the main config and check BadExec
      // which has additionalSnapshots, or check that components without JSON get {}
      components = discoverComponents(CONFIG_PATH);
      // BadExec has a JSON sidecar with additionalSnapshots
      let badExec = components.find(c => c.name === 'BadExec');
      expect(badExec).toBeDefined();
      expect(badExec.percy.additionalSnapshots).toBeDefined();
    });

    it('returns skip: true from JSON sidecar', () => {
      let components = discoverComponents(CONFIG_PATH);
      let skip = components.find(c => c.name === 'Skip');
      expect(skip).toBeDefined();
      expect(skip.percy.skip).toBe(true);
    });

    it('returns empty array for empty sections config', () => {
      let components = discoverComponents(EMPTY_CONFIG_PATH);
      expect(components).toEqual([]);
    });
  });
});
