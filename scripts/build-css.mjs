import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  buildPathToProjectsRoot,
  normalizeRel,
  normalizeRoot,
  resolveProjectDir,
} from './path-utils.mjs';

const require = createRequire(import.meta.url);
const postcss = require('postcss5');
const intcss = require('intcss');

let payload;
let projectDir;
let root;
let styleDir;
let imgDir;
let layoutsDir;
let libDir;
let browsers;
let bPath;
let pathToProjectsRoot;
let srcDir;
const inlineMaxSizeKb = 1;
const fallbackUrlRe = /url\((['"]?)([a-f0-9]{32}-\d+x\d+\.png)\1\)/gi;
const BUILD_CACHE_VERSION = 2;
let fallbackUrlPrefix;
let profiler;
let styleIncludePaths;
let buildCache;
let buildCachePath;
let buildCacheDirty;
let cacheResetReason = '';

export async function runBuild(payloadInput) {
  const totalStartedAt = performance.now();
  profiler = createProfiler();

  const setupStartedAt = performance.now();
  payload = normalizePayload(payloadInput);
  projectDir = resolveProjectDir(payload.projects_path, payload.project_name, payload.config.nest);
  process.chdir(projectDir);

  root = normalizeRoot(payload.config.root);
  styleDir = path.normalize(path.join(projectDir, root, payload.config.style || 'css'));
  imgDir = path.normalize(path.join(projectDir, root, payload.config.img || 'img'));
  layoutsDir = payload.config.layouts || '_layouts';
  libDir = payload.config.lib || '../lib';
  browsers =
    Array.isArray(payload.config.browsers) && payload.config.browsers.length
      ? payload.config.browsers
      : ['last 5 versions', 'Chrome 27', 'ff 12', 'ie 8', 'ie 9', 'opera 12'];

  bPath = path.normalize(path.join(projectDir, root, layoutsDir, 'src'));
  pathToProjectsRoot = buildPathToProjectsRoot(payload.config.nest);
  srcDir = path.join(styleDir, 'src');
  styleIncludePaths = [
    path.normalize(path.join(projectDir, pathToProjectsRoot, libDir, 'styles/postcss/')),
    bPath,
  ];
  const rootRel = normalizeRel(payload.config.root || '');
  const imgRel = normalizeRel(payload.config.img || 'img');
  fallbackUrlPrefix = (`/${rootRel}/${imgRel}/svg_fallback/`).replace(/\/+/g, '/');
  profiler.add('setup', performance.now() - setupStartedAt);

  const cacheStartedAt = performance.now();
  buildCachePath = path.join(styleDir, '.css-build-cache.json');
  const cacheLoaded = loadBuildCache(buildCachePath);
  buildCache = cacheLoaded.cache;
  cacheResetReason = cacheLoaded.resetReason || '';
  buildCacheDirty = false;
  profiler.add('cache-load', performance.now() - cacheStartedAt);

  const cleanupStartedAt = performance.now();
  try {
    fs.rmSync(path.join(imgDir, 'svg_fallback'), { recursive: true, force: true });
  } catch {
    // ignore
  }
  profiler.add('cleanup', performance.now() - cleanupStartedAt);

  const discoverStartedAt = performance.now();
  const styles = fs
    .readdirSync(srcDir)
    .filter((name) => /^_main.*\.css$/.test(name));
  profiler.add('discover', performance.now() - discoverStartedAt);

  if (!styles.length) {
    return 'Не найдены файлы стилей для обработки';
  }

  const maxWorkers = Math.max(
    1,
    Math.min(
      styles.length,
      Number.parseInt(process.env.STANOK_CSS_WORKERS || '', 10) || Math.min(4, os.cpus().length)
    )
  );
  profiler.add('workers', 0, { workers: maxWorkers, styles: styles.length });
  const results = await runWithConcurrency(styles, maxWorkers, processStyle);
  const builtCount = results.filter((item) => item?.status === 'built').length;
  const skippedCount = results.filter((item) => item?.status === 'skipped').length;

  const cacheWriteStartedAt = performance.now();
  if (buildCacheDirty) {
    saveBuildCache(buildCachePath, buildCache);
  }
  profiler.add('cache-write', performance.now() - cacheWriteStartedAt, { cacheDirty: buildCacheDirty });
  profiler.add('total', performance.now() - totalStartedAt);

  if (profiler.enabled) {
    const report = profiler.render();
    if (report) {
      console.log(report);
    }
  }

  const summary = [`Стили обработаны: ${styles.length} файл(ов)`];
  if (cacheResetReason) {
    summary.push(`Кэш инкрементальной сборки сброшен: ${cacheResetReason}`);
  }
  if (skippedCount > 0) {
    summary.push(`Инкрементально пропущено: ${skippedCount}`);
  }
  if (builtCount > 0) {
    summary.push(`Пересобрано: ${builtCount}`);
  }
  for (const item of results) {
    if (!item?.style) {
      continue;
    }
    summary.push(`- ${item.style}: ${item.status}${item.reason ? ` (${item.reason})` : ''}`);
  }
  return summary.join('\n');
}

function normalizePayload(payloadInput) {
  if (!payloadInput || typeof payloadInput !== 'object') {
    throw new Error('Invalid build payload');
  }
  if (!payloadInput.projects_path || !payloadInput.project_name) {
    throw new Error('Invalid build payload: projects_path/project_name required');
  }
  return {
    ...payloadInput,
    config: payloadInput.config && typeof payloadInput.config === 'object' ? payloadInput.config : {},
  };
}

async function processStyle(style) {
  const styleTotalStartedAt = performance.now();
  const stylePath = path.normalize(path.join(srcDir, style));
  const stylePure = style.replace(/^_/, '');
  const outputs = {
    css: path.normalize(path.join(styleDir, stylePure)),
    data: path.normalize(path.join(styleDir, `${path.basename(stylePure, '.css')}_data.css`)),
    map: path.normalize(path.join(styleDir, `maps/${stylePure}.map`)),
  };
  const incrementStartedAt = performance.now();
  const forceRebuild =
    process.env.STANOK_CSS_FORCE_REBUILD === '1' ||
    process.env.STANOK_CSS_FORCE_REBUILD === 'true' ||
    process.env.STANOK_CSS_FORCE_REBUILD === 'yes';
  const depGraph = collectImportGraph(stylePath, styleIncludePaths);
  const depSignature = createDepSignature(depGraph);
  const cachedEntry = buildCache?.entries?.[style] || null;
  const outputsReady = fs.existsSync(outputs.css) && fs.existsSync(outputs.data) && fs.existsSync(outputs.map);
  const shouldSkip = !forceRebuild && outputsReady && cachedEntry && cachedEntry.depSignature === depSignature;
  const depMeta = createDepMeta(depGraph);
  profiler.addStyle(style, 'increment-check', performance.now() - incrementStartedAt);

  if (shouldSkip) {
    profiler.addStyle(style, 'total', performance.now() - styleTotalStartedAt);
    profiler.addStyle(style, 'skipped', 0);
    return { style, status: 'skipped', reason: 'unchanged' };
  }

  let buildReason = 'changed';
  if (forceRebuild) {
    buildReason = 'force-rebuild';
  } else if (!cachedEntry) {
    buildReason = 'initial';
  } else if (!outputsReady) {
    buildReason = 'outputs-missing';
  } else if (cachedEntry.depSignature !== depSignature) {
    const changedDeps = diffDepMeta(cachedEntry.depMeta || {}, depMeta).slice(0, 3);
    buildReason = changedDeps.length ? `dependency-changed: ${changedDeps.join(', ')}` : 'dependency-changed';
  }

  const readStartedAt = performance.now();
  const source = fs.readFileSync(stylePath);
  profiler.addStyle(style, 'read', performance.now() - readStartedAt);

  const processStartedAt = performance.now();
  const result = await postcss([
    intcss({
      import: {
        from: stylePath,
        path: [path.dirname(stylePath), ...styleIncludePaths],
      },
      assets: {
        loadPaths: [path.normalize(path.join(imgDir, 'dest'))],
      },
      svg: {
        paths: [path.normalize(path.join(imgDir, 'dest'))],
      },
      url: {
        maxSize: inlineMaxSizeKb,
        basePath: projectDir,
        filter(url) {
          const normalizedUrl = String(url || '');

          return (
            /[\\/]dest[\\/]/.test(normalizedUrl) ||
            /[\\/]lib[\\/]styles[\\/]/.test(normalizedUrl) ||
            /[\\/]src[\\/]b[\\/]/.test(normalizedUrl)
          );
        },
      },
      'svg-fallback': {
        dest: path.normalize(path.join(imgDir, 'svg_fallback/')),
      },
      autoprefixer: {
        browsers,
        remove: false,
      },
      'data-packer': {
        dest: {
          path(opts) {
            return path.join(path.dirname(opts.to), `${path.basename(opts.to, '.css')}_data.css`);
          },
          map: {
            inline: false,
            annotation(dataOpts, opts) {
              return path.join(path.dirname(opts.map.annotation), `${path.basename(dataOpts.to)}.map`);
            },
          },
        },
      },
    }),
  ]).process(source, {
    from: stylePath,
    to: outputs.css,
    map: {
      inline: false,
      annotation: `maps/${stylePure}.map`,
    },
  });
  profiler.addStyle(style, 'postcss+intcss', performance.now() - processStartedAt);

  const normalizeStartedAt = performance.now();
  const cssOut = normalizeCssOutput(result.css);
  profiler.addStyle(style, 'normalize', performance.now() - normalizeStartedAt);

  const writeCssStartedAt = performance.now();
  writeIfChanged(outputs.css, cssOut);
  profiler.addStyle(style, 'write-css', performance.now() - writeCssStartedAt);

  if (result.map) {
    const writeMapStartedAt = performance.now();
    writeIfChanged(outputs.map, String(result.map));
    profiler.addStyle(style, 'write-map', performance.now() - writeMapStartedAt);
  }

  buildCache.entries[style] = {
    depSignature,
    depMeta,
    updatedAt: Date.now(),
  };
  buildCacheDirty = true;
  profiler.addStyle(style, 'total', performance.now() - styleTotalStartedAt);
  return { style, status: 'built', reason: buildReason };
}

function formatBuildError(error) {
  if (!error || typeof error !== 'object') {
    return String(error);
  }

  const plugin = error.plugin ? `${String(error.plugin)}: ` : '';
  const file = error.file || error.fileName || error.input?.file || '';
  const line = error.line ?? error.lineNumber ?? error.input?.line;
  const column = error.column ?? error.columnNumber ?? error.input?.column;
  const reason = error.reason || error.originalMessage || error.message || 'Ошибка сборки CSS';

  if (file && line && column) {
    return `${plugin}${file}:${line}:${column}: ${reason}`;
  }
  if (file) {
    return `${plugin}${file}: ${reason}`;
  }
  return `${plugin}${reason}`;
}

function normalizeCssOutput(cssText) {
  return String(cssText)
    .replace(/-moz-\s*oldlinear-gradient/gi, '-moz-linear-gradient')
    .replace(/-moz-\s*oldrepeating-linear-gradient/gi, '-moz-repeating-linear-gradient')
    .replace(fallbackUrlRe, (_m, _q, file) => `url("${fallbackUrlPrefix}${file}")`);
}

function writeIfChanged(filePath, content) {
  const next = String(content);
  const nextSize = Buffer.byteLength(next, 'utf8');
  let current = null;

  if (fs.existsSync(filePath)) {
    const stat = fs.statSync(filePath);
    if (stat.size === nextSize) {
      current = fs.readFileSync(filePath, 'utf8');
    }
  }

  if (current === next) {
    return;
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, next);
}

async function runWithConcurrency(items, workers, handler) {
  if (workers <= 1 || items.length <= 1) {
    const results = [];
    for (const item of items) {
      results.push(await handler(item));
    }
    return results;
  }

  let index = 0;
  const results = new Array(items.length);
  const tasks = Array.from({ length: workers }, async () => {
    while (true) {
      const current = index;
      index += 1;
      if (current >= items.length) {
        return;
      }
      const item = items[current];
      results[current] = await handler(item);
    }
  });

  await Promise.all(tasks);
  return results;
}

function loadBuildCache(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return {
        cache: { version: BUILD_CACHE_VERSION, entries: {} },
        resetReason: 'invalid-format',
      };
    }
    if (Number(parsed.version || 0) !== BUILD_CACHE_VERSION) {
      return {
        cache: { version: BUILD_CACHE_VERSION, entries: {} },
        resetReason: `schema-mismatch(v${parsed.version || 0}->v${BUILD_CACHE_VERSION})`,
      };
    }
    if (!parsed.entries || typeof parsed.entries !== 'object') {
      parsed.entries = {};
    }
    return {
      cache: parsed,
      resetReason: '',
    };
  } catch {
    return {
      cache: { version: BUILD_CACHE_VERSION, entries: {} },
      resetReason: '',
    };
  }
}

function saveBuildCache(filePath, cache) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(cache, null, 2));
}

