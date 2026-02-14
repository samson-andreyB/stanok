import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeRel, resolveProjectDir } from './path-utils.mjs';

export async function runBuild(payload) {
  const safePayload = normalizePayload(payload);
  const projectDir = resolveProjectDir(safePayload.projects_path, safePayload.project_name, safePayload.config.nest);
  const root = normalizeRel(safePayload.config.root || 'assets/');
  const imgDir = safePayload.config.img || 'img';
  const srcDir = path.join(projectDir, root, imgDir, 'src');
  const destDir = path.join(projectDir, root, imgDir, 'dest');

  await ensureDir(destDir);
  if (!(await exists(srcDir))) {
    return 'Изображения обработаны: 0 файл(ов)';
  }

  let copied = 0;
  const ensuredDirs = new Set([destDir]);

  for await (const sourceFile of walk(srcDir)) {
    if (!/\.(gif|jpg|jpeg|png|svg)$/i.test(sourceFile)) {
      continue;
    }

    const rel = path.relative(srcDir, sourceFile);
    const target = path.join(destDir, rel);
    const targetDir = path.dirname(target);

    if (!ensuredDirs.has(targetDir)) {
      await ensureDir(targetDir);
      ensuredDirs.add(targetDir);
    }

    const [srcStat, dstStat] = await Promise.all([
      fs.stat(sourceFile),
      fs.stat(target).catch(() => null),
    ]);

    if (!dstStat || srcStat.mtimeMs > dstStat.mtimeMs) {
      await fs.copyFile(sourceFile, target);
      copied += 1;
    }
  }

  return `Изображения обработаны: ${copied} файл(ов)`;
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
