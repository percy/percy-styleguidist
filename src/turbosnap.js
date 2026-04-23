import { execFileSync as _execFileSync } from 'child_process';
import { rsgBuild as _rsgBuild } from './rsg-adapter.js';

// SHA validation — defense-in-depth alongside execFileSync (which already avoids shell).
const SHA_PATTERN = /^[0-9a-f]{40}$/i;

// Test seams. Production code uses the defaults; tests can override via
// the `deps` parameter on getTurboSnapFilter(). We avoid rewiring module
// globals so ESM binding immutability doesn't bite.
export const defaultDeps = {
  execFileSync: (...args) => _execFileSync(...args),
  rsgBuild: (...args) => _rsgBuild(...args),
  httpPostJson: (...args) => httpPostJson(...args)
};

// Extract only module dependency edges from full webpack stats.
// At 200 components: full stats ~10MB → edges ~100KB
// At 50K components: full stats ~500MB → edges ~30MB → gzips to ~5MB
//
// Webpack 4 and webpack 5 use slightly different reason shapes; we capture
// all three fields (moduleName / resolvedModule / module) and filter out
// reasons that have none of them.
export function extractModuleEdges(statsJson) {
  return (statsJson.modules || []).map(mod => ({
    name: mod.name,
    identifier: mod.identifier,
    reasons: (mod.reasons || []).map(r => ({
      moduleName: r.moduleName,
      resolvedModule: r.resolvedModule,
      module: r.module
    })).filter(r => r.moduleName || r.resolvedModule || r.module)
  }));
}

// Invoke RSG's programmatic build to capture webpack Stats.
// RSG signature (verified in node_modules/react-styleguidist/lib/scripts/build.js):
//   build(config, callback)  where  callback(err, stats)
export function captureWebpackStats(rsgConfig, rsgBuild = defaultDeps.rsgBuild) {
  return new Promise((resolve, reject) => {
    try {
      rsgBuild(rsgConfig, (err, stats) => {
        if (err) return reject(err);
        if (!stats) return reject(new Error('RSG build returned no stats'));
        if (typeof stats.hasErrors === 'function' && stats.hasErrors()) {
          let errors = [];
          try {
            errors = stats.toJson({ errors: true }).errors || [];
          } catch (_) { /* ignore toJson errors */ }
          return reject(new Error(errors.join('\n') || 'webpack build errors'));
        }
        try {
          let json = stats.toJson({
            modules: true,
            reasons: true,
            source: false,
            assets: false,
            chunks: false
          });
          resolve(json);
        } catch (e) {
          reject(e);
        }
      });
    } catch (e) {
      reject(e);
    }
  });
}

// Small native-http helper with a timeout. Pattern matches
// cli/packages/client/src/utils.js and cli/packages/sdk-utils/src/request.js
// — no external HTTP deps; no native fetch + AbortController.
export async function httpPostJson(url, body, { timeoutMs = 30_000 } = {}) {
  let httpModule = url.startsWith('https:')
    ? (await import('https')).default
    : (await import('http')).default;
  let payload = JSON.stringify(body);

  return new Promise((resolve, reject) => {
    let settled = false;
    let settle = (fn, arg) => {
      if (settled) return;
      settled = true;
      fn(arg);
    };

    let req = httpModule.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, res => {
      let chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        let raw = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          try {
            settle(resolve, JSON.parse(raw));
          } catch (e) {
            settle(reject, new Error(`Invalid JSON response: ${e.message}`));
          }
        } else {
          settle(reject, new Error(`HTTP ${res.statusCode || 'unknown'}: ${raw.slice(0, 200)}`));
        }
      });
      res.on('error', e => settle(reject, e));
    });

    req.on('error', e => settle(reject, e));
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Timeout after ${timeoutMs}ms`));
    });
    req.end(payload);
  });
}

// Main entry point. Returns:
//   null      → caller should snapshot all (fallback / no filter)
//   Set<str>  → caller should snapshot only components whose (lowercased) filepath is in the set
//   Set<>     → empty set means "skip everything" (0 components affected)
//
// Every failure path returns null (full snapshot) — TurboSnap must never block the build.
//
// `deps` is a test seam — production callers omit it.
export async function getTurboSnapFilter({ percy, rsgConfig, components, log }, deps = defaultDeps) {
  let { execFileSync, rsgBuild, httpPostJson: httpPost } = { ...defaultDeps, ...deps };

  // 1. Baseline SHA — only present after first build in the project
  let baselineSha = percy && percy.build && percy.build.baselineCommitSha;
  if (!baselineSha) {
    log.debug('TurboSnap: No baseline commit available, snapshotting all');
    return null;
  }

  if (!SHA_PATTERN.test(baselineSha)) {
    log.warn('TurboSnap: Invalid baseline SHA format, snapshotting all');
    return null;
  }

  // 2. git diff — execFileSync avoids shell interpolation
  let changedFiles;
  try {
    let output = execFileSync('git', ['diff', '--name-only', `${baselineSha}..HEAD`], {
      encoding: 'utf8',
      timeout: 30_000
    });
    changedFiles = output.trim().split('\n').filter(Boolean);
  } catch (e) {
    log.debug(`TurboSnap: git diff failed (${e.message}), snapshotting all`);
    return null;
  }

  if (!changedFiles.length) {
    log.debug('TurboSnap: No files changed since baseline, snapshotting all');
    return null;
  }

  // 3. Capture webpack stats by invoking RSG's build() directly, then extract edges
  let moduleEdges;
  try {
    let statsJson = await captureWebpackStats(rsgConfig, rsgBuild);
    moduleEdges = extractModuleEdges(statsJson);
  } catch (e) {
    log.debug(`TurboSnap: webpack stats capture failed (${e.message}), snapshotting all`);
    return null;
  }

  // 4. Gzip + base64 the edges payload. Pako is already available transitively
  //    via @percy/client, matching the rest of the cli monorepo.
  let webpackStatsGz;
  try {
    let pakoModule = await import('pako');
    let Pako = pakoModule.default || pakoModule;
    let edgesJson = JSON.stringify({ modules: moduleEdges });
    webpackStatsGz = Buffer.from(Pako.gzip(edgesJson)).toString('base64');
  } catch (e) {
    log.debug(`TurboSnap: Compression failed (${e.message}), snapshotting all`);
    return null;
  }

  // 5. Component file paths are already relative to rsgConfig.configDir.
  //    In the common case (styleguide.config.js at repo root), they match
  //    `git diff` output directly.
  let componentFilePaths = components.map(c => c.filepath).filter(Boolean);

  // 6. POST to the local @percy/core server.
  let serverAddress = process.env.PERCY_SERVER_ADDRESS || `http://localhost:${percy.port}`;

  try {
    let resp = await httpPost(`${serverAddress}/percy/turbosnap`, {
      changedFiles,
      webpackStatsGz,
      componentFilePaths
    }, { timeoutMs: 30_000 });

    let attrs = resp && resp.data && resp.data.attributes;

    if (attrs && attrs.bail) {
      log.warn(`TurboSnap: bailed — ${attrs['bail-reason'] || 'unknown reason'}. Snapshotting all.`);
      return null;
    }

    let affected = attrs && attrs['affected-file-paths'];
    if (!affected || !affected.length) {
      log.info('TurboSnap: 0 components affected by changes');
      return new Set();
    }

    log.info(`TurboSnap: ${affected.length}/${components.length} components affected`);
    return new Set(affected.map(p => String(p).toLowerCase()));
  } catch (e) {
    log.warn(`TurboSnap: API call failed (${e.message}). Snapshotting all.`);
    return null;
  }
}