function collectImportGraph(entryPath, includePaths) {
  const visited = new Set();
  const deps = new Set();

  const visit = (filePath) => {
    const realPath = fs.realpathSync(filePath);
    if (visited.has(realPath)) {
      return;
    }
    visited.add(realPath);
    deps.add(realPath);

    const source = fs.readFileSync(realPath, 'utf8');
    const parentDir = path.dirname(realPath);
    for (const line of source.split(/\r?\n/)) {
      const target = parseImportTarget(line);
      if (!target) {
        continue;
      }
      const resolved = resolveImportPath(target, parentDir, includePaths);
      if (resolved) {
        visit(resolved);
      }
    }
  };

  visit(entryPath);
  return [...deps].sort();
}

function parseImportTarget(line) {
  const normalized = String(line || '').replace(/\/\*[\s\S]*?\*\//g, '').trim();
  if (!normalized.startsWith('@import') || !normalized.endsWith(';') || normalized.includes('url(')) {
    return null;
  }
  const single = normalized.match(/@import\s+'([^']+)'\s*;/);
  if (single) {
    return single[1];
  }
  const dbl = normalized.match(/@import\s+"([^"]+)"\s*;/);
  return dbl ? dbl[1] : null;
}

function resolveImportPath(target, currentParent, includePaths) {
  const candidates = buildImportCandidates(target);
  for (const candidate of candidates) {
    const localPath = path.join(currentParent, candidate);
    if (fs.existsSync(localPath)) {
      return localPath;
    }
  }
  for (const basePath of includePaths) {
    for (const candidate of candidates) {
      const fullPath = path.join(basePath, candidate);
      if (fs.existsSync(fullPath)) {
        return fullPath;
      }
    }
  }
  return null;
}

