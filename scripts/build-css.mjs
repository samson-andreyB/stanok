import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  buildPathToProjectsRoot,
  normalizeRel,
  normalizeRoot,
  resolveProjectDir,
} from './path-utils.mjs';

const scriptFile = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(scriptFile);
const runtimeNodeModulesDir = path.resolve(scriptDir, '..', 'node_modules');
const require = createRequire(import.meta.url);
const intcss = requireOrThrow('intcss', 'Не найден модуль intcss. Выполни npm install перед запуском сборки.');
const postcss = resolvePostcss();

function requireOrThrow(moduleName, message) {
  try {
    const resolved = require.resolve(moduleName, {
      paths: [runtimeNodeModulesDir, process.cwd()],
    });
    return require(resolved);
  } catch (error) {
    const details =
      error && typeof error === 'object'
        ? String(error.message || error.stack || error)
        : String(error);
    const isDirectMissing =
      error &&
      typeof error === 'object' &&
      error.code === 'MODULE_NOT_FOUND' &&
      details.includes(`'${moduleName}'`);
    if (isDirectMissing) {
      throw new Error(`${message} Причина: ${details}`);
    }
    throw new Error(`Ошибка загрузки модуля ${moduleName}. Причина: ${details}`);
  }
}

function resolvePostcss() {
  try {
    return require('postcss5');
  } catch {}

  try {
    return require('postcss');
  } catch {}

  try {
    const intcssEntry = require.resolve('intcss');
    return require(require.resolve('postcss', { paths: [path.dirname(intcssEntry)] }));
  } catch {}

  throw new Error(
    'Не найден postcss5/postcss. Выполни npm install (или npm ci) и перезапусти сборку.',
  );
}

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
let fallbackUrlPrefix;
const enableSvgFallback = process.env.STANOK_ENABLE_SVG_FALLBACK === '1';

export async function runBuild(payloadInput) {
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
  const rootRel = normalizeRel(payload.config.root || '');
  const imgRel = normalizeRel(payload.config.img || 'img');
  fallbackUrlPrefix = (`/${rootRel}/${imgRel}/svg_fallback/`).replace(/\/+/g, '/');

  try {
    fs.rmSync(path.join(imgDir, 'svg_fallback'), { recursive: true, force: true });
  } catch {
    // ignore
  }

  const styles = fs
    .readdirSync(srcDir)
    .filter((name) => /^_main.*\.css$/.test(name));

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
  await runWithConcurrency(styles, maxWorkers, processStyle);

  return `Стили обработаны: ${styles.length} файл(ов)`;
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
  const stylePath = path.normalize(path.join(srcDir, style));
  const stylePure = style.replace(/^_/, '');
  const source = fs.readFileSync(stylePath);
  const intcssOptions = {
    import: {
      from: stylePath,
      path: [
        path.dirname(stylePath),
        path.normalize(path.join(projectDir, pathToProjectsRoot, libDir, 'styles/postcss/')),
        bPath,
      ],
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
  };

  if (enableSvgFallback) {
    intcssOptions['svg-fallback'] = {
      dest: path.normalize(path.join(imgDir, 'svg_fallback/')),
    };
  }

  const result = await postcss([
    intcss(intcssOptions),
  ]).process(source, {
    from: stylePath,
    to: path.normalize(path.join(styleDir, stylePure)),
    map: {
      inline: false,
      annotation: `maps/${stylePure}.map`,
    },
  });

  const cssOut = normalizeCssOutput(result.css);
  writeIfChanged(result.opts.to, cssOut);

  if (result.map) {
    const mapPath = path.join(path.dirname(result.opts.to), result.opts.map.annotation);
    writeIfChanged(mapPath, String(result.map));
  }
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
    for (const item of items) {
      await handler(item);
    }
    return;
  }

  const queue = [...items];
  const tasks = Array.from({ length: workers }, async () => {
    while (queue.length) {
      const item = queue.shift();
      if (!item) {
        return;
      }
      await handler(item);
    }
  });

  await Promise.all(tasks);
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
