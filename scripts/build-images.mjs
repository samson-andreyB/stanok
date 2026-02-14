import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeRel, resolveProjectDir } from './path-utils.mjs';

const IMAGE_EXT_RE = /\.(gif|jpg|jpeg|png|svg)$/i;
const IMG_CACHE_VERSION = 1;

export async function runBuild(payload) {
  const safePayload = normalizePayload(payload);
  const projectDir = resolveProjectDir(safePayload.projects_path, safePayload.project_name, safePayload.config.nest);
  const root = normalizeRel(safePayload.config.root || 'assets/');
  const imgDir = safePayload.config.img || 'img';
  const srcDir = path.join(projectDir, root, imgDir, 'src');
  const destDir = path.join(projectDir, root, imgDir, 'dest');
  const cachePath = path.join(projectDir, root, imgDir, '.img-build-cache.json');

  await ensureDir(destDir);
  if (!(await exists(srcDir))) {
    return 'Изображения обработаны: 0 файл(ов)';
  }

  const cacheLoaded = await loadBuildCache(cachePath);
  const previousEntries = cacheLoaded.cache.entries || {};
  const nextEntries = {};
  const activeRelPaths = new Set();
  let copied = 0;
  let skipped = 0;
  let scanned = 0;
  let removed = 0;
  const ensuredDirs = new Set([destDir]);

  for await (const sourceFile of walk(srcDir)) {
    if (!IMAGE_EXT_RE.test(sourceFile)) {
      continue;
    }

    scanned += 1;
    const rel = path.relative(srcDir, sourceFile);
    activeRelPaths.add(normalizeRelPath(rel));
    const target = path.join(destDir, rel);
    const targetDir = path.dirname(target);
    const srcStat = await fs.stat(sourceFile);
    const sourceSignature = `${Math.floor(srcStat.mtimeMs)}:${srcStat.size}`;
    const targetExists = await exists(target);
    nextEntries[rel] = sourceSignature;

    if (targetExists && previousEntries[rel] === sourceSignature) {
      skipped += 1;
      continue;
    }

    if (!ensuredDirs.has(targetDir)) {
      await ensureDir(targetDir);
      ensuredDirs.add(targetDir);
    }

    await fs.copyFile(sourceFile, target);
    copied += 1;
  }

  removed += await cleanupStaleDestFiles(destDir, activeRelPaths);

  await saveBuildCache(cachePath, {
    version: IMG_CACHE_VERSION,
    entries: nextEntries,
    updatedAt: Date.now(),
  });

  const summary = [`Изображения обработаны: ${copied} файл(ов)`];
  if (cacheLoaded.resetReason) {
    summary.push(`Кэш изображений сброшен: ${cacheLoaded.resetReason}`);
  }
  summary.push(`Пропущено без изменений: ${skipped}`);
  summary.push(`Удалено устаревших: ${removed}`);
  summary.push(`Проверено файлов: ${scanned}`);
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

async function cleanupStaleDestFiles(destDir, activeRelPaths) {
  let removed = 0;
  const dirs = [];

  for await (const destFile of walk(destDir)) {
    const rel = normalizeRelPath(path.relative(destDir, destFile));
    if (!IMAGE_EXT_RE.test(destFile)) {
      continue;
    }
    if (activeRelPaths.has(rel)) {
      continue;
    }
    await fs.rm(destFile, { force: true });
    removed += 1;
  }

  for await (const dirPath of walkDirs(destDir)) {
    dirs.push(dirPath);
  }
  dirs.sort((a, b) => b.length - a.length);
  for (const dirPath of dirs) {
    if (dirPath === destDir) {
      continue;
    }
    try {
      const entries = await fs.readdir(dirPath);
      if (!entries.length) {
        await fs.rmdir(dirPath);
      }
    } catch {
      // ignore
    }
  }

  return removed;
}

async function* walkDirs(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  yield dir;
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const entryPath = path.join(dir, entry.name);
    yield* walkDirs(entryPath);
  }
}

function normalizeRelPath(relPath) {
  return String(relPath || '').replace(/\\/g, '/');
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
