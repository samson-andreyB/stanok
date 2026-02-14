import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { normalizeRel, resolveProjectDir, resolveStanokCacheRoot } from './path-utils.mjs';

const IMAGE_EXT_RE = /\.(gif|jpg|jpeg|png|svg)$/i;
const IMG_CACHE_VERSION = 1;
const MEMORY_CACHE_MAX_ENTRIES = 16;
const memoryImageCaches = new Map();

export async function runBuild(payload) {
  const safePayload = normalizePayload(payload);
  const projectDir = resolveProjectDir(safePayload.projects_path, safePayload.project_name, safePayload.config.nest);
  const root = normalizeRel(safePayload.config.root || 'assets/');
  const imgDir = safePayload.config.img || 'img';
  const srcDir = path.join(projectDir, root, imgDir, 'src');
  const destDir = path.join(projectDir, root, imgDir, 'dest');
  const cachePath = resolveImagesBuildCachePath(projectDir, root, imgDir, safePayload.config);

  try {
    await fs.rm(path.join(projectDir, root, imgDir, '.img-build-cache.json'), { force: true });
  } catch {
    // ignore legacy cache cleanup errors
  }

  await ensureDir(destDir);
  if (!(await exists(srcDir))) {
    return 'Изображения обработаны: 0 файл(ов)';
  }

  const cacheLoaded = await loadBuildCache(cachePath);
  const previousEntries = cacheLoaded.cache.entries || {};
  const nextEntries = {};
  let copied = 0;
  const ensuredDirs = new Set([destDir]);

  for await (const sourceFile of walk(srcDir)) {
    if (!IMAGE_EXT_RE.test(sourceFile)) {
      continue;
    }

    const rel = path.relative(srcDir, sourceFile);
    const relKey = normalizeRelPath(rel);
    const target = path.join(destDir, rel);
    const targetDir = path.dirname(target);
    const srcStat = await fs.stat(sourceFile);
    const sourceSignature = `${Math.floor(srcStat.mtimeMs)}:${srcStat.size}`;
    const targetExists = await exists(target);
    nextEntries[relKey] = sourceSignature;

    if (targetExists && previousEntries[relKey] === sourceSignature) {
      continue;
    }

    if (targetExists && await filesAreEqual(sourceFile, target, srcStat)) {
      continue;
    }

    if (!ensuredDirs.has(targetDir)) {
      await ensureDir(targetDir);
      ensuredDirs.add(targetDir);
    }

    await fs.copyFile(sourceFile, target);
    copied += 1;
  }

  await saveBuildCache(cachePath, {
    version: IMG_CACHE_VERSION,
    entries: nextEntries,
    updatedAt: Date.now(),
  });

  const summary = [`Изображения обработаны: ${copied} файл(ов)`];
  if (cacheLoaded.resetReason) {
    summary.push(`Кэш изображений сброшен: ${cacheLoaded.resetReason}`);
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

function formatBuildError(error) {
  if (!error || typeof error !== 'object') {
    return String(error);
  }

  if (typeof error.message === 'string' && error.message.trim()) {
    return error.message.trim();
  }

  return String(error);
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function loadBuildCache(filePath) {
  const memoryEntry = memoryImageCaches.get(filePath);
  let fileMtimeMs = -1;
  try {
    const stat = await fs.stat(filePath);
    fileMtimeMs = stat.mtimeMs;
  } catch {
    fileMtimeMs = -1;
  }
  if (memoryEntry && memoryEntry.mtimeMs === fileMtimeMs) {
    touchMemoryCacheEntry(memoryImageCaches, filePath, memoryEntry, MEMORY_CACHE_MAX_ENTRIES);
    return { cache: memoryEntry.cache, resetReason: '' };
  }

  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return {
        cache: { version: IMG_CACHE_VERSION, entries: {} },
        resetReason: 'invalid-format',
      };
    }
    if (Number(parsed.version || 0) !== IMG_CACHE_VERSION) {
      return {
        cache: { version: IMG_CACHE_VERSION, entries: {} },
        resetReason: `schema-mismatch(v${parsed.version || 0}->v${IMG_CACHE_VERSION})`,
      };
    }
    if (!parsed.entries || typeof parsed.entries !== 'object') {
      parsed.entries = {};
    }
    touchMemoryCacheEntry(
      memoryImageCaches,
      filePath,
      { cache: parsed, mtimeMs: fileMtimeMs },
      MEMORY_CACHE_MAX_ENTRIES
    );
    return { cache: parsed, resetReason: '' };
  } catch {
    return {
      cache: { version: IMG_CACHE_VERSION, entries: {} },
      resetReason: '',
    };
  }
}

async function saveBuildCache(filePath, cache) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, JSON.stringify(cache, null, 2), 'utf8');
  let mtimeMs = -1;
  try {
    const stat = await fs.stat(filePath);
    mtimeMs = stat.mtimeMs;
  } catch {
    mtimeMs = -1;
  }
  touchMemoryCacheEntry(memoryImageCaches, filePath, { cache, mtimeMs }, MEMORY_CACHE_MAX_ENTRIES);
}

async function* walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(entryPath);
    } else if (entry.isFile()) {
      yield entryPath;
    }
  }
}

function normalizeRelPath(relPath) {
  return String(relPath || '').replace(/\\/g, '/');
}

function resolveImagesBuildCachePath(projectDir, root, imgDir, config) {
  const cacheRoot = resolveStanokCacheRoot();
  const hash = createHash('sha1');
  hash.update('img-build-cache-v1');
  hash.update('\0');
  hash.update(projectDir);
  hash.update('\0');
  hash.update(root);
  hash.update('\0');
  hash.update(imgDir);
  hash.update('\0');
  hash.update(JSON.stringify(config || {}));
  return path.join(cacheRoot, 'images', `${hash.digest('hex')}.json`);
}

async function filesAreEqual(sourceFile, targetFile, sourceStat = null) {
  try {
    const srcStat = sourceStat || await fs.stat(sourceFile);
    const targetStat = await fs.stat(targetFile);
    if (srcStat.size !== targetStat.size) {
      return false;
    }

    const [srcBuf, targetBuf] = await Promise.all([
      fs.readFile(sourceFile),
      fs.readFile(targetFile),
    ]);
    return srcBuf.equals(targetBuf);
  } catch {
    return false;
  }
}

function touchMemoryCacheEntry(map, key, value, maxEntries) {
  if (map.has(key)) {
    map.delete(key);
  }
  map.set(key, value);
  while (map.size > maxEntries) {
    const oldestKey = map.keys().next().value;
    if (typeof oldestKey === 'undefined') {
      break;
    }
    map.delete(oldestKey);
  }
}

async function main() {
  const payloadRaw = process.argv[2];
  if (!payloadRaw) {
    throw new Error('Missing build payload');
  }
  const payload = JSON.parse(payloadRaw);
  const out = await runBuild(payload);
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