function buildImportCandidates(target) {
  const normalized = String(target || '').replace(/\\/g, '/').replace(/^\.?\//, '').replace(/^\/+/, '');
  const withExt = normalized.endsWith('.css') ? [normalized] : [normalized, `${normalized}.css`];
  const basename = path.basename(normalized);
  const dirname = path.dirname(normalized);
  const underscored = basename.startsWith('_')
    ? []
    : [
        path.join(dirname === '.' ? '' : dirname, `_${basename}`),
        path.join(dirname === '.' ? '' : dirname, `_${basename}.css`),
      ];
  const stripped = normalized.startsWith('lib/') ? normalized.slice(4) : null;
  const strippedCandidates = stripped
    ? stripped.endsWith('.css')
      ? [stripped]
      : [stripped, `${stripped}.css`]
    : [];
  return Array.from(new Set([...withExt, ...underscored, ...strippedCandidates]));
}

function createDepSignature(deps) {
  const hash = createHash('sha1');
  hash.update('intcss-v1|');
  hash.update(JSON.stringify({ browsers, root, styleDir, imgDir, bPath, libDir }));
  for (const depPath of deps) {
    const stat = fs.statSync(depPath);
    hash.update('|');
    hash.update(path.relative(projectDir, depPath));
    hash.update(':');
    hash.update(String(Math.floor(stat.mtimeMs)));
    hash.update(':');
    hash.update(String(stat.size));
  }
  return hash.digest('hex');
}

function createDepMeta(deps) {
  const out = {};
  for (const depPath of deps) {
    const stat = fs.statSync(depPath);
    const rel = path.relative(projectDir, depPath);
    out[rel] = `${Math.floor(stat.mtimeMs)}:${stat.size}`;
  }
  return out;
}

function diffDepMeta(prevMeta, nextMeta) {
  const changed = [];
  const keys = new Set([...Object.keys(prevMeta || {}), ...Object.keys(nextMeta || {})]);
  for (const key of keys) {
    if ((prevMeta || {})[key] !== (nextMeta || {})[key]) {
      changed.push(key);
    }
  }
  return changed.sort();
}

function createProfiler() {
  const enabled =
    process.env.STANOK_CSS_PROFILE === '1' ||
    process.env.STANOK_CSS_PROFILE === 'true' ||
    process.env.STANOK_CSS_PROFILE === 'yes';
  const stages = new Map();
  const styleStages = new Map();
  const meta = [];

  return {
    enabled,
    add(name, ms, data) {
      if (!enabled) {
        return;
      }
      const prev = stages.get(name) || 0;
      stages.set(name, prev + Number(ms || 0));
      if (data && typeof data === 'object') {
        meta.push({ name, data });
      }
    },
    addStyle(style, name, ms) {
      if (!enabled) {
        return;
      }
      const styleKey = String(style || 'unknown');
      if (!styleStages.has(styleKey)) {
        styleStages.set(styleKey, new Map());
      }
      const styleMap = styleStages.get(styleKey);
      styleMap.set(name, (styleMap.get(name) || 0) + Number(ms || 0));
    },
    render() {
      if (!enabled) {
        return '';
      }

      const lines = ['[css-profile] stage timings (ms)'];
      const ordered = [...stages.entries()].sort((a, b) => b[1] - a[1]);
      for (const [name, ms] of ordered) {
        lines.push(`- ${name}: ${ms.toFixed(2)}`);
      }

      if (meta.length) {
        for (const item of meta) {
          if (item.name === 'workers') {
            lines.push(`[css-profile] workers=${item.data.workers} styles=${item.data.styles}`);
          }
        }
      }

      if (styleStages.size) {
        lines.push('[css-profile] per-style timings (ms)');
        const sortedStyles = [...styleStages.entries()].sort((a, b) => {
          const at = a[1].get('total') || 0;
          const bt = b[1].get('total') || 0;
          return bt - at;
        });

        for (const [styleName, styleMap] of sortedStyles) {
          lines.push(`- ${styleName}`);
          const parts = [...styleMap.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([stageName, ms]) => `${stageName}=${ms.toFixed(2)}`);
          lines.push(`  ${parts.join(' | ')}`);
        }
      }

      return lines.join('\n');
    },
  };
}

async function main() {
  const payloadRaw = process.argv[2];
  if (!payloadRaw) {
    throw new Error('Missing build payload');
  }

  const payloadParsed = JSON.parse(payloadRaw);
  const out = await runBuild(payloadParsed);
  if (out) {
    console.log(out);
  }
}

const isCliEntry = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCliEntry) {
  main().catch((error) => {
    console.error(formatBuildError(error));
    process.exit(1);
  });
}
