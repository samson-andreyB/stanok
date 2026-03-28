/**
 * audit-plugin-usage.mjs
 *
 * Сканирует CSS-файлы в usage-audit/input/ и строит отчёт по использованию
 * каждого из 18 плагинов intcss. Группирует по проектам (подпапкам).
 *
 * Usage:
 *   node scripts/audit-plugin-usage.mjs                         # MD + JSON + HTML → report/
 *   node scripts/audit-plugin-usage.mjs --input ./my/css/dir
 *   node scripts/audit-plugin-usage.mjs --plugins-meta-url https://example.com/plugins-meta.json
 *   node scripts/audit-plugin-usage.mjs --format html --output docs/plugin-audit/index.html
 *   node scripts/audit-plugin-usage.mjs --format json
 *   node scripts/audit-plugin-usage.mjs --format markdown
 */

import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Plugin metadata (priority + complexity) — optionally loaded from URL
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const getArg = (flag) => {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : null;
};

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
const INPUT_DIR = getArg('--input') ?? path.join(ROOT, 'test/style_pipeline/usage-audit/input');
const OUTPUT_PATH = getArg('--output') ?? null;
const FORMAT = getArg('--format') ?? 'all'; // 'all' | 'markdown' | 'json' | 'html'
const LOCKFILE_PATH = path.join(ROOT, 'package-lock.json');
const PROJECT_MAP_PATH = getArg('--project-map') ?? null;
const PLUGINS_META_URL = getArg('--plugins-meta-url') ?? null;

function loadProjectAliasMap(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const source = raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw.projects && typeof raw.projects === 'object' && !Array.isArray(raw.projects) ? raw.projects : raw)
      : {};

    const aliases = {};
    for (const [realName, aliasName] of Object.entries(source)) {
      const from = String(realName ?? '').trim();
      const to = String(aliasName ?? '').trim();
      if (!from || !to) continue;
      aliases[from] = to;
    }
    return aliases;
  } catch (error) {
    console.warn(`Не удалось прочитать project map: ${filePath}`);
    console.warn(error instanceof Error ? error.message : String(error));
    return {};
  }
}

const PROJECT_ALIASES = loadProjectAliasMap(PROJECT_MAP_PATH);

function aliasProjectName(projectName) {
  return PROJECT_ALIASES[projectName] ?? projectName;
}

function aliasRelativePath(relPath) {
  const parts = String(relPath).split('/');
  if (parts.length <= 1) return relPath;
  const projectName = parts[0];
  return [aliasProjectName(projectName), ...parts.slice(1)].join('/');
}

function validateAliasedProjects(inputDir, projectAliases) {
  const aliasToSource = new Map();
  const projectNames = fs.existsSync(inputDir)
    ? fs.readdirSync(inputDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
    : [];

  for (const projectName of projectNames) {
    const alias = projectAliases[projectName] ?? projectName;
    const prev = aliasToSource.get(alias);
    if (prev && prev !== projectName) {
      throw new Error(`Два проекта используют один alias "${alias}": "${prev}" и "${projectName}"`);
    }
    aliasToSource.set(alias, projectName);
  }
}

validateAliasedProjects(INPUT_DIR, PROJECT_ALIASES);

function loadPackageVersions(lockfilePath) {
  if (!fs.existsSync(lockfilePath)) return {};
  try {
    const lock = JSON.parse(fs.readFileSync(lockfilePath, 'utf8'));
    const versions = {};

    const packages = lock?.packages ?? {};
    for (const [key, pkg] of Object.entries(packages)) {
      if (!key.includes('node_modules/')) continue;
      const packageName = key.split('node_modules/').pop();
      if (packageName && pkg?.version && !versions[packageName]) {
        versions[packageName] = String(pkg.version);
      }
    }

    const deps = lock?.dependencies ?? {};
    for (const [packageName, dep] of Object.entries(deps)) {
      if (packageName && dep?.version && !versions[packageName]) {
        versions[packageName] = String(dep.version);
      }
    }

    return versions;
  } catch {
    return {};
  }
}

const PACKAGE_VERSIONS = loadPackageVersions(LOCKFILE_PATH);

function loadIntcssDependencySpecs(lockfilePath) {
  if (!fs.existsSync(lockfilePath)) return {};
  try {
    const lock = JSON.parse(fs.readFileSync(lockfilePath, 'utf8'));
    const deps = lock?.packages?.['node_modules/intcss']?.dependencies ?? {};
    const specs = {};
    for (const [packageName, versionSpec] of Object.entries(deps)) {
      if (packageName && typeof versionSpec === 'string') {
        specs[packageName] = versionSpec;
      }
    }
    return specs;
  } catch {
    return {};
  }
}

const INTCSS_DEP_SPECS = loadIntcssDependencySpecs(LOCKFILE_PATH);

async function loadPluginsMeta(url) {
  if (!url) return {};
  try {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const raw = await response.json();
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    return raw;
  } catch (error) {
    console.warn(`Не удалось загрузить plugins meta по URL: ${url}`);
    console.warn(error instanceof Error ? error.message : String(error));
    return {};
  }
}

const PLUGIN_NPM_PACKAGE = {
  'postcss-nested (BEM)': 'postcss-nested',
  'postcss-nested (standard)': 'postcss-nested',
};

const PLUGIN_DESCRIPTIONS_RU = {
  'postcss-import': 'Подставляет содержимое импортируемых CSS-файлов в итоговый файл на этапе сборки.',
  'postcss-mixins': 'Добавляет поддержку миксинов: переиспользуемых CSS-блоков с параметрами.',
  'postcss-axis': 'Преобразует осевые свойства вроде margin-x/padding-y в обычные CSS-свойства по сторонам.',
  'postcss-property-lookup': 'Позволяет ссылаться на значение другого свойства внутри правила через @-lookup синтаксис.',
  'postcss-assets': 'Работает с ассетами: вычисляет размеры, резолвит пути и подставляет данные файлов в CSS.',
  'postcss-advanced-variables': 'Добавляет sass-подобные переменные, условия и циклы в CSS.',
  'postcss-color-function': 'Расширяет функции цветовых вычислений: tint/shade/lighten/darken и подобные операции.',
  'postcss-strip-units': 'Убирает единицы измерения из чисел внутри выражений, где это нужно.',
  'postcss-conditionals': 'Добавляет условные конструкции @if/@else для генерации CSS по условиям.',
  'postcss-nested (BEM)': 'Разворачивает BEM-вложенность с &__element и &--modifier в плоские селекторы.',
  'postcss-nested (standard)': 'Разворачивает стандартную CSS-вложенность селекторов (&, дочерние и соседние комбинации).',
  'postcss-extend': 'Добавляет механизм @extend для наследования стилей между селекторами.',
  'postcss-calc': 'Вычисляет и упрощает выражения calc(), когда это возможно на этапе сборки.',
  'postcss-svg': 'Встраивает и параметризует SVG-ресурсы в CSS, включая генерацию data URI.',
  'postcss-url': 'Переписывает и нормализует пути в url() по заданным правилам.',
  'postcss-svg-fallback': 'Генерирует fallback для SVG-ресурсов (например, альтернативы для старых браузеров).',
  'postcss-color-rgba-fallback': 'Добавляет fallback-цвета для rgba() в форматах для устаревших браузеров.',
  'autoprefixer': 'Добавляет вендорные префиксы в CSS по целевому списку браузеров.',
  'postcss-data-packer': 'Упаковывает ресурсы в data URI и инлайнит их в CSS.',
};

function resolvePluginPackageMeta(pluginId, meta) {
  const explicitNpm = typeof meta?.npm === 'string' ? meta.npm.trim() : '';
  let npmPackage = '';
  let npmUrl = '';

  if (explicitNpm) {
    if (/^https?:\/\//i.test(explicitNpm)) {
      npmUrl = explicitNpm;
      npmPackage = typeof meta?.npmPackage === 'string' ? meta.npmPackage.trim() : '';
    } else {
      npmPackage = explicitNpm;
      npmUrl = `https://www.npmjs.com/package/${encodeURIComponent(npmPackage)}`;
    }
  } else {
    npmPackage = PLUGIN_NPM_PACKAGE[pluginId] ?? pluginId;
    npmUrl = `https://www.npmjs.com/package/${encodeURIComponent(npmPackage)}`;
  }

  const explicitVersion = typeof meta?.version === 'string' ? meta.version.trim() : '';
  const lockVersion = npmPackage ? PACKAGE_VERSIONS[npmPackage] : '';
  const depSpecVersion = npmPackage ? INTCSS_DEP_SPECS[npmPackage] : '';
  const version = explicitVersion || lockVersion || depSpecVersion || '—';

  return { npm: npmUrl || null, npmPackage: npmPackage || null, version };
}

// ---------------------------------------------------------------------------
// Plugin definitions
// ---------------------------------------------------------------------------

function buildPlugins(pluginsMeta = {}) {
  return [
  {
    id: 'postcss-import',
    order: 1,
    lightning: 'none',
    recommendation: 'Rust Pre-stage (обязательный)',
    patterns: [
      { label: '@import string',   re: /@import\s+["']/gm },
      { label: '@import url()',     re: /@import\s+url\(/gm },
    ],
    transforms: [
      {
        label: '@import → inline содержимого файла',
        input:
`/* main.css */
@import "variables.css";
@import "base/reset.css";

.foo { color: red; }`,
        output:
`/* main.css */
/* ── variables.css ── */
$color-primary: #3b82f6;

/* ── base/reset.css ── */
* { box-sizing: border-box; }

.foo { color: red; }`,
      },
    ],
  },
  {
    id: 'postcss-mixins',
    order: 2,
    lightning: 'none',
    recommendation: 'Rust Pre-stage (обязательный)',
    patterns: [
      { label: '@define-mixin',             re: /@define-mixin\s+\w+/gm },
      { label: '@define-mixin with params', re: /@define-mixin\s+\w+\s+\$\w+/gm },
      { label: '@mixin call',               re: /@mixin\s+\w+/gm },
      { label: '@mixin-content',            re: /@mixin-content/gm },
    ],
    transforms: [
      {
        label: 'простой mixin',
        input:
`@define-mixin flex-center {
  display: flex;
  align-items: center;
  justify-content: center;
}

.box { @mixin flex-center; }`,
        output:
`.box {
  display: flex;
  align-items: center;
  justify-content: center;
}`,
      },
      {
        label: 'параметрический mixin',
        input:
`@define-mixin size $w, $h {
  width: $w;
  height: $h;
}

.icon { @mixin size 24px, 24px; }`,
        output:
`.icon {
  width: 24px;
  height: 24px;
}`,
      },
    ],
  },
  {
    id: 'postcss-axis',
    order: 3,
    lightning: 'none',
    recommendation: 'Rust Pre-stage (обязательный — 32 matches подтверждены)',
    patterns: [
      { label: 'margin-x/y',   re: /\bmargin-[xy]\s*:/gm },
      { label: 'padding-x/y',  re: /\bpadding-[xy]\s*:/gm },
      { label: 'border-x/y',   re: /\bborder-[xy]\s*:/gm },
      { label: 'inset-x/y',    re: /\binset-[xy]\s*:/gm },
    ],
    transforms: [
      {
        label: 'axis-shorthand → отдельные стороны',
        input:
`.el {
  margin-x: 16px;
  padding-y: 8px;
  inset-x: 0;
}`,
        output:
`.el {
  margin-left: 16px;
  margin-right: 16px;
  padding-top: 8px;
  padding-bottom: 8px;
  left: 0;
  right: 0;
}`,
      },
    ],
  },
  {
    id: 'postcss-property-lookup',
    order: 4,
    lightning: 'none',
    recommendation: 'Out of scope — нет usage в реальных проектах',
    patterns: [
      { label: ': @property-name', re: /:\s*@[a-z][a-z-]+(?!\s*[\w(])/gm },
    ],
  },
  {
    id: 'postcss-assets',
    order: 5,
    lightning: 'none',
    recommendation: 'Rust Pre-stage (обязательный)',
    patterns: [
      { label: 'width()',   re: /\bwidth\(['"]/gm },
      { label: 'height()',  re: /\bheight\(['"]/gm },
      { label: 'resolve()', re: /\bresolve\(['"]/gm },
      { label: 'inline()',  re: /\binline\(['"]/gm },
      { label: 'size()',    re: /\bsize\(['"]/gm },
    ],
    transforms: [
      {
        label: 'resolve() → url() с абсолютным путём',
        input:
`.hero {
  background: resolve('images/hero.jpg');
}`,
        output:
`.hero {
  background: url('/assets/images/hero.jpg');
}`,
      },
      {
        label: 'width()/height() → реальные размеры файла',
        input:
`.logo {
  width: width('logo.svg');
  height: height('logo.svg');
}`,
        output:
`.logo {
  width: 120px;
  height: 40px;
}`,
      },
    ],
  },
  {
    id: 'postcss-advanced-variables',
    order: 6,
    lightning: 'none',
    recommendation: 'Rust Pre-stage для $var; @for/@if — проверить usage',
    patterns: [
      { label: '$var declaration', re: /\$[a-zA-Z][\w-]*\s*:/gm },
      { label: '$var usage',       re: /(?<![a-zA-Z])\$[a-zA-Z][\w-]*/gm },
      { label: '!default flag',    re: /!default/gm },
      { label: '!global flag',     re: /!global/gm },
      { label: '@for loop',        re: /@for\s+\$\w+\s+from/gm },
      { label: '@each loop',       re: /@each\s+\$\w+\s+in/gm },
      { label: '@if condition',    re: /@if\s+/gm },
    ],
    transforms: [
      {
        label: '$переменные',
        input:
`$primary: #3b82f6;
$radius: 6px;

.btn {
  color: $primary;
  border-radius: $radius;
}`,
        output:
`.btn {
  color: #3b82f6;
  border-radius: 6px;
}`,
      },
      {
        label: '@for цикл',
        input:
`@for $i from 1 to 4 {
  .col-$(i) { flex: 0 0 calc(100% / $i); }
}`,
        output:
`.col-1 { flex: 0 0 calc(100% / 1); }
.col-2 { flex: 0 0 calc(100% / 2); }
.col-3 { flex: 0 0 calc(100% / 3); }`,
      },
    ],
  },
  {
    id: 'postcss-color-function',
    order: 7,
    lightning: 'partial',
    recommendation: 'Out of scope — нет usage в реальных проектах',
    patterns: [
      { label: 'color(shade)',   re: /\bcolor\([^)]*shade\(/gm },
      { label: 'color(tint)',    re: /\bcolor\([^)]*tint\(/gm },
      { label: 'color(lighten)', re: /\bcolor\([^)]*lighten\(/gm },
      { label: 'color(darken)',  re: /\bcolor\([^)]*darken\(/gm },
      { label: 'color(alpha)',   re: /\bcolor\([^)]*\ba\(\d/gm },
    ],
  },
  {
    id: 'postcss-strip-units',
    order: 8,
    lightning: 'none',
    recommendation: 'Out of scope — нет usage в реальных проектах',
    patterns: [
      { label: 'strip()', re: /\bstrip\([^)]+\)/gm },
    ],
  },
  {
    id: 'postcss-conditionals',
    order: 9,
    lightning: 'none',
    recommendation: 'Out of scope — нет usage в реальных проектах',
    patterns: [
      { label: '@if',      re: /@if\s+/gm },
      { label: '@else',    re: /@else[\s{]/gm },
      { label: '@else if', re: /@else\s+if\s+/gm },
    ],
  },
  {
    id: 'postcss-nested (BEM)',
    order: 10,
    lightning: 'none',
    recommendation: '⚠️ Rust Pre-stage обязателен — Lightning CSS не поддерживает BEM-конкатенацию',
    patterns: [
      { label: '&__element',      re: /&__[\w-]+/gm },
      { label: '&--modifier',     re: /&--[\w-]+/gm },
      { label: 'prefix& (a&)',    re: /[a-zA-Z]&(?=[^{])/gm },
    ],
    transforms: [
      {
        label: 'BEM &__element и &--modifier',
        input:
`.block {
  color: black;

  &__elem {
    font-size: 14px;
  }

  &--active {
    font-weight: bold;
  }
}`,
        output:
`.block {
  color: black;
}
.block__elem {
  font-size: 14px;
}
.block--active {
  font-weight: bold;
}`,
      },
    ],
  },
  {
    id: 'postcss-nested (standard)',
    order: 10,
    lightning: 'yes',
    recommendation: 'Lightning CSS покрывает стандартные комбинаторы нативно',
    patterns: [
      { label: '&:pseudo',        re: /&:/gm },
      { label: '&.class',         re: /&\./gm },
      { label: '& > child',       re: /&\s*>/gm },
      { label: '& + sibling',     re: /&\s*\+/gm },
      { label: '& ~ sibling',     re: /&\s*~/gm },
      { label: '&[attr]',         re: /&\[/gm },
    ],
    transforms: [
      {
        label: 'стандартное вложение (Lightning CSS)',
        input:
`.parent {
  color: black;

  .child { color: blue; }

  &:hover { opacity: .8; }

  & > .direct { margin: 0; }
}`,
        output:
`.parent { color: black; }
.parent .child { color: blue; }
.parent:hover { opacity: .8; }
.parent > .direct { margin: 0; }`,
      },
    ],
  },
  {
    id: 'postcss-extend',
    order: 11,
    lightning: 'none',
    recommendation: 'Out of scope — нет usage в реальных проектах (0 matches)',
    patterns: [
      { label: '@extend .class',       re: /@extend\s+\./gm },
      { label: '@extend %placeholder', re: /@extend\s+%/gm },
      { label: '%placeholder def',     re: /^\s*%[\w-]+\s*\{/gm },
    ],
  },
  {
    id: 'postcss-calc',
    order: 12,
    lightning: 'yes',
    recommendation: 'Lightning CSS native — встроенная оптимизация calc()',
    patterns: [
      { label: 'calc() usage', re: /\bcalc\([^)]+\)/gm },
    ],
    transforms: [
      {
        label: 'вычисление числовых констант (Lightning CSS)',
        input:
`.el {
  width: calc(4 * 8px);
  margin: calc(10px + 0px);
  padding: calc(100% / 3);
}`,
        output:
`.el {
  width: 32px;
  margin: 10px;
  padding: 33.3333%;
}`,
      },
    ],
  },
  {
    id: 'postcss-svg',
    order: 13,
    lightning: 'none',
    recommendation: 'Rust Pre-stage (обязательный) — проверить $var в параметрах',
    patterns: [
      { label: 'svg() no params',       re: /(?<![a-z-])svg\(['"]/gm },
      { label: 'svg() with fill/rules', re: /(?<![a-z-])svg\(['"][^'"]+['"],/gm },
      { label: 'svg() fragment #id',    re: /(?<![a-z-])svg\(['"][^'"]*#[\w-]+['"]/gm },
    ],
    transforms: [
      {
        label: 'svg() → data URI inline',
        input:
`.icon {
  background: svg('icons/arrow.svg', fill: #333);
}

.logo {
  background: svg('logo.svg');
}`,
        output:
`.icon {
  background: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'...fill='%23333'...%3E");
}

.logo {
  background: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'...%3E");
}`,
      },
    ],
  },
  {
    id: 'postcss-url',
    order: 14,
    lightning: 'none',
    recommendation: 'Out of scope — rewrite-only, 12 matches, не критично',
    patterns: [
      { label: 'url() relative',   re: /url\(['"](?!data:|https?:\/\/|\/\/)[^/'"#][^'"]*['"]\)/gm },
      { label: 'url() absolute',   re: /url\(['"]\/[^'"]+['"]\)/gm },
      { label: 'url() external',   re: /url\(['"]https?:\/\/[^'"]+['"]\)/gm },
      { label: 'url() data:',      re: /url\(['"]data:/gm },
    ],
  },
  {
    id: 'postcss-svg-fallback',
    order: 15,
    lightning: 'none',
    recommendation: 'Rust Post-stage (опциональный) — нет usage в реальных проектах',
    patterns: [
      { label: 'SVG in url() (non-data)', re: /url\(['"](?!data:)[^'"]*\.svg['"]\)/gm },
    ],
  },
  {
    id: 'postcss-color-rgba-fallback',
    order: 16,
    lightning: 'none',
    recommendation: 'Out of scope — IE8 мёртв, hex fallback не нужен',
    patterns: [
      { label: 'rgba() with numbers', re: /\brgba\(\s*\d+\s*,/gm },
      { label: 'rgba() with $var',    re: /\brgba\(\s*\$\w+/gm },
    ],
  },
  {
    id: 'autoprefixer',
    order: 17,
    lightning: 'yes',
    recommendation: 'Lightning CSS native — проверить browserslist targets mapping',
    patterns: [
      { label: 'browserslist comment', re: /browsers(?:list)?:\s*['"]/gim },
    ],
    transforms: [
      {
        label: 'вендорные префиксы (Lightning CSS)',
        input:
`.el {
  user-select: none;
  appearance: none;
  backdrop-filter: blur(4px);
}`,
        output:
`.el {
  -webkit-user-select: none;
  user-select: none;
  -webkit-appearance: none;
  appearance: none;
  -webkit-backdrop-filter: blur(4px);
  backdrop-filter: blur(4px);
}`,
      },
    ],
  },
  {
    id: 'postcss-data-packer',
    order: 18,
    lightning: 'none',
    recommendation: 'Намеренно удалён — данные inline в mainX.css, _data.css больше не генерируется',
    patterns: [
      { label: 'data: image inline',    re: /url\(['"]data:image\/[^'"]+['"]\)/gm },
      { label: 'data: font inline',     re: /url\(['"]data:(?:application\/|font\/)[^'"]+['"]\)/gm },
      { label: '_data.css ref (built)', re: /url\(['"][^'"]*_data\.css#/gm },
    ],
  },
].map(p => {
  const meta = pluginsMeta[p.id] ?? {};
  const description =
    (typeof meta.description === 'string' && meta.description.trim())
      ? meta.description.trim()
      : (PLUGIN_DESCRIPTIONS_RU[p.id] ?? '—');
  const recommendation = meta.recommendation ?? '—';
  const priority = meta.priority ?? '—';
  const complexity = meta.complexity ?? '—';
  return {
    ...p,
    ...meta,
    description,
    recommendation,
    priority,
    complexity,
    ...resolvePluginPackageMeta(p.id, meta),
  };
});
}

let PLUGINS = buildPlugins();

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

function findCssFiles(dir) {
  const files = [];
  if (!fs.existsSync(dir)) return files;
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.css')) files.push(full);
    }
  };
  walk(dir);
  return files;
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

function scanFiles(files) {
  const results = [];

  for (const plugin of PLUGINS) {
    const pluginResult = {
      id: plugin.id,
      order: plugin.order,
      lightning: plugin.lightning,
      priority: plugin.priority ?? '—',
      complexity: plugin.complexity ?? '—',
      recommendation: plugin.recommendation ?? '—',
      description: plugin.description ?? '—',
      npm: plugin.npm ?? null,
      npmPackage: plugin.npmPackage ?? null,
      version: plugin.version ?? '—',
      transforms: plugin.transforms ?? [],
      totalMatches: 0,
      patterns: [],
    };

    for (const pat of plugin.patterns) {
      const patResult = { label: pat.label, count: 0, examples: [], files: new Set(), fileMatches: {}, fileExamples: {} };

      for (const fileEntry of files) {
        const content = fs.readFileSync(fileEntry.abs, 'utf8');
        const relPath = fileEntry.rel;
        const matches = content.match(pat.re) ?? [];

        if (matches.length > 0) {
          patResult.count += matches.length;
          patResult.files.add(relPath);
          patResult.fileMatches[relPath] = (patResult.fileMatches[relPath] ?? 0) + matches.length;
          if (!patResult.fileExamples[relPath]) patResult.fileExamples[relPath] = [];
          const lines = content.split('\n');
          for (let li = 0; li < lines.length; li++) {
            const hit = pat.re.test(lines[li]);
            pat.re.lastIndex = 0;
            if (hit) {
              const ex = `L${li + 1}: ${lines[li].trim()}`;
              if (!patResult.fileExamples[relPath].includes(ex)) {
                patResult.fileExamples[relPath].push(ex);
              }
              if (!patResult.examples.includes(ex)) {
                patResult.examples.push(ex);
              }
            }
          }
        }
      }

      patResult.files = [...patResult.files];
      pluginResult.patterns.push(patResult);
      pluginResult.totalMatches += patResult.count;
    }

    results.push(pluginResult);
  }

  return results;
}

function scanByProject(inputDir) {
  const allFiles = findCssFiles(inputDir);
  const groups = {};
  const sources = {};

  for (const file of allFiles) {
    const rel = path.relative(inputDir, file).replace(/\\/g, '/');
    const aliasedRel = aliasRelativePath(rel);
    sources[aliasedRel] = fs.readFileSync(file, 'utf8');
    const parts = rel.split('/');
    const originalProjectName = parts.length > 1 ? parts[0] : '(root)';
    const projectName = aliasProjectName(originalProjectName);
    if (!groups[projectName]) groups[projectName] = [];
    groups[projectName].push({ abs: file, rel: aliasedRel });
  }

  const projects = {};
  for (const [name, files] of Object.entries(groups)) {
    projects[name] = {
      filesScanned: files.length,
      plugins: scanFiles(files),
    };
  }
  return { allFiles, projects, sources };
}

function aggregatePlugins(projects) {
  const merged = new Map();
  for (const project of Object.values(projects)) {
    for (const p of (project.plugins || [])) {
      if (!merged.has(p.id)) {
        merged.set(p.id, {
          id: p.id,
          order: p.order,
          lightning: p.lightning,
          priority: p.priority,
          complexity: p.complexity,
          description: (typeof p.description === 'string' && p.description.trim()) ? p.description.trim() : '—',
          npm: p.npm ?? null,
          npmPackage: p.npmPackage ?? null,
          version: p.version ?? '—',
          totalMatches: 0,
        });
      }
      const row = merged.get(p.id);
      row.totalMatches += Number(p.totalMatches || 0);
    }
  }
  return [...merged.values()].sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
}

// ---------------------------------------------------------------------------
// Render: Markdown
// ---------------------------------------------------------------------------

function renderMarkdown(projects, generatedDate) {
  const now = generatedDate.slice(0, 10);
  const totalFiles = Object.values(projects).reduce((s, p) => s + p.filesScanned, 0);
  const projectCount = Object.keys(projects).length;
  const results = aggregatePlugins(projects);

  let md = `# Аудит плагинов\n\n`;
  md += `Сформировано: ${now}  \n`;
  md += `Проверено файлов: ${totalFiles} CSS в ${projectCount} проект(ах)  \n`;
  md += `Каталог входных данных: \`${INPUT_DIR}\`\n\n`;
  md += `---\n\n`;
  md += `## Сводка (все проекты)\n\n`;
  md += `| Порядок | Плагин | Совпадения | Lightning CSS | Приоритет | Сложность |\n`;
  md += `|---|---|---:|---|---|---|\n`;
  for (const r of results) {
    md += `| ${r.order} | ${r.id} | ${r.totalMatches} | ${r.lightning} | ${r.priority} | ${r.complexity} |\n`;
  }

  return md;
}

// ---------------------------------------------------------------------------
// Render: HTML
// ---------------------------------------------------------------------------

function renderHtml(projects, sources, generatedDate) {
  const safeData = JSON.stringify({ generated: generatedDate, projects, sources })
    .replace(/<\/script>/gi, '<\\/script>');

  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>intcss Аудит плагинов</title>
<script>
try {
  if (localStorage.getItem('plugin-audit-theme') === 'dark') {
    document.documentElement.classList.add('dark');
  }
} catch {}
</script>
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='0' y1='0' x2='1' y2='1'%3E%3Cstop offset='0%25' stop-color='%23488BFF'/%3E%3Cstop offset='100%25' stop-color='%2379B4FF'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect x='4' y='4' width='56' height='56' rx='14' fill='url(%23g)'/%3E%3Ctext x='32' y='39' text-anchor='middle' font-family='Arial,sans-serif' font-size='22' font-weight='700' fill='white'%3EPA%3C/text%3E%3C/svg%3E">
<link rel="shortcut icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='0' y1='0' x2='1' y2='1'%3E%3Cstop offset='0%25' stop-color='%23488BFF'/%3E%3Cstop offset='100%25' stop-color='%2379B4FF'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect x='4' y='4' width='56' height='56' rx='14' fill='url(%23g)'/%3E%3Ctext x='32' y='39' text-anchor='middle' font-family='Arial,sans-serif' font-size='22' font-weight='700' fill='white'%3EPA%3C/text%3E%3C/svg%3E">
<link rel="apple-touch-icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='0' y1='0' x2='1' y2='1'%3E%3Cstop offset='0%25' stop-color='%23488BFF'/%3E%3Cstop offset='100%25' stop-color='%2379B4FF'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect x='4' y='4' width='56' height='56' rx='14' fill='url(%23g)'/%3E%3Ctext x='32' y='39' text-anchor='middle' font-family='Arial,sans-serif' font-size='22' font-weight='700' fill='white'%3EPA%3C/text%3E%3C/svg%3E">
<style>
:root {
  --bg: #eef3f8; --surface: #fff; --border: #d3dde9; --text: #132238;
  --muted: #5c7088; --accent: #006adc; --surface-soft:#f4f7fc;
  --hover:#eaf1f8; --focus-ring:rgba(0,106,220,.28);
  --critical-bg: #fee2e2; --critical: #dc2626;
  --high-bg: #fff7ed;     --high: #c2410c;
  --native-bg: #dcfce7;   --native: #15803d;
  --low-bg: #dbeafe;      --low: #1d4ed8;
  --scope-bg: #f1f5f9;    --scope: #64748b;
  --removed-bg: #f1f5f9;  --removed: #94a3b8;
}
html.dark {
  --bg: #0b1322; --surface: #131f33; --border: #2d3f57; --text: #e2e8f0;
  --muted: #98abc4; --accent: #67b2ff; --surface-soft:#192842; --hover:#1f324d; --focus-ring:rgba(96,165,250,.35);
  --critical-bg: #450a0a; --critical: #fca5a5;
  --high-bg: #431407;     --high: #fdba74;
  --native-bg: #052e16;   --native: #86efac;
  --low-bg: #1e3a5f;      --low: #93c5fd;
  --scope-bg: #2d3f52;    --scope: #cbd5e1;
  --removed-bg: #1e293b;  --removed: #64748b;
}
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%}
body{font:14px/1.5 "Manrope",-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:var(--bg);color:var(--text);height:100%}
#app{max-width:1320px;margin:0 auto;padding:16px 14px;height:100%;display:flex;flex-direction:column;box-sizing:border-box}

header{display:flex;align-items:center;justify-content:space-between;margin-bottom:2px}
.hdr-title{display:flex;align-items:baseline;gap:10px}
h1{font-size:22px;font-weight:800;letter-spacing:-.3px;line-height:1.2}
.hdr-sub{font-size:12px;color:var(--muted)}
.hdr-meta{font-size:11px;color:var(--muted);white-space:nowrap}
.hdr-right{display:flex;align-items:center;gap:10px}
.export-option{width:100%;border:0;background:transparent;text-align:right;justify-content:flex-end}
.theme-btn{width:32px;height:32px;border:1px solid var(--border);border-radius:6px;background:var(--surface);cursor:pointer;font-size:16px;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:border-color .15s;line-height:1}
.theme-btn:hover{border-color:var(--accent)}
.theme-btn:focus-visible,.proj-trigger:focus-visible,.vbtn:focus-visible,.fptab:focus-visible,.toggle-zero input:focus-visible{outline:none;box-shadow:0 0 0 3px var(--focus-ring)}

.top-panel{display:flex;flex-direction:column;gap:12px;margin-bottom:8px;padding:14px;border:1px solid var(--border);border-radius:14px;background:radial-gradient(120% 160% at 0% 0%,rgba(0,106,220,.14),rgba(0,106,220,0) 48%),var(--surface);box-shadow:0 10px 24px rgba(18,38,63,.12)}
.controls{display:flex;flex-direction:column;gap:10px;margin-bottom:0}
.ctrl-group{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.ctrl-label{font-size:11px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.4px;white-space:nowrap;min-width:64px}
#files-plugin-ctrl{display:flex;flex-direction:column;align-items:stretch;gap:4px;min-width:220px;max-width:320px;width:100%}
#files-plugin-ctrl .ctrl-label{min-width:0}
#files-plugin-ctrl .proj-dropdown{width:100%}
#files-plugin-ctrl .proj-trigger{width:100%;max-width:none}

.proj-dropdown{position:relative}
.proj-trigger{padding:6px 10px;border:1px solid var(--border);border-radius:8px;background:var(--surface);font-size:13px;cursor:pointer;display:flex;align-items:center;gap:6px;white-space:nowrap;max-width:260px;transition:border-color .15s,color .15s,background-color .15s;color:var(--text)}
.proj-trigger:hover{border-color:var(--accent)}
.proj-trigger .trigger-clear{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:50%;border:1px solid var(--border);color:var(--muted);background:transparent;font-size:10px;line-height:1;cursor:pointer;flex:0 0 16px;opacity:0;visibility:hidden;pointer-events:none;transition:opacity .12s ease}
.proj-trigger .trigger-clear.is-visible{opacity:1;visibility:visible;pointer-events:auto}
.proj-trigger .trigger-clear:hover{border-color:var(--accent);color:var(--accent)}
.proj-trigger .trigger-clear:focus-visible{outline:none;box-shadow:0 0 0 2px var(--focus-ring)}
.proj-trigger .trigger-arrow{margin-left:auto;color:var(--muted);font-size:10px}
.proj-panel{position:absolute;top:calc(100% + 4px);left:0;min-width:200px;max-width:320px;max-height:min(360px,50vh);background:var(--surface);border:1px solid var(--border);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.12);z-index:100;overflow-x:hidden;overflow-y:auto;display:none}
html.dark .proj-panel{box-shadow:0 8px 24px rgba(0,0,0,.4)}
.proj-panel{scrollbar-width:thin;scrollbar-color:var(--border) transparent}
.proj-panel::-webkit-scrollbar{width:8px;height:8px}
.proj-panel::-webkit-scrollbar-track{background:transparent}
.proj-panel::-webkit-scrollbar-thumb{background:var(--border);border-radius:8px;border:2px solid transparent;background-clip:padding-box}
.proj-panel::-webkit-scrollbar-thumb:hover{background:var(--muted);background-clip:padding-box}
.proj-panel.open{display:block}
#export-panel{left:auto;right:0;min-width:220px;max-width:260px}
.proj-option{display:flex;align-items:center;gap:8px;padding:8px 12px;cursor:pointer;font-size:13px;transition:background .1s;color:var(--text)}
.proj-option:hover{background:var(--hover)}
.proj-option input[type="checkbox"]{cursor:pointer;accent-color:var(--accent)}
.proj-option.all-option{border-bottom:1px solid var(--border);font-weight:600;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.4px}

.ctrl-group--filters{display:grid;grid-template-columns:minmax(220px,280px) minmax(220px,280px) minmax(220px,280px) auto;align-items:end;gap:10px 12px}
.select-field{display:flex;flex-direction:column;gap:4px;min-width:0}
.select-field .ctrl-label{min-width:0}
.select-field .proj-dropdown{width:100%}
.select-field .proj-trigger{width:100%;max-width:none}
.select-meta{font-size:11px;color:var(--muted);line-height:1.25}
.plugins-export-wrap{justify-self:end;align-self:end;margin-left:auto}
#plugins-export-dropdown .proj-panel{right:0;left:auto}
.export-option{white-space:nowrap}
#plugins-export-dropdown .proj-trigger{max-width:none;min-width:112px;background:var(--accent);border-color:var(--accent);color:#fff}
#plugins-export-dropdown .proj-trigger .trigger-arrow{color:rgba(255,255,255,.9)}
#plugins-export-dropdown .proj-trigger:hover{filter:brightness(1.06)}
.search-input{padding:4px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);font-size:13px;width:180px;transition:border-color .15s}
.search-input:focus{outline:none;border-color:var(--accent)}
.search-input::placeholder{color:var(--muted)}
.expand-all-btn{padding:4px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--muted);font-size:12px;cursor:pointer;transition:border-color .15s,color .15s;white-space:nowrap}
.expand-all-btn:hover{border-color:var(--accent);color:var(--text)}

.view-toggle{display:inline-flex;gap:4px;margin-bottom:2px;padding:3px;border:1px solid var(--border);border-radius:10px;background:var(--surface-soft);width:max-content}
.vbtn{padding:6px 16px;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--muted);cursor:pointer;font-size:13px;font-weight:600;transition:all .15s}
.vbtn:hover{border-color:var(--accent);color:var(--text)}
.vbtn.active{background:var(--accent);color:#fff;border-color:var(--accent)}
@media (max-width: 980px){
  .ctrl-group--filters{grid-template-columns:1fr 1fr}
  .select-field--project{grid-column:1 / -1}
  .plugins-export-wrap{grid-column:1 / -1;justify-self:end}
}
@media (max-width: 640px){
  #app{padding:12px 10px}
  .top-panel{padding:12px}
  .controls{gap:8px}
  .ctrl-group--filters{grid-template-columns:1fr}
  .proj-trigger{max-width:100%}
  .plugins-export-wrap{justify-self:stretch}
  #plugins-export-dropdown .proj-trigger{width:100%}
}
col.cf-file{width:auto}
col.cf-matches{width:124px}
col.cf-plugins{width:62%}
.plugin-chips{display:flex;gap:4px;flex-wrap:wrap}
.file-path{font-family:'SFMono-Regular',Consolas,monospace;font-size:12px}
.files-section{display:none;flex:1 1 0;min-height:0;flex-direction:column;background:var(--surface);border:1px solid var(--border);border-radius:8px;overflow:hidden}
.files-proj-tabs{display:flex;gap:4px;padding:8px 12px;border-bottom:1px solid var(--border);flex-shrink:0;flex-wrap:wrap}
.fptab{padding:4px 12px;border:1px solid var(--border);border-radius:5px;background:transparent;color:var(--muted);cursor:pointer;font-size:12px;font-weight:500;transition:all .15s}
.fptab:hover{border-color:var(--accent);color:var(--text)}
.fptab.active{background:var(--accent);color:#fff;border-color:var(--accent)}
.files-tbl-wrap{flex:1 1 0;min-height:0;overflow:auto;scrollbar-width:thin;scrollbar-color:var(--border) transparent}
.files-tbl-wrap::-webkit-scrollbar{width:6px;height:6px}
.files-tbl-wrap::-webkit-scrollbar-track{background:transparent}
.files-tbl-wrap::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px}
.files-tbl-wrap::-webkit-scrollbar-thumb:hover{background:var(--muted)}
#files-table thead th{position:sticky;top:0;z-index:10;background:var(--bg);padding:9px 12px;text-align:left;font-size:11px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;border-bottom:1px solid var(--border)}
#files-table col.cf-exp{width:32px}
#files-table tbody td{padding:10px 12px;border-bottom:1px solid var(--border);vertical-align:baseline}
#files-table tbody td:nth-child(3){vertical-align:baseline;text-align:left}
#files-table thead th:nth-child(3){text-align:left}
#files-table tbody td.exp-col{padding:10px 8px;text-align:center;color:var(--muted);vertical-align:baseline}
#files-table thead th:first-child{left:0;z-index:13}
#files-table thead th:nth-child(2){left:32px;z-index:12}
#files-table tbody tr.fr td:first-child{position:sticky;left:0;z-index:7;background:var(--surface)}
#files-table tbody tr.fr td:nth-child(2){position:sticky;left:32px;z-index:6;background:var(--surface)}
#files-table tbody tr.fr:hover td:first-child,
#files-table tbody tr.fr:hover td:nth-child(2),
#files-table tbody tr.fr.open td:first-child,
#files-table tbody tr.fr.open td:nth-child(2){background:var(--hover)}
tr.fr{cursor:pointer}
tr.fr:hover td{background:var(--hover)}
tr.fr.open td{background:var(--hover)}
tr.fdr>td{padding:0}
.file-detail{padding:12px 16px 16px;background:var(--bg);border-bottom:1px solid var(--border)}
.fd-plugin{margin-bottom:14px}
.fd-plugin:last-child{margin-bottom:0}
.fd-plugin-label{display:flex;align-items:center;gap:8px;margin-bottom:8px}
.fd-plugin-count{font-size:12px;color:var(--muted)}
.fd-pat{margin-left:8px;margin-bottom:8px}
.fd-code{display:block;font-family:'SFMono-Regular',Consolas,monospace;font-size:12px;background:var(--surface);border:1px solid var(--border);border-radius:4px;padding:4px 8px;margin-bottom:4px;white-space:pre-wrap;word-break:break-all;color:var(--text)}
.fd-code.src-jump{width:100%;text-align:left;cursor:pointer}
.fd-code.src-jump:hover{border-color:var(--accent);color:var(--accent)}
.fd-no-ex{font-size:12px;color:var(--muted);margin-left:8px}
.sources-section{display:none;flex:1 1 0;min-height:0;flex-direction:column;background:var(--surface);border:1px solid var(--border);border-radius:8px;overflow:hidden}
.sources-proj-tabs{display:flex;gap:4px;padding:8px 12px;border-bottom:1px solid var(--border);flex-shrink:0;flex-wrap:wrap}
.sources-body{display:grid;grid-template-columns:320px 1fr;min-height:0;flex:1 1 0}
.sources-list{border-right:1px solid var(--border);overflow:auto;padding:8px;scrollbar-width:thin;scrollbar-color:var(--border) transparent}
.sources-list::-webkit-scrollbar{width:8px;height:8px}
.sources-list::-webkit-scrollbar-track{background:transparent}
.sources-list::-webkit-scrollbar-thumb{background:var(--border);border-radius:6px}
.sources-list::-webkit-scrollbar-thumb:hover{background:var(--muted)}
.src-file-btn{display:block;width:100%;text-align:left;padding:6px 8px;border:1px solid transparent;border-radius:6px;background:transparent;color:var(--text);cursor:pointer;font:12px/1.4 'SFMono-Regular',Consolas,monospace}
.src-file-btn:hover{border-color:var(--accent);background:var(--hover)}
.src-file-btn.active{border-color:var(--accent);background:var(--hover)}
.source-view{min-height:0;overflow:auto;background:var(--bg);scrollbar-width:thin;scrollbar-color:var(--border) transparent}
.source-view::-webkit-scrollbar{width:10px;height:10px}
.source-view::-webkit-scrollbar-track{background:transparent}
.source-view::-webkit-scrollbar-thumb{background:var(--border);border-radius:8px}
.source-view::-webkit-scrollbar-thumb:hover{background:var(--muted)}
.source-head{position:sticky;top:0;z-index:2;padding:8px 10px;border-bottom:1px solid var(--border);background:var(--surface);font:12px/1.4 'SFMono-Regular',Consolas,monospace;color:var(--muted)}
.source-code{padding:8px 0 14px}
.src-line{display:grid;grid-template-columns:56px 1fr;align-items:start}
.src-ln{padding:0 10px;text-align:right;color:var(--muted);user-select:none;font:12px/1.5 'SFMono-Regular',Consolas,monospace}
.src-txt{padding-right:12px;white-space:pre-wrap;word-break:break-word;font:12px/1.5 'SFMono-Regular',Consolas,monospace;color:var(--text)}
.src-line.hit .src-ln,.src-line.hit .src-txt{background:rgba(0,106,220,.14)}
.src-txt .tok-comment{color:#6b87a5}
.src-txt .tok-string{color:#95d79a}
.src-txt .tok-atrule{color:#7ec2ff}
.src-txt .tok-var{color:#f4b56e}
.src-txt .tok-num{color:#eed18a}
.src-txt .tok-prop{color:#a9c9ff}
.src-txt .tok-punc{color:#8fa4c3}
@media (max-width: 980px){
  .sources-body{grid-template-columns:1fr}
  .sources-list{max-height:180px;border-right:none;border-bottom:1px solid var(--border)}
}
.research-section{display:none;flex:1 1 0;min-height:0;background:var(--surface);border:1px solid var(--border);border-radius:8px;overflow:hidden}
.research-content{position:relative;min-height:0;overflow:auto;padding:26px 28px 32px;scrollbar-width:thin;scrollbar-color:var(--border) transparent}
.research-content::-webkit-scrollbar{width:8px;height:8px}
.research-content::-webkit-scrollbar-thumb{background:var(--border);border-radius:8px}
.research-toolbar{position:sticky;top:0;z-index:5;display:flex;justify-content:flex-end;align-items:flex-start;height:0;margin:0;padding:0;background:transparent;border:none;pointer-events:none}
.research-copy-btn{margin-left:auto;background:transparent;border-color:transparent;box-shadow:none;pointer-events:auto}
.research-copy-btn:hover{background:transparent;border-color:transparent;color:var(--accent)}
.research-copy-btn:focus-visible{background:transparent}
.research-copy-btn:disabled{opacity:.55;cursor:not-allowed}
.research-copy-btn svg{display:block;width:18px;height:18px}
.research-state{padding:14px 16px;border:1px dashed var(--border);border-radius:12px;background:var(--bg);font-size:13px;line-height:1.55;color:var(--muted)}
.research-state.error{color:#b91c1c;border-color:rgba(185,28,28,.28);background:rgba(185,28,28,.06)}
.research-doc,.research-state{padding-right:58px}
.research-doc{max-width:none;width:100%}
.research-doc h1,.research-doc h2,.research-doc h3,.research-doc h4{line-height:1.2;letter-spacing:-.02em;margin:1.4em 0 .6em}
.research-doc h1:first-child,.research-doc h2:first-child,.research-doc h3:first-child,.research-doc h4:first-child{margin-top:0}
.research-doc h1{font-size:30px}
.research-doc h2{font-size:24px}
.research-doc h3{font-size:20px}
.research-doc h4{font-size:17px}
.research-doc p,.research-doc ul,.research-doc ol,.research-doc blockquote,.research-doc pre{margin:0 0 1em}
.research-doc ul,.research-doc ol{padding-left:1.7em;margin-left:0}
.research-doc li{padding-left:.15em}
.research-doc li + li{margin-top:.35em}
.research-doc li > ul,.research-doc li > ol{margin-top:.45em;margin-bottom:.2em}
.research-doc hr{height:1px;border:none;background:var(--border);margin:1.5em 0}
.research-doc a{color:var(--accent)}
.research-doc a:hover{color:var(--text)}
.research-doc code{padding:.12em .38em;border-radius:6px;background:var(--surface-soft);border:1px solid var(--border);font:12px/1.4 'SFMono-Regular',Consolas,monospace}
.research-doc pre{padding:14px 16px;border-radius:14px;background:#0f172a;color:#e2e8f0;overflow:auto}
.research-doc pre code{padding:0;border:none;background:transparent;color:inherit}
.research-doc blockquote{padding:12px 14px;border-left:4px solid var(--accent);background:var(--surface-soft);border-radius:0 12px 12px 0;color:var(--muted)}
@media (max-width: 640px){
  .research-content{padding:18px 16px 22px}
  .research-doc,.research-state{padding-right:48px}
  .research-doc h1{font-size:26px}
  .research-doc h2{font-size:22px}
  .research-doc h3{font-size:18px}
}
.tbl-wrap{background:var(--surface);border:1px solid var(--border);border-radius:8px;overflow-y:auto;overflow-x:hidden;flex:1 1 0;min-height:0;scrollbar-width:thin;scrollbar-color:var(--border) transparent}
.tbl-wrap::-webkit-scrollbar{width:6px;height:6px}
.tbl-wrap::-webkit-scrollbar-track{background:transparent}
.tbl-wrap::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px}
.tbl-wrap::-webkit-scrollbar-thumb:hover{background:var(--muted)}
table{width:100%;max-width:100%;border-collapse:collapse;table-layout:fixed}
col.c-order{width:60px}
col.c-plugin{width:auto}
col.c-lightning{width:145px}
col.c-complexity{width:130px}
col.c-priority{width:160px}
col.c-matches{width:95px}
thead th{position:sticky;top:0;z-index:10;background:var(--bg);padding:9px 12px;text-align:left;font-size:11px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;border-bottom:1px solid var(--border);cursor:pointer;white-space:nowrap;user-select:none}
thead th:hover{color:var(--text)}
thead th.sorted{color:var(--accent)}
thead th .sort-arrow{margin-left:4px;opacity:.5}
thead th.sorted .sort-arrow{opacity:1}
#plugins-table thead th:first-child{left:0;z-index:13}
#plugins-table thead th:nth-child(2){left:60px;z-index:12}
#plugins-table tbody tr.pr td:first-child{position:sticky;left:0;z-index:7;background:var(--surface)}
#plugins-table tbody tr.pr td:nth-child(2){position:sticky;left:60px;z-index:6;background:var(--surface)}
#plugins-table tbody tr.pr:hover td:first-child,
#plugins-table tbody tr.pr:hover td:nth-child(2),
#plugins-table tbody tr.pr.open td:first-child,
#plugins-table tbody tr.pr.open td:nth-child(2){background:var(--hover)}

tbody tr.pr{cursor:pointer}
tbody tr.pr:hover td{background:var(--hover)}
tbody tr.pr.open td{background:var(--hover)}
tbody tr.pr td{padding:10px 12px;border-bottom:1px solid var(--border);vertical-align:baseline}
tbody tr.dr td{padding:0;border-bottom:1px solid var(--border)}
tbody tr.hidden{display:none}

.exp-icon{display:inline-block;width:14px;font-size:10px;color:var(--muted);transition:transform .15s}
.open .exp-icon{transform:rotate(90deg)}

.plugin-name{font-weight:500}
.plugin-order{font-size:11px;color:var(--muted);margin-left:4px}

.badge{display:inline-flex;gap:4px;align-items:center;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;white-space:nowrap}
.count-muted,.muted-count{opacity:.65;font-weight:400}
.p-critical{background:var(--critical-bg);color:var(--critical)}
.p-high{background:var(--high-bg);color:var(--high)}
.p-native{background:var(--native-bg);color:var(--native)}
.p-out-of-scope{background:var(--scope-bg);color:var(--scope)}
.p-removed{background:var(--removed-bg);color:var(--removed)}
.cx-trivial{background:var(--native-bg);color:var(--native)}
.cx-low{background:var(--low-bg);color:var(--low)}
.cx-medium{background:var(--high-bg);color:var(--high)}
.cx-high{background:var(--critical-bg);color:var(--critical)}
.cx-na{background:var(--scope-bg);color:var(--scope)}

.l-yes{background:var(--native-bg);color:var(--native)}
.l-none{background:var(--critical-bg);color:var(--critical)}
.l-partial{background:var(--high-bg);color:var(--high)}

.pbadge{cursor:pointer}
.pbadge:hover{opacity:.75}
.pbadge:active{opacity:.6}

.matches{font-weight:600}
.matches-zero{color:var(--muted);font-weight:400}

.detail{padding:14px 16px 16px 38px;background:var(--bg);display:grid;gap:10px;overflow-x:hidden}
.d-section{margin-bottom:0;padding:10px 12px;border:1px solid var(--border);border-radius:8px;background:var(--surface)}
.d-label{font-size:11px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:5px}
.pats{display:flex;gap:6px;flex-wrap:wrap}
.pat-chip{background:var(--bg);border:1px solid var(--border);border-radius:5px;padding:3px 8px;font-size:12px}
.pat-chip .pcl{color:var(--muted)}
.pat-chip .pcc{font-weight:600;margin-left:3px}
.files-txt{font-size:12px;color:var(--muted);line-height:1.6;display:flex;flex-wrap:wrap;gap:6px}
.files-txt code{background:var(--bg);border:1px solid var(--border);border-radius:3px;padding:0 3px;font-family:'SFMono-Regular',Consolas,monospace;color:var(--text);font-size:11px}
.files-txt .file-jump{background:var(--bg);border:1px solid var(--border);border-radius:3px;padding:2px 6px;font-family:'SFMono-Regular',Consolas,monospace;color:var(--text);font-size:11px;cursor:pointer;white-space:normal;overflow-wrap:anywhere;word-break:break-word;max-width:100%;text-align:left}
.files-txt .file-jump:hover{border-color:var(--accent);color:var(--accent)}
.files-txt .file-jump:focus-visible{outline:none;box-shadow:0 0 0 2px var(--focus-ring)}
.proj-usage-row{display:flex;flex-direction:column;gap:8px;margin-bottom:8px;padding:8px;border:1px solid var(--border);border-radius:8px;background:var(--bg)}
.proj-usage-row:last-child{margin-bottom:0}
.exs{display:flex;gap:5px;flex-wrap:wrap}
.ex-chip{background:var(--bg);border-radius:4px;padding:2px 6px;font-size:12px;font-family:'SFMono-Regular',Consolas,monospace}
.desc-txt{font-size:12px;color:var(--text);line-height:1.5}
.rec-txt{font-size:12px;color:var(--muted);font-style:italic}
.meta-link{display:inline-flex;align-items:center;text-decoration:none;color:var(--text)}
.meta-link:visited{color:var(--text)}
.meta-link:hover{border-color:var(--accent);color:var(--accent)}
.meta-link:focus-visible{outline:none;box-shadow:0 0 0 2px var(--focus-ring)}
.transforms{display:flex;flex-direction:column;gap:10px}
.tf-item-label{font-size:11px;color:var(--muted);margin-bottom:4px}
.tf-pair{display:grid;grid-template-columns:1fr 24px 1fr;gap:6px;align-items:start}
.tf-arrow{color:var(--muted);text-align:center;padding-top:5px;font-size:14px;line-height:1.5}
.tf-code{background:var(--surface);border:1px solid var(--border);border-radius:5px;padding:7px 10px;font:12px/1.5 'SFMono-Regular',Consolas,monospace;white-space:pre;overflow:auto;max-width:100%}
.tf-code.tf-in{border-left:3px solid var(--border)}
.tf-code.tf-out{border-left:3px solid var(--accent)}
.override-dot{display:inline-block;width:5px;height:5px;border-radius:50%;background:var(--accent);margin-left:4px;vertical-align:middle}
mark{background:#fef08a;color:inherit;border-radius:2px}
html.dark mark{background:#854d0e;color:#fef9c3}
.popover{position:fixed;background:var(--surface);border:1px solid var(--border);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.12);z-index:1000;min-width:170px;overflow:hidden;visibility:hidden}
html.dark .popover{box-shadow:0 8px 24px rgba(0,0,0,.4)}
.popover-row{display:flex;align-items:center;gap:8px;padding:8px 12px;cursor:pointer;font-size:13px;transition:background .1s;color:var(--text)}
.popover-row:hover{background:var(--bg)}
.popover-row.current{background:var(--bg);font-weight:600}
.hdr-actions{display:flex;align-items:center;gap:8px}
.icon-btn{display:inline-flex;align-items:center;justify-content:center;width:38px;height:38px;border-radius:10px;border:1px solid var(--border);background:var(--surface);color:var(--text);cursor:pointer;transition:border-color .15s,background .15s,transform .15s}
.icon-btn:hover{border-color:var(--accent);background:var(--hover)}
.icon-btn:focus-visible{outline:none;box-shadow:0 0 0 3px var(--focus-ring)}
.icon-btn:active{transform:translateY(1px)}
.tooltip-layer{position:fixed;left:0;top:0;z-index:2000;max-width:min(280px,calc(100vw - 24px));padding:8px 10px;border-radius:10px;background:rgba(15,23,42,.96);border:1px solid rgba(148,163,184,.22);color:#f8fafc;font-size:12px;font-weight:600;line-height:1.35;letter-spacing:.01em;box-shadow:0 14px 34px rgba(2,6,23,.35);backdrop-filter:blur(10px);pointer-events:none;opacity:0;transform:translate3d(0,6px,0) scale(.98);transition:opacity .14s ease,transform .14s ease}
.tooltip-layer.is-visible{opacity:1;transform:translate3d(0,0,0) scale(1)}
html.light .tooltip-layer{background:rgba(15,23,42,.92);border-color:rgba(71,85,105,.18)}
.settings-modal{position:fixed;inset:0;display:none;align-items:center;justify-content:center;padding:20px;background:rgba(15,23,42,.44);backdrop-filter:blur(6px);z-index:1200}
.settings-modal.open{display:flex}
.settings-dialog{width:min(540px,100%);background:var(--surface);border:1px solid var(--border);border-radius:16px;box-shadow:0 24px 80px rgba(15,23,42,.18);overflow:hidden}
html.dark .settings-dialog{box-shadow:0 24px 80px rgba(0,0,0,.45)}
.settings-head{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;padding:18px 18px 12px;border-bottom:1px solid var(--border)}
.settings-title{font-size:16px;font-weight:700;line-height:1.2}
.settings-subtitle{margin-top:4px;font-size:12px;line-height:1.45;color:var(--muted)}
.settings-close{width:36px;height:36px;padding:0;font-size:15px;line-height:1;flex:0 0 36px;border-radius:10px}
.settings-body{padding:18px;display:grid;gap:12px}
.settings-label{display:grid;gap:6px;font-size:12px;font-weight:600;color:var(--text)}
.settings-input{width:100%;height:40px;padding:8px 12px;border-radius:10px;border:1px solid var(--border);background:var(--bg);color:var(--text);font-size:13px;line-height:1.3}
.settings-input::placeholder{color:var(--muted)}
.settings-input:focus-visible{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--focus-ring)}
.settings-hint{font-size:12px;line-height:1.5;color:var(--muted)}
.settings-status{min-height:18px;font-size:11px;line-height:1.45;color:var(--muted)}
.settings-status.error{color:#b91c1c}
.settings-status.success{color:#0f766e}
.settings-actions{display:flex;justify-content:flex-end;gap:8px}
.settings-btn{display:inline-flex;align-items:center;justify-content:center;min-width:108px;height:36px;padding:6px 12px;border-radius:8px;border:1px solid var(--border);background:var(--surface);color:var(--text);font-size:13px;font-weight:600;line-height:1;cursor:pointer;transition:border-color .15s,background .15s,transform .15s}
.settings-btn:hover{border-color:var(--accent);background:var(--hover)}
.settings-btn:focus-visible{outline:none;box-shadow:0 0 0 3px var(--focus-ring)}
.settings-btn:active{transform:translateY(1px)}
.settings-btn--primary{background:var(--accent);border-color:var(--accent);color:#fff}
.settings-btn--primary:hover{filter:brightness(1.03)}
.settings-note{padding-top:12px;border-top:1px solid var(--border);font-size:11px;line-height:1.5;color:var(--muted)}

.empty-state{padding:32px;text-align:center;color:var(--muted)}
</style>
</head>
<body>
<div id="app">
  <div class="top-panel">
    <header>
      <div class="hdr-title">
        <h1>Аудит плагинов</h1>
        <span class="hdr-sub">PostCSS → Rust / Lightning CSS</span>
      </div>
      <div class="hdr-right">
        <span class="hdr-meta" id="hdr-meta"></span>
        <div class="hdr-actions">
          <button class="icon-btn" id="settings-btn" type="button" data-tooltip="Настройки" aria-label="Настройки">⚙</button>
          <button class="icon-btn" id="theme-btn" type="button" data-tooltip="Переключить тему" aria-label="Переключить тему">🌙</button>
        </div>
      </div>
    </header>
    <div class="view-toggle">
      <button class="vbtn active" data-view="plugins">Плагины</button>
      <button class="vbtn" data-view="files">Файлы</button>
      <button class="vbtn" data-view="sources">Исходники</button>
      <button class="vbtn" data-view="research">Исследование</button>
    </div>
    <div class="controls">
    <div class="select-field" id="files-plugin-ctrl" style="display:none">
      <span class="ctrl-label">Плагины</span>
      <div class="proj-dropdown" id="files-plugin-dropdown">
        <button class="proj-trigger" id="files-plugin-trigger">
          <span id="files-plugin-trigger-label">Все плагины</span>
          <span class="trigger-clear" id="files-plugin-clear" title="Сбросить фильтр" aria-label="Сбросить фильтр">✕</span>
          <span class="trigger-arrow">▾</span>
        </button>
        <div class="proj-panel" id="files-plugin-panel"></div>
      </div>
    </div>
    <div class="ctrl-group ctrl-group--filters" id="plugins-filters-ctrl">
      <label class="select-field select-field--project" for="proj-trigger">
        <span class="ctrl-label">Проект</span>
        <div class="proj-dropdown" id="proj-dropdown">
          <button class="proj-trigger" id="proj-trigger" type="button">
            <span id="proj-trigger-label">…</span>
            <span class="trigger-clear" id="proj-clear" title="Сбросить фильтр" aria-label="Сбросить фильтр">✕</span>
            <span class="trigger-arrow">▾</span>
          </button>
          <div class="proj-panel" id="proj-panel"></div>
        </div>
      </label>
      <label class="select-field" for="priority-trigger">
        <span class="ctrl-label">Приоритет</span>
        <div class="proj-dropdown" id="priority-dropdown">
          <button class="proj-trigger" id="priority-trigger" type="button">
            <span id="priority-trigger-label">Все</span>
            <span class="trigger-clear" id="priority-clear" title="Сбросить фильтр" aria-label="Сбросить фильтр">✕</span>
            <span class="trigger-arrow">▾</span>
          </button>
          <div class="proj-panel" id="priority-panel"></div>
        </div>
      </label>
      <label class="select-field" for="complexity-trigger">
        <span class="ctrl-label">Сложность</span>
        <div class="proj-dropdown" id="complexity-dropdown">
          <button class="proj-trigger" id="complexity-trigger" type="button">
            <span id="complexity-trigger-label">Все</span>
            <span class="trigger-clear" id="complexity-clear" title="Сбросить фильтр" aria-label="Сбросить фильтр">✕</span>
            <span class="trigger-arrow">▾</span>
          </button>
          <div class="proj-panel" id="complexity-panel"></div>
        </div>
      </label>
      <div class="proj-dropdown plugins-export-wrap" id="plugins-export-dropdown">
        <button class="proj-trigger" id="export-trigger" type="button" title="Скачать отчёт" aria-label="Скачать отчёт">
          <span id="export-trigger-label">Экспорт</span>
          <span class="trigger-arrow">▾</span>
        </button>
        <div class="proj-panel export-panel" id="export-panel"></div>
      </div>
    </div>
    </div>
  </div>
  <div id="plugins-section" style="display:flex;flex-direction:column;flex:1 1 0;min-height:0">
    <div class="tbl-wrap">
      <table id="plugins-table">
        <colgroup>
          <col class="c-order"><col class="c-plugin"><col class="c-lightning"><col class="c-complexity"><col class="c-priority"><col class="c-matches">
        </colgroup>
        <thead id="thead"></thead>
        <tbody id="tbody"></tbody>
      </table>
    </div>
  </div>
  <div class="settings-modal" id="settings-modal" aria-hidden="true">
    <div class="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
      <div class="settings-head">
        <div>
          <div class="settings-title" id="settings-title">Настройки отчёта</div>
          <div class="settings-subtitle">Подключите внешние JSON, чтобы подгружать реальные названия проектов и данные по плагинам.</div>
        </div>
        <button class="icon-btn settings-close" id="settings-close-btn" type="button" data-tooltip="Закрыть окно" aria-label="Закрыть окно">✕</button>
      </div>
      <div class="settings-body">
        <label class="settings-label" for="project-map-url-input">
          URL JSON с названиями проектов
          <input class="settings-input" id="project-map-url-input" type="url" inputmode="url" placeholder="https://example.com/project-names.json" />
        </label>
        <label class="settings-label" for="plugins-meta-url-input">
          URL JSON с данными по плагинам
          <input class="settings-input" id="plugins-meta-url-input" type="url" inputmode="url" placeholder="https://example.com/plugins-meta.json" />
        </label>
        <label class="settings-label" for="research-md-url-input">
          URL Markdown-файла для вкладки "Исследование"
          <input class="settings-input" id="research-md-url-input" type="url" inputmode="url" placeholder="https://example.com/research.md" />
        </label>
        <div class="settings-note">URL сохраняется только локально в браузере через <code>localStorage</code> для этого отчёта.</div>
        <div class="settings-status" id="settings-status"></div>
        <div class="settings-actions">
          <button class="settings-btn" id="settings-clear-btn" type="button">Очистить</button>
          <button class="settings-btn settings-btn--primary" id="settings-save-btn" type="button">Сохранить</button>
        </div>
      </div>
    </div>
  </div>
  <div id="files-section" class="files-section">
    <div class="files-proj-tabs" id="files-proj-tabs"></div>
    <div class="files-tbl-wrap">
      <table id="files-table" style="width:100%;border-collapse:collapse;table-layout:fixed">
        <colgroup>
          <col class="cf-exp"><col class="cf-file"><col class="cf-matches"><col class="cf-plugins">
        </colgroup>
        <thead id="files-thead"></thead>
        <tbody id="files-tbody"></tbody>
      </table>
    </div>
  </div>
  <div id="sources-section" class="sources-section">
    <div class="sources-proj-tabs" id="sources-proj-tabs"></div>
    <div class="sources-body">
      <div class="sources-list" id="sources-list"></div>
      <div class="source-view" id="source-view">
        <div class="source-head" id="source-head">Файл не выбран</div>
        <div class="source-code" id="source-code"></div>
      </div>
    </div>
  </div>
  <div id="research-section" class="research-section">
    <div class="research-content">
      <div class="research-toolbar">
        <button class="icon-btn research-copy-btn" id="research-copy-btn" type="button" data-tooltip="Скопировать Markdown" aria-label="Скопировать Markdown">
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path fill="currentColor" d="M9 7a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-1v-2h1V7h-8v1H9V7Zm-4 4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-8Zm2 0v8h8v-8H7Z"/>
          </svg>
        </button>
      </div>
      <div class="research-state" id="research-state">Markdown-файл ещё не подключён.</div>
      <article class="research-doc" id="research-doc" hidden></article>
    </div>
  </div>
</div>
<script>
const DATA = ${safeData};

const PRIORITY_CYCLE = ['critical','high','native','out-of-scope','removed','—'];
const PRIORITY_LABEL = {
  critical: 'Критический', high: 'Высокий',
  native: 'Нативный', 'out-of-scope': 'Не рассматривается', removed: 'Удален', '—': '—'
};
const PRIORITY_WEIGHT = {critical:0,high:1,native:2,'out-of-scope':3,removed:4,'—':5};
const LIGHTNING_LABEL = {yes:'Нативно', none:'Нет', partial:'Частично'};
const COMPLEXITY_LABEL = {trivial:'Минимальная', low:'Низкая', medium:'Средняя', high:'Высокая', 'n/a':'Без оценки', '—':'—'};
const COMPLEXITY_WEIGHT = {trivial:0,low:1,medium:2,high:3,'n/a':4,'—':5};

const COMPLEXITY_CYCLE = ['trivial','low','medium','high','n/a','—'];

const LS_KEY = 'plugin-audit-priorities';
const LS_COMPLEXITY_KEY = 'plugin-audit-complexities';
const LS_THEME_KEY = 'plugin-audit-theme';
const LS_PROJECT_LABELS_URL_KEY = 'plugin-audit-project-labels-url';
const LS_PLUGINS_META_URL_KEY = 'plugin-audit-plugins-meta-url';
const LS_RESEARCH_MD_URL_KEY = 'plugin-audit-research-md-url';

let projSel = new Set();
let filters = new Set();
let complexityFilters = new Set();
let sortCol = 'order';
let sortDir = 1;
let expanded = new Set();
let fileExpanded = new Set();
let filesProjKey = Object.keys(DATA.projects)[0] || '';
let filePluginFilters = new Set();
let filePluginNone = false;
let sourceProjKey = Object.keys(DATA.projects)[0] || '';
let sourceSelectedFile = '';
let sourceHighlightLine = null;
let overrides = {};
let complexityOverrides = {};
let searchQuery = '';
let popover = { id: null, el: null };
let settingsState = { open: false };
let projectLabelsUrl = '';
let projectLabels = {};
let pluginsMetaUrl = '';
let pluginsMetaOverrides = {};
let researchMdUrl = '';
let researchMarkdown = '';
let tooltipEl = null;
let tooltipTarget = null;
let researchCopyTooltipTimer = null;
let expandAll = false;
let projNone = false;
let filtersNone = false;
let complexityFiltersNone = false;

function loadOverrides() {
  try { overrides = JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch { overrides = {}; }
}
function saveOverrides() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(overrides)); } catch {}
}

function loadComplexityOverrides() {
  try { complexityOverrides = JSON.parse(localStorage.getItem(LS_COMPLEXITY_KEY) || '{}'); } catch { complexityOverrides = {}; }
}
function saveComplexityOverrides() {
  try { localStorage.setItem(LS_COMPLEXITY_KEY, JSON.stringify(complexityOverrides)); } catch {}
}

function loadTheme() {
  try { if (localStorage.getItem(LS_THEME_KEY) === 'dark') document.documentElement.classList.add('dark'); } catch {}
}
function toggleTheme() {
  const isDark = document.documentElement.classList.toggle('dark');
  try { localStorage.setItem(LS_THEME_KEY, isDark ? 'dark' : 'light'); } catch {}
  document.getElementById('theme-btn').textContent = isDark ? '☀️' : '🌙';
}

function extractProjectLabelSource(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  if (raw.projects && typeof raw.projects === 'object' && !Array.isArray(raw.projects)) return raw.projects;
  if (raw.labels && typeof raw.labels === 'object' && !Array.isArray(raw.labels)) return raw.labels;
  if (raw.aliases && typeof raw.aliases === 'object' && !Array.isArray(raw.aliases)) return raw.aliases;
  return raw;
}

function normalizeProjectLabels(raw) {
  const source = extractProjectLabelSource(raw);
  const knownProjects = new Set(Object.keys(DATA.projects || {}));
  const normalized = {};
  for (const [left, right] of Object.entries(source)) {
    const a = String(left ?? '').trim();
    const b = String(right ?? '').trim();
    if (!a || !b) continue;
    if (knownProjects.has(a)) normalized[a] = b;
    else if (knownProjects.has(b)) normalized[b] = a;
  }
  return normalized;
}

function getProjectDisplayName(projectKey) {
  return projectLabels[projectKey] || projectKey;
}

function getProjectDisplayLabel(projectKey) {
  const name = getProjectDisplayName(projectKey);
  return name === projectKey ? projectKey : name;
}

function priorityBadgeClass(value) {
  const key = String(value ?? '—');
  return key === '—' ? 'unknown' : key;
}

function complexityBadgeClass(value) {
  const key = String(value ?? '—');
  if (key === 'n/a') return 'na';
  return key === '—' ? 'unknown' : key;
}

function normalizePluginsMeta(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const source = raw.plugins && typeof raw.plugins === 'object' && !Array.isArray(raw.plugins) ? raw.plugins : raw;
  const normalized = {};
  for (const [pluginId, meta] of Object.entries(source)) {
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) continue;
    normalized[String(pluginId)] = { ...meta };
  }
  return normalized;
}

function getPluginMeta(pluginId) {
  return pluginsMetaOverrides[String(pluginId)] ?? null;
}

function getPluginField(plugin, key, fallback = '—') {
  const meta = getPluginMeta(plugin?.id);
  const fromMeta = meta?.[key];
  if (typeof fromMeta === 'string' && fromMeta.trim()) return fromMeta.trim();
  const fromPlugin = plugin?.[key];
  if (typeof fromPlugin === 'string' && fromPlugin.trim()) return fromPlugin.trim();
  return fallback;
}

function refreshProjectNameViews() {
  renderProjSel();
  renderFilesProjTabs();
  renderSourcesProjTabs();
  renderSourcesList();
  renderSourcesContent();
  renderFtabs();
  renderCxtabs();
  renderBody();
}

function normalizeResearchTitle(text) {
  const value = String(text ?? '').trim();
  let out = '';
  let prevSpace = false;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    const isSpace = code === 9 || code === 10 || code === 13 || code === 32;
    if (isSpace) {
      if (!prevSpace) out += ' ';
      prevSpace = true;
      continue;
    }
    out += value[i];
    prevSpace = false;
  }
  return out.trim() || 'Ссылка';
}

function isHttpUrl(value) {
  const url = String(value ?? '').trim().toLowerCase();
  return url.startsWith('http://') || url.startsWith('https://');
}

function escapeAttrValue(value) {
  return escHtml(String(value ?? ''));
}

function extractResearchLinks(markdown) {
  const text = String(markdown ?? '');
  const found = new Map();
  const pushLink = (href, title) => {
    const url = String(href ?? '').trim();
    if (!isHttpUrl(url) || found.has(url)) return;
    found.set(url, {
      href: url,
      title: normalizeResearchTitle(title || url),
    });
  };

  let i = 0;
  while (i < text.length) {
    if (text[i] === '[') {
      const labelEnd = text.indexOf('](', i + 1);
      if (labelEnd !== -1) {
        const urlEnd = text.indexOf(')', labelEnd + 2);
        if (urlEnd !== -1) {
          const label = text.slice(i + 1, labelEnd);
          const urlPart = text.slice(labelEnd + 2, urlEnd).trim();
          const href = urlPart.split(' ')[0] || '';
          pushLink(href, label);
          i = urlEnd + 1;
          continue;
        }
      }
    }

    if (text[i] === '<') {
      const end = text.indexOf('>', i + 1);
      if (end !== -1) {
        const href = text.slice(i + 1, end).trim();
        pushLink(href, href);
        i = end + 1;
        continue;
      }
    }

    i += 1;
  }

  return [...found.values()];
}

function replaceDelimited(text, delimiter, renderer) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const start = text.indexOf(delimiter, i);
    if (start === -1) {
      out += text.slice(i);
      break;
    }
    const end = text.indexOf(delimiter, start + delimiter.length);
    if (end === -1) {
      out += text.slice(i);
      break;
    }
    out += text.slice(i, start);
    out += renderer(text.slice(start + delimiter.length, end));
    i = end + delimiter.length;
  }
  return out;
}

function renderMarkdownInline(text) {
  let out = escHtml(String(text ?? ''));
  out = replaceDelimited(out, String.fromCharCode(96), part => '<code>' + part + '</code>');
  out = replaceDelimited(out, '**', part => '<strong>' + part + '</strong>');
  out = replaceDelimited(out, '*', part => '<em>' + part + '</em>');

  const links = extractResearchLinks(text);
  for (const link of links) {
    const markdownForm = escHtml('[' + link.title + '](' + link.href + ')');
    const autoForm = escHtml('<' + link.href + '>');
    const anchor = '<a href="' + escapeAttrValue(link.href) + '" target="_blank" rel="noopener noreferrer">' + escHtml(link.title) + '</a>';
    out = out.split(markdownForm).join(anchor);
    out = out.split(autoForm).join('<a href="' + escapeAttrValue(link.href) + '" target="_blank" rel="noopener noreferrer">' + escHtml(link.href) + '</a>');
  }

  return out;
}

function isOrderedListLine(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) >= 48 && line.charCodeAt(i) <= 57) i += 1;
  return i > 0 && line.slice(i, i + 2) === '. ';
}

function getResearchLineIndent(line) {
  let width = 0;
  for (let i = 0; i < line.length; i += 1) {
    const code = line.charCodeAt(i);
    if (code === 32) {
      width += 1;
      continue;
    }
    if (code === 9) {
      width += 4;
      continue;
    }
    break;
  }
  return width;
}

function isHorizontalRuleLine(line) {
  const compact = String(line ?? '').split(' ').join('');
  if (compact.length < 3) return false;
  if (compact === '-'.repeat(compact.length)) return true;
  if (compact === '*'.repeat(compact.length)) return true;
  return compact === '_'.repeat(compact.length);
}

function hasResearchContent() {
  return String(researchMarkdown ?? '').trim().length > 0;
}

function syncResearchViewAvailability() {
  return hasResearchContent();
}

function ensureTooltip() {
  if (tooltipEl) return tooltipEl;
  tooltipEl = document.createElement('div');
  tooltipEl.className = 'tooltip-layer';
  tooltipEl.setAttribute('role', 'tooltip');
  tooltipEl.hidden = true;
  document.body.appendChild(tooltipEl);
  return tooltipEl;
}

function hideTooltip() {
  if (!tooltipEl) return;
  tooltipTarget = null;
  tooltipEl.hidden = true;
  tooltipEl.classList.remove('is-visible');
}

function positionTooltip(target) {
  if (!tooltipEl || !target || tooltipEl.hidden) return;
  const rect = target.getBoundingClientRect();
  const tipRect = tooltipEl.getBoundingClientRect();
  const gap = 10;
  const minX = 12;
  const maxX = window.innerWidth - tipRect.width - 12;
  let left = rect.left + rect.width / 2 - tipRect.width / 2;
  if (Number.isFinite(maxX)) left = Math.min(Math.max(left, minX), Math.max(minX, maxX));
  let top = rect.top - tipRect.height - gap;
  if (top < 12) top = rect.bottom + gap;
  tooltipEl.style.left = Math.round(left) + 'px';
  tooltipEl.style.top = Math.round(top) + 'px';
}

function showTooltip(target) {
  const text = target && target.dataset ? String(target.dataset.tooltip || '').trim() : '';
  if (!target || !text) {
    hideTooltip();
    return;
  }
  const el = ensureTooltip();
  tooltipTarget = target;
  el.textContent = text;
  el.hidden = false;
  positionTooltip(target);
  requestAnimationFrame(() => {
    if (tooltipTarget === target && tooltipEl) tooltipEl.classList.add('is-visible');
  });
}

function initTooltips() {
  ensureTooltip();
  document.querySelectorAll('[title]').forEach(el => {
    const title = String(el.getAttribute('title') || '').trim();
    if (!title) return;
    if (!el.dataset.tooltip) el.dataset.tooltip = title;
    el.removeAttribute('title');
  });
  document.addEventListener('pointerover', e => {
    const target = e.target instanceof Element ? e.target.closest('[data-tooltip]') : null;
    if (!target || target.hasAttribute('disabled')) return;
    showTooltip(target);
  });
  document.addEventListener('pointerout', e => {
    if (!tooltipTarget) return;
    const current = e.target instanceof Element ? e.target.closest('[data-tooltip]') : null;
    const next = e.relatedTarget instanceof Element ? e.relatedTarget.closest('[data-tooltip]') : null;
    if (current === tooltipTarget && next !== tooltipTarget) {
      if (current && current.id === 'research-copy-btn') resetResearchCopyTooltip();
      hideTooltip();
    }
  });
  document.addEventListener('focusin', e => {
    const target = e.target instanceof Element ? e.target.closest('[data-tooltip]') : null;
    if (!target || target.hasAttribute('disabled')) return;
    showTooltip(target);
  });
  document.addEventListener('focusout', e => {
    const target = e.target instanceof Element ? e.target.closest('[data-tooltip]') : null;
    if (target && target.id === 'research-copy-btn') resetResearchCopyTooltip();
    if (target && target === tooltipTarget) hideTooltip();
  });
  window.addEventListener('scroll', () => {
    if (tooltipTarget) positionTooltip(tooltipTarget);
  }, true);
  window.addEventListener('resize', hideTooltip);
}

function setResearchCopyState(message = '', disabled = false) {
  const btn = document.getElementById('research-copy-btn');
  if (researchCopyTooltipTimer) {
    clearTimeout(researchCopyTooltipTimer);
    researchCopyTooltipTimer = null;
  }
  if (btn) btn.disabled = disabled;
  if (btn) btn.dataset.tooltip = message || 'Скопировать Markdown';
  if (btn) btn.dataset.tooltipDefault = message || 'Скопировать Markdown';
  if (btn) btn.setAttribute('aria-label', message || 'Скопировать Markdown');
  if (btn && tooltipTarget === btn) showTooltip(btn);
}

function resetResearchCopyTooltip() {
  const btn = document.getElementById('research-copy-btn');
  if (researchCopyTooltipTimer) {
    clearTimeout(researchCopyTooltipTimer);
    researchCopyTooltipTimer = null;
  }
  if (!btn) return;
  const next = btn.dataset.tooltipDefault || 'Скопировать Markdown';
  btn.dataset.tooltip = next;
  if (tooltipTarget === btn) showTooltip(btn);
}

function flashResearchCopyTooltip(message) {
  const btn = document.getElementById('research-copy-btn');
  if (!btn) return;
  if (researchCopyTooltipTimer) clearTimeout(researchCopyTooltipTimer);
  btn.dataset.tooltip = message;
  if (tooltipTarget === btn) showTooltip(btn);
  researchCopyTooltipTimer = setTimeout(() => {
    researchCopyTooltipTimer = null;
    resetResearchCopyTooltip();
  }, 1400);
}

async function copyResearchMarkdown() {
  if (!hasResearchContent()) {
    setResearchCopyState('Сначала загрузите Markdown-файл.', true);
    return;
  }

  const text = String(researchMarkdown ?? '');
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', 'readonly');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      document.execCommand('copy');
      area.remove();
    }
    flashResearchCopyTooltip('Скопировано');
  } catch (error) {
    flashResearchCopyTooltip('Не удалось скопировать');
  }
}

function renderResearchMarkdown(markdown) {
  const text = String(markdown ?? '').replaceAll(String.fromCharCode(13) + String.fromCharCode(10), String.fromCharCode(10)).replaceAll(String.fromCharCode(13), String.fromCharCode(10));
  const lines = text.split(String.fromCharCode(10));
  const html = [];
  let paragraph = [];
  const listStack = [];
  let codeLines = [];
  let inCode = false;
  const fence = String.fromCharCode(96, 96, 96);

  const flushParagraph = () => {
    if (!paragraph.length) return;
    html.push('<p>' + renderMarkdownInline(paragraph.join(' ')) + '</p>');
    paragraph = [];
  };
  const closeLists = (targetDepth = 0) => {
    while (listStack.length > targetDepth) {
      const current = listStack[listStack.length - 1];
      if (current.itemOpen) {
        html.push('</li>');
        current.itemOpen = false;
      }
      html.push('</' + current.type + '>');
      listStack.pop();
    }
  };
  const openListForDepth = (type, depth) => {
    while (listStack.length < depth + 1) {
      html.push('<' + type + '>');
      listStack.push({ type, itemOpen: false });
    }
    const current = listStack[depth];
    if (current.type !== type) {
      closeLists(depth);
      html.push('<' + type + '>');
      listStack.push({ type, itemOpen: false });
    }
  };
  const pushListItem = (type, depth, content, value = null) => {
    const normalizedDepth = Math.max(0, depth);
    if (normalizedDepth > listStack.length) {
      openListForDepth(type, listStack.length);
    }
    closeLists(normalizedDepth + 1);
    openListForDepth(type, normalizedDepth);
    const current = listStack[normalizedDepth];
    if (current.itemOpen) html.push('</li>');
    const valueAttr = type === 'ol' && Number.isFinite(value) ? ' value="' + value + '"' : '';
    html.push('<li' + valueAttr + '>' + renderMarkdownInline(content));
    current.itemOpen = true;
  };
  const flushCode = () => {
    if (!inCode) return;
    html.push('<pre><code>' + escHtml(codeLines.join(String.fromCharCode(10))) + '</code></pre>');
    codeLines = [];
    inCode = false;
  };

  for (const rawLine of lines) {
    const line = rawLine ?? '';
    const trimmed = line.trim();

    if (trimmed.startsWith(fence)) {
      flushParagraph();
      closeLists();
      if (inCode) flushCode();
      else inCode = true;
      continue;
    }

    if (inCode) {
      codeLines.push(line);
      continue;
    }

    if (!trimmed) {
      flushParagraph();
      closeLists();
      continue;
    }

    if (isHorizontalRuleLine(trimmed)) {
      flushParagraph();
      closeLists();
      html.push('<hr>');
      continue;
    }

    let headingLevel = 0;
    while (headingLevel < trimmed.length && trimmed[headingLevel] === '#') headingLevel += 1;
    if (headingLevel > 0 && headingLevel <= 4 && trimmed[headingLevel] === ' ') {
      flushParagraph();
      closeLists();
      html.push('<h' + headingLevel + '>' + renderMarkdownInline(trimmed.slice(headingLevel + 1)) + '</h' + headingLevel + '>');
      continue;
    }

    if (trimmed.startsWith('>')) {
      flushParagraph();
      closeLists();
      const quoteText = trimmed[1] === ' ' ? trimmed.slice(2) : trimmed.slice(1);
      html.push('<blockquote>' + renderMarkdownInline(quoteText) + '</blockquote>');
      continue;
    }

    if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      flushParagraph();
      const depth = Math.floor(getResearchLineIndent(line) / 4);
      pushListItem('ul', depth, trimmed.slice(2));
      continue;
    }

    if (isOrderedListLine(trimmed)) {
      flushParagraph();
      const dotPos = trimmed.indexOf('. ');
      const value = Number(trimmed.slice(0, dotPos));
      const depth = Math.floor(getResearchLineIndent(line) / 4);
      pushListItem('ol', depth, trimmed.slice(dotPos + 2), Number.isFinite(value) ? value : null);
      continue;
    }

    closeLists();
    paragraph.push(trimmed);
  }

  flushParagraph();
  closeLists();
  flushCode();
  return html.join('');
}

function renderResearchView() {
  const stateEl = document.getElementById('research-state');
  const docEl = document.getElementById('research-doc');
  if (!stateEl || !docEl) return;

  if (!hasResearchContent()) {
    stateEl.textContent = researchMdUrl
      ? 'Markdown ещё не загружен, пустой или недоступен. Проверьте URL в настройках.'
      : 'Чтобы открыть исследование, загрузите Markdown-файл в настройках отчёта.';
    stateEl.className = 'research-state';
    stateEl.hidden = false;
    docEl.hidden = true;
    docEl.innerHTML = '';
    setResearchCopyState(researchMdUrl ? 'Markdown недоступен для копирования.' : 'Загрузите markdown, чтобы скопировать его.', true);
    return;
  }

  docEl.innerHTML = renderResearchMarkdown(researchMarkdown);
  docEl.hidden = false;
  stateEl.hidden = true;
  setResearchCopyState('', false);
}

function setSettingsStatus(message = '', tone = '') {
  const el = document.getElementById('settings-status');
  if (!el) return;
  el.textContent = message;
  el.className = 'settings-status' + (tone ? ' ' + tone : '');
}

function openSettingsModal() {
  closeOpenPanels();
  settingsState.open = true;
  const modal = document.getElementById('settings-modal');
  modal.classList.add('open');
  modal.setAttribute('aria-hidden', 'false');
  const input = document.getElementById('project-map-url-input');
  const metaInput = document.getElementById('plugins-meta-url-input');
  const researchInput = document.getElementById('research-md-url-input');
  input.value = projectLabelsUrl;
  metaInput.value = pluginsMetaUrl;
  researchInput.value = researchMdUrl;
  setSettingsStatus(
    projectLabelsUrl || pluginsMetaUrl || researchMdUrl ? 'Текущие URL сохранены локально. Можно заменить их и перезагрузить данные.' : '',
    projectLabelsUrl || pluginsMetaUrl || researchMdUrl ? 'success' : ''
  );
  setTimeout(() => input.focus(), 0);
}

function closeSettingsModal() {
  settingsState.open = false;
  const modal = document.getElementById('settings-modal');
  modal.classList.remove('open');
  modal.setAttribute('aria-hidden', 'true');
}

async function loadProjectLabelsFromUrl(url, { silent = false } = {}) {
  const normalizedUrl = String(url ?? '').trim();
  if (!normalizedUrl) {
    projectLabels = {};
    if (!silent) setSettingsStatus('Внешний JSON отключён. Показываются алиасы из отчёта.', '');
    refreshProjectNameViews();
    return true;
  }

  try {
    if (!silent) setSettingsStatus('Загружаю JSON...', '');
    const response = await fetch(normalizedUrl, { cache: 'no-store' });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const raw = await response.json();
    const nextLabels = normalizeProjectLabels(raw);
    projectLabels = nextLabels;
    if (!silent) {
      const count = Object.keys(nextLabels).length;
      setSettingsStatus(count > 0 ? 'Названия обновлены: ' + count + ' проект(ов).' : 'JSON загружен, но совпадающих проектов не найдено.', count > 0 ? 'success' : '');
    }
    refreshProjectNameViews();
    return true;
  } catch (error) {
    projectLabels = {};
    refreshProjectNameViews();
    if (!silent) setSettingsStatus('Не удалось загрузить JSON: ' + (error instanceof Error ? error.message : String(error)), 'error');
    return false;
  }
}

async function loadPluginsMetaFromUrl(url, { silent = false } = {}) {
  const normalizedUrl = String(url ?? '').trim();
  if (!normalizedUrl) {
    pluginsMetaOverrides = {};
    if (!silent) setSettingsStatus('Внешняя meta плагинов отключена.', '');
    refreshProjectNameViews();
    return true;
  }

  try {
    if (!silent) setSettingsStatus('Загружаю meta плагинов...', '');
    const response = await fetch(normalizedUrl, { cache: 'no-store' });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const raw = await response.json();
    pluginsMetaOverrides = normalizePluginsMeta(raw);
    if (!silent) {
      const count = Object.keys(pluginsMetaOverrides).length;
      setSettingsStatus(count > 0 ? 'Meta плагинов обновлена: ' + count + ' записей.' : 'JSON загружен, но записей meta не найдено.', count > 0 ? 'success' : '');
    }
    refreshProjectNameViews();
    return true;
  } catch (error) {
    pluginsMetaOverrides = {};
    refreshProjectNameViews();
    if (!silent) setSettingsStatus('Не удалось загрузить meta плагинов: ' + (error instanceof Error ? error.message : String(error)), 'error');
    return false;
  }
}

async function loadResearchMarkdownFromUrl(url, { silent = false } = {}) {
  const normalizedUrl = String(url ?? '').trim();
  if (!normalizedUrl) {
    researchMarkdown = '';
    if (!silent) setSettingsStatus('Markdown для исследования отключён.', '');
    renderResearchView();
    return true;
  }

  try {
    if (!silent) setSettingsStatus('Загружаю markdown исследования...', '');
    const response = await fetch(normalizedUrl, { cache: 'no-store' });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const raw = await response.text();
    researchMarkdown = raw;
    if (!silent) {
      setSettingsStatus('Исследование обновлено.', 'success');
    }
    renderResearchView();
    return true;
  } catch (error) {
    researchMarkdown = '';
    renderResearchView();
    if (!silent) setSettingsStatus('Не удалось загрузить markdown: ' + (error instanceof Error ? error.message : String(error)), 'error');
    const stateEl = document.getElementById('research-state');
    const docEl = document.getElementById('research-doc');
    if (stateEl) {
      stateEl.textContent = 'Не удалось загрузить markdown-файл.';
      stateEl.className = 'research-state error';
      stateEl.hidden = false;
    }
    if (docEl) {
      docEl.hidden = true;
      docEl.innerHTML = '';
    }
    return false;
  }
}

function initSettingsModal() {
  const modal = document.getElementById('settings-modal');
  const input = document.getElementById('project-map-url-input');
  const metaInput = document.getElementById('plugins-meta-url-input');
  const researchInput = document.getElementById('research-md-url-input');
  const openBtn = document.getElementById('settings-btn');
  const closeBtn = document.getElementById('settings-close-btn');
  const saveBtn = document.getElementById('settings-save-btn');
  const clearBtn = document.getElementById('settings-clear-btn');

  openBtn.onclick = () => openSettingsModal();
  closeBtn.onclick = () => closeSettingsModal();
  modal.onclick = e => {
    if (e.target === modal) closeSettingsModal();
  };

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && settingsState.open) closeSettingsModal();
  });

  saveBtn.onclick = async () => {
    const nextUrl = String(input.value || '').trim();
    const nextMetaUrl = String(metaInput.value || '').trim();
    const nextResearchUrl = String(researchInput.value || '').trim();
    setSettingsStatus('Принудительно обновляю внешние данные...', '');
    projectLabelsUrl = nextUrl;
    pluginsMetaUrl = nextMetaUrl;
    researchMdUrl = nextResearchUrl;
    overrides = {};
    complexityOverrides = {};
    saveOverrides();
    saveComplexityOverrides();
    try {
      if (projectLabelsUrl) localStorage.setItem(LS_PROJECT_LABELS_URL_KEY, projectLabelsUrl);
      else localStorage.removeItem(LS_PROJECT_LABELS_URL_KEY);
      if (pluginsMetaUrl) localStorage.setItem(LS_PLUGINS_META_URL_KEY, pluginsMetaUrl);
      else localStorage.removeItem(LS_PLUGINS_META_URL_KEY);
      if (researchMdUrl) localStorage.setItem(LS_RESEARCH_MD_URL_KEY, researchMdUrl);
      else localStorage.removeItem(LS_RESEARCH_MD_URL_KEY);
    } catch {}
    const okProjectLabels = await loadProjectLabelsFromUrl(projectLabelsUrl, { silent: true });
    const okPluginsMeta = await loadPluginsMetaFromUrl(pluginsMetaUrl, { silent: true });
    const okResearch = await loadResearchMarkdownFromUrl(researchMdUrl, { silent: true });
    if (okProjectLabels && okPluginsMeta && okResearch) {
      setSettingsStatus('Настройки сохранены. Данные обновлены.', 'success');
    } else if (!okProjectLabels && !okPluginsMeta && !okResearch) {
      setSettingsStatus('Настройки сохранены, но ни один внешний источник не загрузился.', 'error');
    } else if (!okProjectLabels) {
      setSettingsStatus('Настройки сохранены, но названия проектов не загрузились.', 'error');
    } else if (!okPluginsMeta) {
      setSettingsStatus('Настройки сохранены, но meta плагинов не загрузилась.', 'error');
    } else if (!okResearch) {
      setSettingsStatus('Настройки сохранены, но markdown исследования не загрузился.', 'error');
    } else {
      setSettingsStatus('Настройки сохранены частично.', 'error');
    }
  };

  clearBtn.onclick = async () => {
    input.value = '';
    metaInput.value = '';
    researchInput.value = '';
    projectLabelsUrl = '';
    pluginsMetaUrl = '';
    researchMdUrl = '';
    try { localStorage.removeItem(LS_PROJECT_LABELS_URL_KEY); } catch {}
    try { localStorage.removeItem(LS_PLUGINS_META_URL_KEY); } catch {}
    try { localStorage.removeItem(LS_RESEARCH_MD_URL_KEY); } catch {}
    await loadProjectLabelsFromUrl('');
    await loadPluginsMetaFromUrl('', { silent: true });
    await loadResearchMarkdownFromUrl('', { silent: true });
    setSettingsStatus('Внешние источники отключены.', '');
  };
}

function getPlugins(keys) {
  if (keys === undefined && projNone) return [];
  const sel = keys ?? (projSel.size === 0 ? Object.keys(DATA.projects) : [...projSel]);
  if (sel.length === 0) return [];
  if (sel.length === 1) return DATA.projects[sel[0]]?.plugins || [];
  const merged = new Map();
  for (const projectKey of sel) {
    const plugins = DATA.projects[projectKey]?.plugins || [];
    for (const p of plugins) {
      if (!merged.has(p.id)) {
        merged.set(p.id, {
          ...p,
          patterns: p.patterns.map(pat => ({
            ...pat,
            files: [...pat.files],
            examples: [...pat.examples],
            fileMatches: { ...(pat.fileMatches ?? {}) },
            fileExamples: Object.fromEntries(
              Object.entries(pat.fileExamples ?? {}).map(([k, v]) => [k, [...v]])
            ),
          }))
        });
      } else {
        const m = merged.get(p.id);
        m.totalMatches += p.totalMatches;
        for (const pat of p.patterns) {
          const ex = m.patterns.find(mp => mp.label === pat.label);
          if (ex) {
            ex.count += pat.count;
            const fs = new Set([...ex.files, ...pat.files]);
            ex.files = [...fs];
            const es = new Set([...ex.examples, ...pat.examples]);
            ex.examples = [...es].slice(0, 5);
            for (const [file, cnt] of Object.entries(pat.fileMatches ?? {})) {
              ex.fileMatches[file] = (ex.fileMatches[file] ?? 0) + (Number(cnt) || 0);
            }
            for (const [file, examples] of Object.entries(pat.fileExamples ?? {})) {
              const prev = ex.fileExamples[file] ?? [];
              ex.fileExamples[file] = [...new Set([...prev, ...examples])].slice(0, 5);
            }
          } else {
            m.patterns.push({
              ...pat,
              files: [...pat.files],
              examples: [...pat.examples],
              fileMatches: { ...(pat.fileMatches ?? {}) },
              fileExamples: Object.fromEntries(
                Object.entries(pat.fileExamples ?? {}).map(([k, v]) => [k, [...v]])
              ),
            });
          }
        }
      }
    }
  }
  return [...merged.values()];
}


function effectivePriority(plugin) {
  const base = getPluginField(plugin, 'priority', '—');
  return overrides[plugin.id] ?? base;
}

function effectiveComplexity(plugin) {
  const base = getPluginField(plugin, 'complexity', '—');
  return complexityOverrides[plugin.id] ?? base;
}

function effectivePriorityById(id, plugins) {
  const p = plugins.find(x => x.id === id);
  return p ? effectivePriority(p) : '—';
}

function getFilesPlugins() {
  return getPlugins([filesProjKey]);
}

function buildFileIndex(plugins) {
  const map = new Map();
  for (const p of plugins) {
    for (const pat of p.patterns) {
      const fm = pat.fileMatches ?? {};
      for (const [file, count] of Object.entries(fm)) {
        if (!map.has(file)) map.set(file, { total: 0, plugins: new Map() });
        const fd = map.get(file);
        fd.total += count;
        if (!fd.plugins.has(p.id)) {
          fd.plugins.set(p.id, { count: 0, priority: p.priority, complexity: p.complexity, patterns: new Map() });
        }
        const pd = fd.plugins.get(p.id);
        pd.count += count;
        pd.patterns.set(pat.label, {
          count,
          examples: (pat.fileExamples ?? {})[file] ?? [],
        });
      }
    }
  }
  return [...map.entries()]
    .map(([file, d]) => ({
      file,
      total: d.total,
      plugins: [...d.plugins.entries()].map(([id, v]) => ({
        id,
        count: v.count,
        priority: v.priority,
        complexity: v.complexity,
        patterns: [...v.patterns.entries()].map(([label, pv]) => ({ label, count: pv.count, examples: pv.examples })),
      })),
    }))
    .sort((a, b) => b.total - a.total);
}

function closeOpenPanels(exceptId = '') {
  ['proj-panel', 'priority-panel', 'complexity-panel', 'files-plugin-panel', 'export-panel'].forEach(id => {
    if (id !== exceptId) document.getElementById(id)?.classList.remove('open');
  });
}

function renderFilesProjTabs() {
  const projects = Object.keys(DATA.projects);
  const container = document.getElementById('files-proj-tabs');
  container.innerHTML = projects.map(key =>
    \`<button class="fptab\${filesProjKey === key ? ' active' : ''}" data-proj="\${escAttr(key)}">\${escHtml(getProjectDisplayLabel(key))}</button>\`
  ).join('');
  container.querySelectorAll('.fptab').forEach(btn => {
    btn.onclick = () => {
      filesProjKey = btn.dataset.proj;
      fileExpanded.clear();
      filePluginFilters.clear();
      filePluginNone = false;
      renderFilesPluginDropdown();
      renderFilesTable();
      // update active tab
      container.querySelectorAll('.fptab').forEach(b => b.classList.toggle('active', b.dataset.proj === filesProjKey));
    };
  });
}

function renderFilesPluginDropdown() {
  const plugins = getFilesPlugins()
    .filter(p => p.totalMatches > 0)
    .sort((a, b) => (PRIORITY_WEIGHT[effectivePriority(a)] ?? 99) - (PRIORITY_WEIGHT[effectivePriority(b)] ?? 99));
  const panel = document.getElementById('files-plugin-panel');
  const triggerLabel = document.getElementById('files-plugin-trigger-label');

  function updateLabel() {
    const clearBtn = document.getElementById('files-plugin-clear');
    if (clearBtn) clearBtn.classList.toggle('is-visible', (filePluginNone || filePluginFilters.size > 0));
    if (filePluginNone) { triggerLabel.textContent = 'Ничего (0)'; return; }
    if (filePluginFilters.size === 0) { triggerLabel.textContent = \`Все (\${plugins.length})\`; return; }
    if (filePluginFilters.size === 1) { triggerLabel.textContent = [...filePluginFilters][0]; return; }
    triggerLabel.textContent = \`Выбрано: \${filePluginFilters.size}\`;
  }

  function renderPanel() {
    const allSel = filePluginFilters.size === 0 && !filePluginNone;
    panel.innerHTML = [
      \`<label class="proj-option all-option"><input type="checkbox" id="fpf-all" \${allSel ? 'checked' : ''}> Все (\${plugins.length})</label>\`,
      ...plugins.map(p =>
        \`<label class="proj-option"><input type="checkbox" data-plugin="\${escAttr(p.id)}" \${(allSel || filePluginFilters.has(p.id)) ? 'checked' : ''}> \${escHtml(p.id)}</label>\`
      ),
    ].join('');
    updateLabel();
    panel.querySelector('#fpf-all').onchange = () => {
      if (allSel) {
        filePluginNone = true;
        filePluginFilters.clear();
      } else {
        filePluginNone = false;
        filePluginFilters.clear();
      }
      fileExpanded.clear();
      renderPanel();
      renderFilesTable();
    };
    panel.querySelectorAll('[data-plugin]').forEach(cb => {
      cb.onchange = () => {
        const id = cb.dataset.plugin;
        const wasAll = filePluginFilters.size === 0 && !filePluginNone;
        if (filePluginNone) filePluginNone = false;
        if (wasAll) filePluginFilters = new Set(plugins.map(p => p.id));
        if (cb.checked) filePluginFilters.add(id); else filePluginFilters.delete(id);
        if (filePluginFilters.size === plugins.length) {
          filePluginFilters.clear();
          filePluginNone = false;
        } else if (filePluginFilters.size === 0) {
          filePluginNone = true;
        }
        fileExpanded.clear();
        renderPanel();
        renderFilesTable();
      };
    });
  }

  renderPanel();
  const filesClear = document.getElementById('files-plugin-clear');
  if (filesClear) {
    filesClear.onclick = e => {
      e.preventDefault();
      e.stopPropagation();
      filePluginNone = false;
      filePluginFilters.clear();
      fileExpanded.clear();
      renderPanel();
      renderFilesTable();
    };
  }
  document.getElementById('files-plugin-trigger').onclick = e => {
    e.stopPropagation();
    const willOpen = !panel.classList.contains('open');
    closeOpenPanels('files-plugin-panel');
    panel.classList.toggle('open', willOpen);
  };
}

function renderFilesTable() {
  const plugins = getFilesPlugins();
  if (filePluginNone) {
    document.getElementById('files-thead').innerHTML = \`<tr><th></th><th>Файл</th><th>Совпадения</th><th>Плагины</th></tr>\`;
    document.getElementById('files-tbody').innerHTML = \`<tr><td colspan="4"><div class="empty-state">Нет файлов для выбранного фильтра</div></td></tr>\`;
    return;
  }
  let rows = buildFileIndex(plugins);
  if (filePluginFilters.size > 0) {
    rows = rows.filter(r => r.plugins.some(p => filePluginFilters.has(p.id)));
  }
  document.getElementById('files-thead').innerHTML =
    \`<tr><th></th><th>Файл</th><th>Совпадения</th><th>Плагины</th></tr>\`;
  document.getElementById('files-tbody').innerHTML = rows.map(r => {
    const isOpen = fileExpanded.has(r.file);
    const sortedPlugins = r.plugins.slice().sort((a, b) => (PRIORITY_WEIGHT[a.priority] ?? 99) - (PRIORITY_WEIGHT[b.priority] ?? 99));
    const detailPlugins = filePluginFilters.size > 0 ? sortedPlugins.filter(p => filePluginFilters.has(p.id)) : sortedPlugins;
    const mainRow = \`
      <tr class="fr\${isOpen ? ' open' : ''}" data-file="\${escAttr(r.file)}">
        <td class="exp-col"><span class="exp-icon">\${isOpen ? '▼' : '▶'}</span></td>
        <td><span class="file-path">\${escHtml(r.file.startsWith(filesProjKey + '/') ? r.file.slice(filesProjKey.length + 1) : r.file)}</span></td>
        <td><span class="matches">\${r.total}</span></td>
        <td><div class="plugin-chips">\${
          sortedPlugins.map(p => \`<span class="badge p-\${escAttr(priorityBadgeClass(effectivePriorityById(p.id, plugins)))}">\${escHtml(p.id)} <span class="count-muted">\${p.count}</span></span>\`).join('')
        }</div></td>
      </tr>\`;
    if (!isOpen) return mainRow;
    const detailRow = \`
      <tr class="fdr">
        <td></td>
        <td colspan="3">
          <div class="file-detail">
            \${detailPlugins.map(p => \`
              <div class="fd-plugin">
                <div class="fd-plugin-label">
                  <span class="badge p-\${escAttr(priorityBadgeClass(effectivePriorityById(p.id, plugins)))}">\${escHtml(p.id)}</span>
                  <span class="fd-plugin-count">\${p.count} совпадений</span>
                </div>
                \${p.patterns.map(pat => \`
                  <div class="fd-pat">
                    <div class="d-label">\${escHtml(pat.label)} <span class="muted-count">(\${pat.count})</span></div>
                    \${pat.examples.length > 0
                      ? pat.examples.map(ex => {
                        const m = /^L(\\d+):/.exec(ex);
                        const line = m ? Number(m[1]) : 0;
                        return \`<button type="button" class="fd-code src-jump" data-file="\${escAttr(r.file)}" data-line="\${line}">\${escHtml(ex)}</button>\`;
                      }).join('')
                      : '<span class="fd-no-ex">—</span>'}
                  </div>
                \`).join('')}
              </div>
            \`).join('')}
          </div>
        </td>
      </tr>\`;
    return mainRow + detailRow;
  }).join('');
  document.querySelectorAll('#files-tbody tr.fr').forEach(tr => {
    tr.onclick = e => {
      if (e.target.closest('.src-jump')) return;
      const file = tr.dataset.file;
      if (fileExpanded.has(file)) fileExpanded.delete(file);
      else fileExpanded.add(file);
      renderFilesTable();
    };
  });
  document.querySelectorAll('.src-jump').forEach(btn => {
    btn.onclick = e => {
      e.stopPropagation();
      const file = btn.dataset.file || '';
      const line = Number(btn.dataset.line || '0');
      openSourceLine(file, line > 0 ? line : null);
    };
  });
}

function renderFilesView() {
  renderFilesProjTabs();
  renderFilesPluginDropdown();
  renderFilesTable();
}

function getSourceFilesForProject(projectKey) {
  const prefix = projectKey + '/';
  return Object.keys(DATA.sources || {})
    .filter(p => p.startsWith(prefix))
    .sort((a, b) => a.localeCompare(b));
}

function renderSourcesProjTabs() {
  const projects = Object.keys(DATA.projects);
  const container = document.getElementById('sources-proj-tabs');
  container.innerHTML = projects.map(key =>
    '<button class="fptab' + (sourceProjKey === key ? ' active' : '') + '" data-proj="' + escAttr(key) + '">' + escHtml(getProjectDisplayLabel(key)) + '</button>'
  ).join('');
  container.querySelectorAll('.fptab').forEach(btn => {
    btn.onclick = () => {
      sourceProjKey = btn.dataset.proj;
      sourceSelectedFile = '';
      sourceHighlightLine = null;
      renderSourcesView();
    };
  });
}

function renderSourcesList() {
  const files = getSourceFilesForProject(sourceProjKey);
  if (!sourceSelectedFile || !files.includes(sourceSelectedFile)) {
    sourceSelectedFile = files[0] || '';
  }
  const list = document.getElementById('sources-list');
  list.innerHTML = files.map(file => {
    const short = file.slice(sourceProjKey.length + 1);
    return '<button type="button" class="src-file-btn' + (file === sourceSelectedFile ? ' active' : '') + '" data-file="' + escAttr(file) + '">' + escHtml(short) + '</button>';
  }).join('');
  list.querySelectorAll('.src-file-btn').forEach(btn => {
    btn.onclick = () => {
      sourceSelectedFile = btn.dataset.file || '';
      sourceHighlightLine = null;
      renderSourcesContent();
      renderSourcesList();
    };
  });
  const activeBtn = list.querySelector('.src-file-btn.active');
  if (activeBtn) {
    requestAnimationFrame(() => {
      activeBtn.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
  }
}

function renderSourcesContent() {
  const head = document.getElementById('source-head');
  const code = document.getElementById('source-code');
  if (!sourceSelectedFile) {
    head.textContent = 'Файл не выбран';
    code.innerHTML = '';
    return;
  }
  const content = DATA.sources?.[sourceSelectedFile] ?? '';
  head.textContent = sourceSelectedFile;
  const lines = content.split('\\n');
  code.innerHTML = lines.map((line, i) => {
    const lineNo = i + 1;
    const hitCls = sourceHighlightLine === lineNo ? ' hit' : '';
    return '<div class="src-line' + hitCls + '" data-line="' + lineNo + '"><span class="src-ln">' + lineNo + '</span><code class="src-txt">' + highlightCssLine(line) + '</code></div>';
  }).join('');
  if (sourceHighlightLine) {
    const lineEl = code.querySelector('.src-line[data-line="' + sourceHighlightLine + '"]');
    if (lineEl) lineEl.scrollIntoView({ block: 'center' });
  }
}

function renderSourcesView() {
  renderSourcesProjTabs();
  renderSourcesList();
  renderSourcesContent();
}

let currentView = 'plugins';

function switchView(view) {
  currentView = view;
  document.querySelectorAll('.vbtn').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  const isPlugins = view === 'plugins';
  const isFiles = view === 'files';
  const isSources = view === 'sources';
  const isResearch = view === 'research';
  document.getElementById('plugins-section').style.display = isPlugins ? 'flex' : 'none';
  document.getElementById('files-section').style.display = isFiles ? 'flex' : 'none';
  document.getElementById('sources-section').style.display = isSources ? 'flex' : 'none';
  document.getElementById('research-section').style.display = isResearch ? 'flex' : 'none';
  document.getElementById('plugins-filters-ctrl').style.display = isPlugins ? '' : 'none';
  document.getElementById('files-plugin-ctrl').style.display = isFiles ? '' : 'none';
  if (isFiles) renderFilesView();
  if (isSources) renderSourcesView();
  if (isResearch) renderResearchView();
}

function openFileInFilesView(filePath) {
  const projectKey = String(filePath).split('/')[0] || '';
  if (projectKey && DATA.projects[projectKey]) filesProjKey = projectKey;
  filePluginFilters.clear();
  filePluginNone = false;
  fileExpanded.clear();
  fileExpanded.add(filePath);
  switchView('files');
  requestAnimationFrame(() => {
    const row = document.querySelector(\`#files-tbody tr.fr[data-file="\${CSS.escape(filePath)}"]\`);
    if (row) row.scrollIntoView({ block: 'center' });
  });
}

function openSourceLine(filePath, lineNo) {
  const projectKey = String(filePath).split('/')[0] || '';
  if (projectKey && DATA.projects[projectKey]) sourceProjKey = projectKey;
  sourceSelectedFile = filePath;
  sourceHighlightLine = Number.isFinite(lineNo) ? lineNo : null;
  switchView('sources');
}

function init() {
  initExportButtons();
  loadTheme();
  initTooltips();
  loadOverrides();
  loadComplexityOverrides();
  projectLabelsUrl = (() => {
    try { return localStorage.getItem(LS_PROJECT_LABELS_URL_KEY) || ''; } catch { return ''; }
  })();
  pluginsMetaUrl = (() => {
    try { return localStorage.getItem(LS_PLUGINS_META_URL_KEY) || ''; } catch { return ''; }
  })();
  researchMdUrl = (() => {
    try { return localStorage.getItem(LS_RESEARCH_MD_URL_KEY) || ''; } catch { return ''; }
  })();
  const isDark = document.documentElement.classList.contains('dark');
  document.getElementById('theme-btn').textContent = isDark ? '☀️' : '🌙';
  document.getElementById('theme-btn').onclick = toggleTheme;
  document.getElementById('research-copy-btn').onclick = () => copyResearchMarkdown();
  initSettingsModal();
  ['proj-panel', 'priority-panel', 'complexity-panel', 'files-plugin-panel', 'export-panel'].forEach(id => {
    const panel = document.getElementById(id);
    if (panel) panel.addEventListener('click', e => e.stopPropagation());
  });
  renderProjSel();
  renderAll();
  initPopover();
  initCxPopover();
  syncResearchViewAvailability();
  if (projectLabelsUrl) loadProjectLabelsFromUrl(projectLabelsUrl, { silent: true });
  if (pluginsMetaUrl) loadPluginsMetaFromUrl(pluginsMetaUrl, { silent: true });
  renderResearchView();
  if (researchMdUrl) loadResearchMarkdownFromUrl(researchMdUrl, { silent: true });
  document.querySelectorAll('.vbtn').forEach(b => {
    b.onclick = () => switchView(b.dataset.view);
  });
}

function renderAll() {
  renderMeta();
  renderFtabs();
  renderCxtabs();
  renderHead();
  renderBody();
}

function renderProjSel() {
  const projects = Object.keys(DATA.projects);
  const panel = document.getElementById('proj-panel');
  const triggerLabel = document.getElementById('proj-trigger-label');

  function updateTriggerLabel() {
    const clearBtn = document.getElementById('proj-clear');
    if (clearBtn) clearBtn.classList.toggle('is-visible', (projNone || projSel.size > 0));
    const allSel = projSel.size === 0 && !projNone;
    if (projNone) { triggerLabel.textContent = 'Ничего (0)'; return; }
    if (allSel) triggerLabel.textContent = \`Все (\${projects.length})\`;
    else if (projSel.size === 1) triggerLabel.textContent = getProjectDisplayLabel([...projSel][0]);
    else triggerLabel.textContent = \`Выбрано: \${projSel.size}\`;
  }

  function renderPanel() {
    const allSel = projSel.size === 0 && !projNone;
    panel.innerHTML = [
      \`<label class="proj-option all-option"><input type="checkbox" id="po-all" \${allSel ? 'checked' : ''}> Все (\${projects.length})</label>\`,
      ...projects.map(p =>
        \`<label class="proj-option"><input type="checkbox" data-proj="\${escAttr(p)}" \${(allSel || projSel.has(p)) ? 'checked' : ''}> \${escHtml(getProjectDisplayLabel(p))}</label>\`
      )
    ].join('');
    updateTriggerLabel();
    panel.querySelector('#po-all').onchange = () => {
      if (allSel) {
        projNone = true;
        projSel.clear();
      } else {
        projNone = false;
        projSel.clear();
      }
      expanded.clear(); expandAll = false;
      renderPanel(); renderAll();
    };
    panel.querySelectorAll('[data-proj]').forEach(cb => {
      cb.onchange = () => {
        const key = cb.dataset.proj;
        const wasAll = projSel.size === 0 && !projNone;
        if (projNone) projNone = false;
        if (wasAll) projSel = new Set(projects);
        if (cb.checked) projSel.add(key);
        else projSel.delete(key);
        if (projSel.size === projects.length) {
          projSel.clear();
          projNone = false;
        } else if (projSel.size === 0) {
          projNone = true;
        }
        expanded.clear(); expandAll = false;
        renderPanel(); renderAll();
      };
    });
  }

  renderPanel();
  const projClear = document.getElementById('proj-clear');
  if (projClear) {
    projClear.onclick = e => {
      e.preventDefault();
      e.stopPropagation();
      projNone = false;
      projSel.clear();
      expanded.clear(); expandAll = false;
      renderPanel(); renderAll();
    };
  }

  document.getElementById('proj-trigger').onclick = e => {
    e.stopPropagation();
    const willOpen = !panel.classList.contains('open');
    closeOpenPanels('proj-panel');
    panel.classList.toggle('open', willOpen);
  };
  document.addEventListener('click', () => {
    closeOpenPanels();
    panel.classList.remove('open');
  });
}

function renderMeta() {
  const selectedProjects = projNone ? [] : (projSel.size === 0 ? Object.keys(DATA.projects) : [...projSel]);
  const total = selectedProjects.reduce((s, k) => s + (DATA.projects[k]?.filesScanned ?? 0), 0);
  const date = DATA.generated ? DATA.generated.slice(0,10) : '';
  document.getElementById('hdr-meta').textContent = \`\${total} файлов · \${date}\`;
}

function renderFtabs() {
  const allPlugins = getPlugins();
  const plugins = allPlugins.filter(p => {
    if (searchQuery && !p.id.toLowerCase().includes(searchQuery.toLowerCase())) return false;
    return true;
  });
  const counts = { all: plugins.length };
  for (const p of plugins) {
    const pr = effectivePriority(p);
    counts[pr] = (counts[pr] || 0) + 1;
  }
  const options = ['all', ...PRIORITY_CYCLE];
  const labels = {
    all: 'Все', critical: 'Критический', high: 'Высокий',
    native: 'Нативный', 'out-of-scope': 'Не рассматривается', removed: 'Удален', '—': '—'
  };
  const panel = document.getElementById('priority-panel');
  const triggerLabel = document.getElementById('priority-trigger-label');
  const available = options.filter(t => t !== 'all' && counts[t]);

  function updateLabel() {
    const clearBtn = document.getElementById('priority-clear');
    if (clearBtn) clearBtn.classList.toggle('is-visible', (filtersNone || filters.size > 0));
    if (filtersNone) {
      triggerLabel.textContent = 'Ничего (0)';
    } else if (filters.size === 0) {
      triggerLabel.textContent = \`Все (\${counts.all ?? 0})\`;
    } else if (filters.size === 1) {
      const key = [...filters][0];
      triggerLabel.textContent = \`\${labels[key] ?? key} (\${counts[key] ?? 0})\`;
    } else {
      triggerLabel.textContent = \`Выбрано: \${filters.size}\`;
    }
  }

  panel.innerHTML = [
    \`<label class="proj-option all-option"><input type="checkbox" id="pr-all" \${(filters.size === 0 && !filtersNone) ? 'checked' : ''}> Все (\${counts.all ?? 0})</label>\`,
    ...available.map(key =>
      \`<label class="proj-option"><input type="checkbox" data-priority="\${key}" \${((filters.size === 0 && !filtersNone) || filters.has(key)) ? 'checked' : ''}> \${labels[key] ?? key} (\${counts[key] ?? 0})</label>\`
    )
  ].join('');
  updateLabel();
  const priorityClear = document.getElementById('priority-clear');
  if (priorityClear) {
    priorityClear.onclick = e => {
      e.preventDefault();
      e.stopPropagation();
      filtersNone = false;
      filters.clear();
      renderFtabs();
      renderBody();
    };
  }

  panel.querySelector('#pr-all').onchange = () => {
    if (filters.size === 0 && !filtersNone) {
      filtersNone = true;
      filters.clear();
    } else {
      filtersNone = false;
      filters.clear();
    }
    renderFtabs();
    renderBody();
  };
  panel.querySelectorAll('[data-priority]').forEach(cb => {
    cb.onchange = () => {
      const key = cb.dataset.priority;
      const wasAll = filters.size === 0 && !filtersNone;
      if (filtersNone) filtersNone = false;
      if (wasAll) filters = new Set(available);
      if (cb.checked) filters.add(key);
      else filters.delete(key);
      if (filters.size === available.length) {
        filters.clear();
        filtersNone = false;
      } else if (filters.size === 0) {
        filtersNone = true;
      }
      renderFtabs();
      renderBody();
    };
  });

  document.getElementById('priority-trigger').onclick = e => {
    e.stopPropagation();
    const willOpen = !panel.classList.contains('open');
    closeOpenPanels('priority-panel');
    panel.classList.toggle('open', willOpen);
  };
}

function renderCxtabs() {
  const allPlugins = getPlugins();
  const plugins = allPlugins.filter(p => {
    if (searchQuery && !p.id.toLowerCase().includes(searchQuery.toLowerCase())) return false;
    return true;
  });
  const counts = { all: plugins.length };
  for (const p of plugins) {
    const cx = effectiveComplexity(p);
    counts[cx] = (counts[cx] || 0) + 1;
  }
  const options = ['all', ...COMPLEXITY_CYCLE];
  const labels = { all: 'Все', trivial: 'Минимальная', low: 'Низкая', medium: 'Средняя', high: 'Высокая', 'n/a': 'Без оценки', '—': '—' };
  const panel = document.getElementById('complexity-panel');
  const triggerLabel = document.getElementById('complexity-trigger-label');
  const available = options.filter(t => t !== 'all' && counts[t]);

  function updateLabel() {
    const clearBtn = document.getElementById('complexity-clear');
    if (clearBtn) clearBtn.classList.toggle('is-visible', (complexityFiltersNone || complexityFilters.size > 0));
    if (complexityFiltersNone) {
      triggerLabel.textContent = 'Ничего (0)';
    } else if (complexityFilters.size === 0) {
      triggerLabel.textContent = \`Все (\${counts.all ?? 0})\`;
    } else if (complexityFilters.size === 1) {
      const key = [...complexityFilters][0];
      triggerLabel.textContent = \`\${labels[key] ?? key} (\${counts[key] ?? 0})\`;
    } else {
      triggerLabel.textContent = \`Выбрано: \${complexityFilters.size}\`;
    }
  }

  panel.innerHTML = [
    \`<label class="proj-option all-option"><input type="checkbox" id="cx-all" \${(complexityFilters.size === 0 && !complexityFiltersNone) ? 'checked' : ''}> Все (\${counts.all ?? 0})</label>\`,
    ...available.map(key =>
      \`<label class="proj-option"><input type="checkbox" data-complexity="\${key}" \${((complexityFilters.size === 0 && !complexityFiltersNone) || complexityFilters.has(key)) ? 'checked' : ''}> \${labels[key] ?? key} (\${counts[key] ?? 0})</label>\`
    )
  ].join('');
  updateLabel();
  const complexityClear = document.getElementById('complexity-clear');
  if (complexityClear) {
    complexityClear.onclick = e => {
      e.preventDefault();
      e.stopPropagation();
      complexityFiltersNone = false;
      complexityFilters.clear();
      renderCxtabs();
      renderBody();
    };
  }

  panel.querySelector('#cx-all').onchange = () => {
    if (complexityFilters.size === 0 && !complexityFiltersNone) {
      complexityFiltersNone = true;
      complexityFilters.clear();
    } else {
      complexityFiltersNone = false;
      complexityFilters.clear();
    }
    renderCxtabs();
    renderBody();
  };
  panel.querySelectorAll('[data-complexity]').forEach(cb => {
    cb.onchange = () => {
      const key = cb.dataset.complexity;
      const wasAll = complexityFilters.size === 0 && !complexityFiltersNone;
      if (complexityFiltersNone) complexityFiltersNone = false;
      if (wasAll) complexityFilters = new Set(available);
      if (cb.checked) complexityFilters.add(key);
      else complexityFilters.delete(key);
      if (complexityFilters.size === available.length) {
        complexityFilters.clear();
        complexityFiltersNone = false;
      } else if (complexityFilters.size === 0) {
        complexityFiltersNone = true;
      }
      renderCxtabs();
      renderBody();
    };
  });

  document.getElementById('complexity-trigger').onclick = e => {
    e.stopPropagation();
    const willOpen = !panel.classList.contains('open');
    closeOpenPanels('complexity-panel');
    panel.classList.toggle('open', willOpen);
  };
}

function renderHead() {
  const cols = [
    {key:'order', label:'#', title:'Порядок в списке'},
    {key:'id', label:'Плагин', title:'Идентификатор плагина'},
    {key:'lightning', label:'Lightning CSS', title:'Поддержка в Lightning CSS'},
    {key:'complexity', label:'Сложность', title:'Сложность реализации'},
    {key:'priority', label:'Приоритет', title:'Приоритет миграции'},
    {key:'matches', label:'Совпадения', title:'Количество совпадений паттернов'},
  ];
  document.getElementById('thead').innerHTML = \`<tr>\${cols.map(c => {
    const sorted = sortCol === c.key;
    const arrow = sorted ? (sortDir > 0 ? '↑' : '↓') : '↕';
    const ariaSort = sorted ? (sortDir > 0 ? 'ascending' : 'descending') : 'none';
    return \`<th class="\${sorted ? 'sorted' : ''}" data-col="\${c.key}" data-tooltip="\${escAttr(c.title)}" aria-sort="\${ariaSort}">\${c.label}<span class="sort-arrow">\${arrow}</span></th>\`;
  }).join('')}</tr>\`;
  document.getElementById('thead').querySelectorAll('th').forEach(th => {
    th.onclick = () => {
      if (sortCol === th.dataset.col) sortDir *= -1;
      else { sortCol = th.dataset.col; sortDir = sortCol === 'matches' ? -1 : 1; }
      renderHead(); renderBody();
    };
  });
}

function renderBody() {
  closePopover();
  closeCxPopover();
  const allPlugins = getPlugins();
  const plugins = allPlugins.filter(p => {
    if (filtersNone) return false;
    if (complexityFiltersNone) return false;
    if (filters.size > 0 && !filters.has(effectivePriority(p))) return false;
    if (complexityFilters.size > 0 && !complexityFilters.has(effectiveComplexity(p))) return false;
    if (searchQuery && !p.id.toLowerCase().includes(searchQuery.toLowerCase())) return false;
    return true;
  });

  const sorted = [...plugins].sort((a, b) => {
    let av, bv;
    if (sortCol === 'order') { av = a.order; bv = b.order; }
    else if (sortCol === 'matches') { av = a.totalMatches; bv = b.totalMatches; }
    else if (sortCol === 'id') { av = a.id; bv = b.id; }
    else if (sortCol === 'lightning') { av = a.lightning; bv = b.lightning; }
    else if (sortCol === 'complexity') {
      av = COMPLEXITY_WEIGHT[effectiveComplexity(a)] ?? 99;
      bv = COMPLEXITY_WEIGHT[effectiveComplexity(b)] ?? 99;
    }
    else if (sortCol === 'priority') {
      av = PRIORITY_WEIGHT[effectivePriority(a)] ?? 99;
      bv = PRIORITY_WEIGHT[effectivePriority(b)] ?? 99;
    }
    if (av < bv) return -sortDir;
    if (av > bv) return sortDir;
    return a.order - b.order;
  });

  const tbody = document.getElementById('tbody');
  const wrap = document.querySelector('.tbl-wrap');
  const savedScroll = wrap ? wrap.scrollTop : 0;
  if (sorted.length === 0) {
    tbody.innerHTML = \`<tr><td colspan="6"><div class="empty-state">Нет плагинов для выбранного фильтра</div></td></tr>\`;
    return;
  }

  const rows = sorted.flatMap(p => {
    const ep = effectivePriority(p);
    const isOpen = expanded.has(p.id);
    const matchHits = p.patterns.filter(pat => pat.count > 0);
    const allFiles = [...new Set(matchHits.flatMap(pat => pat.files))].sort();
    const projectUsage = new Map();
    for (const pat of matchHits) {
      for (const [file, count] of Object.entries(pat.fileMatches ?? {})) {
        const project = String(file).split('/')[0] || 'unknown';
        if (!projectUsage.has(project)) projectUsage.set(project, { files: new Set(), matches: 0 });
        const usage = projectUsage.get(project);
        usage.files.add(file);
        usage.matches += Number(count) || 0;
      }
    }
    const projectUsageList = [...projectUsage.entries()]
      .map(([project, usage]) => ({
        project,
        matches: usage.matches,
        files: [...usage.files].sort(),
        filesCount: usage.files.size,
      }))
      .sort((a, b) => b.matches - a.matches || a.project.localeCompare(b.project));

    const lightKey = p.lightning.startsWith('yes') ? 'yes' : p.lightning.startsWith('none') ? 'none' : 'partial';

    const detailHtml = isOpen ? \`<tr class="dr" id="dr-\${CSS.escape(p.id)}">
      <td colspan="6">
        <div class="detail">
          <div class="d-section">
            <div class="d-label">Пакет</div>
            <div class="pats">
              <span class="pat-chip"><span class="pcl">Версия</span><span class="pcc">\${escHtml(p.version || '—')}</span></span>
              \${p.npm
                ? \`<a class="pat-chip meta-link" href="\${escAttr(p.npm)}" target="_blank" rel="noopener noreferrer">npm: \${escHtml(p.npmPackage || p.id)}</a>\`
                : \`<span class="pat-chip"><span class="pcl">npm</span><span class="pcc">—</span></span>\`}
            </div>
          </div>
          <div class="d-section">
            <div class="d-label">Описание</div>
            <div class="desc-txt">\${escHtml(getPluginField(p, 'description', 'Описание не задано'))}</div>
          </div>
          \${matchHits.length ? \`
          <div class="d-section">
            <div class="d-label">Паттерны</div>
            <div class="pats">\${matchHits.map(pat =>
              \`<span class="pat-chip"><span class="pcl">\${escHtml(pat.label)}</span><span class="pcc">\${pat.count}</span></span>\`
            ).join('')}</div>
          </div>\` : ''}
          \${p.patterns.some(pat => pat.examples.length) ? \`
          <div class="d-section">
            <div class="d-label">Примеры</div>
            <div class="exs">\${p.patterns.flatMap(pat => pat.examples)
              .map(e => \`<code class="ex-chip">\${escHtml(e)}</code>\`).join('')}</div>
          </div>\` : ''}
          \${projectUsageList.length ? \`
          <div class="d-section">
            <div class="d-label">Проекты (\${projectUsageList.length})</div>
            <div>\${projectUsageList.map(item => \`
              <div class="proj-usage-row">
                <div class="pats"><span class="pat-chip"><span class="pcl">\${escHtml(getProjectDisplayLabel(item.project))}</span><span class="pcc">\${item.matches} совпадений, \${item.filesCount} файлов</span></span></div>
                <div class="files-txt">\${item.files.map(file => {
                  const short = file.startsWith(item.project + '/') ? file.slice(item.project.length + 1) : file;
                  return \`<button type="button" class="file-jump" data-file="\${escAttr(file)}">\${escHtml(short)}</button>\`;
                }).join(' ')}</div>
              </div>
            \`).join('')}</div>
          </div>\` : ''}
          \${p.transforms?.length ? \`
          <div class="d-section">
            <div class="d-label">Трансформации</div>
            <div class="transforms">\${p.transforms.map(tf => \`
              <div class="tf-item">
                \${tf.label ? \`<div class="tf-item-label">\${escHtml(tf.label)}</div>\` : ''}
                <div class="tf-pair">
                  <pre class="tf-code tf-in">\${escHtml(tf.input)}</pre>
                  <div class="tf-arrow">→</div>
                  <pre class="tf-code tf-out">\${escHtml(tf.output)}</pre>
                </div>
              </div>
            \`).join('')}</div>
          </div>\` : ''}
        </div>
      </td>
    </tr>\` : '';

    const dotHtml = overrides[p.id] !== undefined ? '<span class="override-dot" title="Переопределено вручную"></span>' : '';
    const ec = effectiveComplexity(p);
    const cxDotHtml = complexityOverrides[p.id] !== undefined ? '<span class="override-dot" title="Переопределено вручную"></span>' : '';
    return \`<tr class="pr\${isOpen ? ' open' : ''}" data-id="\${escAttr(p.id)}">
      <td><span class="exp-icon">▶</span> <span class="plugin-order">\${p.order}</span></td>
      <td><span class="plugin-name">\${highlightMatch(p.id, searchQuery)}</span></td>
      <td><span class="badge l-\${lightKey}">\${LIGHTNING_LABEL[lightKey]}</span></td>
      <td><span class="badge cx-\${complexityBadgeClass(ec)} cxbadge" data-id="\${escAttr(p.id)}" data-tooltip="Изменить сложность">\${COMPLEXITY_LABEL[ec] ?? ec}\${cxDotHtml}</span></td>
      <td><span class="badge p-\${priorityBadgeClass(ep)} pbadge" data-id="\${escAttr(p.id)}" data-tooltip="Изменить приоритет">\${PRIORITY_LABEL[ep] ?? ep}\${dotHtml}</span></td>
      <td><span class="\${p.totalMatches === 0 ? 'matches-zero' : 'matches'}">\${p.totalMatches}</span></td>
    </tr>\${detailHtml}\`;
  });

  tbody.innerHTML = rows.join('');
  if (wrap) wrap.scrollTop = savedScroll;

  // Row click to expand
  tbody.querySelectorAll('tr.pr').forEach(tr => {
    tr.onclick = e => {
      if (e.target.closest('.pbadge') || e.target.closest('.cxbadge')) return;
      const id = tr.dataset.id;
      if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
      renderBody();
    };
  });

  tbody.querySelectorAll('.file-jump').forEach(btn => {
    btn.onclick = e => {
      e.stopPropagation();
      openFileInFilesView(btn.dataset.file || '');
    };
  });

  // Priority badge click → popover
  tbody.querySelectorAll('.pbadge').forEach(badge => {
    badge.onclick = e => {
      e.stopPropagation();
      closeCxPopover();
      if (popover.id === badge.dataset.id) { closePopover(); return; }
      openPopover(badge, badge.dataset.id);
    };
  });

  // Complexity badge click → popover
  tbody.querySelectorAll('.cxbadge').forEach(badge => {
    badge.onclick = e => {
      e.stopPropagation();
      closePopover();
      if (cxPopover.id === badge.dataset.id) { closeCxPopover(); return; }
      openCxPopover(badge, badge.dataset.id);
    };
  });
}

function initPopover() {
  const el = document.createElement('div');
  el.className = 'popover';
  el.id = 'priority-popover';
  document.body.appendChild(el);
  popover.el = el;
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { closePopover(); closeCxPopover(); } });
  document.addEventListener('click', e => {
    if (popover.id && !e.target.closest('#priority-popover') && !e.target.closest('.pbadge')) closePopover();
  });
}

function openPopover(badge, pluginId) {
  const plugin = getPlugins().find(p => p.id === pluginId);
  if (!plugin) return;
  const cur = effectivePriority(plugin);
  const base = getPluginField(plugin, 'priority', '—');
  popover.el.innerHTML = PRIORITY_CYCLE.map(val =>
    \`<div class="popover-row\${cur === val ? ' current' : ''}" data-val="\${val}">\${PRIORITY_LABEL[val]}</div>\`
  ).join('');
  popover.el.querySelectorAll('.popover-row').forEach(row => {
    row.onclick = e => {
      e.stopPropagation();
      const next = row.dataset.val;
      if (next === base) delete overrides[pluginId];
      else overrides[pluginId] = next;
      saveOverrides();
      closePopover();
      renderFtabs(); renderCxtabs(); renderBody();
    };
  });
  popover.el.style.visibility = 'hidden';
  popover.el.style.display = 'block';
  const rect = badge.getBoundingClientRect();
  const pw = popover.el.offsetWidth, ph = popover.el.offsetHeight;
  let top = rect.bottom + 4, left = rect.left;
  if (left + pw > window.innerWidth - 8) left = window.innerWidth - pw - 8;
  if (top + ph > window.innerHeight - 8) top = rect.top - ph - 4;
  popover.el.style.top = top + 'px';
  popover.el.style.left = left + 'px';
  popover.el.style.visibility = 'visible';
  popover.id = pluginId;
}

function closePopover() {
  if (popover.el) { popover.el.style.display = 'none'; popover.el.style.visibility = 'hidden'; }
  popover.id = null;
}

let cxPopover = { id: null, el: null };

function initCxPopover() {
  const el = document.createElement('div');
  el.className = 'popover';
  el.id = 'complexity-popover';
  document.body.appendChild(el);
  cxPopover.el = el;
  document.addEventListener('click', e => {
    if (cxPopover.id && !e.target.closest('#complexity-popover') && !e.target.closest('.cxbadge')) closeCxPopover();
  });
}

function openCxPopover(badge, pluginId) {
  const plugin = getPlugins().find(p => p.id === pluginId);
  if (!plugin) return;
  const cur = effectiveComplexity(plugin);
  const base = getPluginField(plugin, 'complexity', '—');
  cxPopover.el.innerHTML = COMPLEXITY_CYCLE.map(val =>
    \`<div class="popover-row\${cur === val ? ' current' : ''}" data-val="\${val}">\${COMPLEXITY_LABEL[val]}</div>\`
  ).join('');
  cxPopover.el.querySelectorAll('.popover-row').forEach(row => {
    row.onclick = e => {
      e.stopPropagation();
      const next = row.dataset.val;
      if (next === base) delete complexityOverrides[pluginId];
      else complexityOverrides[pluginId] = next;
      saveComplexityOverrides();
      closeCxPopover();
      renderFtabs(); renderCxtabs(); renderBody();
    };
  });
  cxPopover.el.style.visibility = 'hidden';
  cxPopover.el.style.display = 'block';
  const rect = badge.getBoundingClientRect();
  const pw = cxPopover.el.offsetWidth, ph = cxPopover.el.offsetHeight;
  let top = rect.bottom + 4, left = rect.left;
  if (left + pw > window.innerWidth - 8) left = window.innerWidth - pw - 8;
  if (top + ph > window.innerHeight - 8) top = rect.top - ph - 4;
  cxPopover.el.style.top = top + 'px';
  cxPopover.el.style.left = left + 'px';
  cxPopover.el.style.visibility = 'visible';
  cxPopover.id = pluginId;
}

function closeCxPopover() {
  if (cxPopover.el) { cxPopover.el.style.display = 'none'; cxPopover.el.style.visibility = 'hidden'; }
  cxPopover.id = null;
}

function initExpandAll() {
  const btn = document.getElementById('expand-all-btn');
  btn.onclick = () => {
    expandAll = !expandAll;
    if (expandAll) { getPlugins().forEach(p => expanded.add(p.id)); btn.textContent = 'Свернуть все'; }
    else { expanded.clear(); btn.textContent = 'Развернуть все'; }
    renderBody();
  };
}

function initSearch() {
  const input = document.getElementById('search-input');
  input.oninput = () => {
    searchQuery = input.value.trim();
    renderFtabs(); renderCxtabs(); renderBody();
  };
}

function renderFilterSummary(total, shown) {
  const parts = [];
  if (projNone) parts.push('проекты: <b>ничего</b>');
  if (filtersNone) parts.push('приоритет: <b>ничего</b>');
  if (complexityFiltersNone) parts.push('сложность: <b>ничего</b>');
  if (filters.size > 0) parts.push(\`приоритет: <b>\${[...filters].join(', ')}</b>\`);
  if (complexityFilters.size > 0) parts.push(\`сложность: <b>\${[...complexityFilters].join(', ')}</b>\`);
  if (searchQuery) parts.push(\`поиск: <b>\${escHtml(searchQuery)}</b>\`);
  const el = document.getElementById('filter-summary');
  if (parts.length === 0) { el.textContent = ''; return; }
  el.innerHTML = \`Показано \${shown} из \${total} · \${parts.join(' · ')} · <a id="reset-filters">Сбросить</a>\`;
  document.getElementById('reset-filters').onclick = () => {
    filters.clear(); complexityFilters.clear(); searchQuery = '';
    projNone = false; filtersNone = false; complexityFiltersNone = false;
    document.getElementById('search-input').value = '';
    renderProjSel();
    renderFtabs(); renderCxtabs(); renderBody();
  };
}

function highlightMatch(text, query) {
  if (!query) return escHtml(text);
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return escHtml(text);
  return escHtml(text.slice(0, idx)) + '<mark>' + escHtml(text.slice(idx, idx + query.length)) + '</mark>' + escHtml(text.slice(idx + query.length));
}

function highlightCssLine(line) {
  const raw = String(line ?? '');
  if (!raw) return '';
  const tokens = [];
  const put = (txt, cls) => {
    const token = '%%TOK' + tokens.length + '%%';
    tokens.push('<span class="' + cls + '">' + escHtml(txt) + '</span>');
    return token;
  };
  let out = raw;
  out = out.replace(/\\/\\*.*?\\*\\//g, m => put(m, 'tok-comment'));
  out = out.replace(/"(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'/g, m => put(m, 'tok-string'));
  out = out.replace(/@[a-zA-Z_-][\\w-]*/g, m => put(m, 'tok-atrule'));
  out = out.replace(/\\$[a-zA-Z_][\\w-]*|--[a-zA-Z_][\\w-]*/g, m => put(m, 'tok-var'));
  out = out.replace(/\\b\\d+(?:\\.\\d+)?(?:%|px|rem|em|vh|vw|ms|s|deg)?\\b/g, m => put(m, 'tok-num'));
  out = out.replace(/(^|[\\s{;])([a-z-]+)(\\s*:)/g, (m, p1, p2, p3) => p1 + put(p2, 'tok-prop') + p3);
  out = out.replace(/[{}():;,]/g, m => put(m, 'tok-punc'));
  out = escHtml(out);
  return out.replace(/%%TOK(\\d+)%%/g, (m, idx) => tokens[Number(idx)] ?? m);
}

function downloadTextFile(fileName, content, mimeType) {
  const blob = new Blob([content], { type: mimeType + ';charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function buildUnifiedPluginsForExport() {
  const merged = new Map();
  const projects = DATA.projects || {};
  Object.values(projects).forEach(project => {
    (project.plugins || []).forEach(p => {
      if (!merged.has(p.id)) {
        merged.set(p.id, {
          id: p.id,
          order: p.order,
          lightning: p.lightning,
          priority: effectivePriority(p),
          complexity: effectiveComplexity(p),
          description: getPluginField(p, 'description', '—'),
          npm: p.npm ?? null,
          npmPackage: p.npmPackage ?? null,
          version: p.version ?? '—',
          totalMatches: 0,
        });
      }
      const row = merged.get(p.id);
      row.totalMatches += Number(p.totalMatches || 0);
    });
  });
  return [...merged.values()].sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
}

function buildMarkdownReport() {
  const projects = DATA.projects || {};
  const projectKeys = Object.keys(projects);
  const generated = DATA.generated ? String(DATA.generated) : new Date().toISOString();
  const day = generated.slice(0, 10);
  const totalFiles = projectKeys.reduce((sum, key) => sum + (projects[key]?.filesScanned || 0), 0);
  const plugins = buildUnifiedPluginsForExport();
  let md = '# Аудит плагинов\\n\\n';
  md += 'Сформировано: ' + day + '  \\n';
  md += 'Проверено файлов: ' + totalFiles + ' CSS в ' + projectKeys.length + ' проект(ах)\\n\\n';
  md += '## Сводка (все проекты)\\n\\n';
  md += '| Порядок | Плагин | Совпадения | Lightning | Приоритет | Сложность |\\n';
  md += '|---|---|---:|---|---|---|\\n';
  plugins.forEach(p => {
    md += '| ' + (p.order ?? '') + ' | ' + p.id + ' | ' + (p.totalMatches ?? 0) + ' | ' + (p.lightning || '') + ' | ' + (p.priority || '') + ' | ' + (p.complexity || '') + ' |\\n';
  });
  return md;
}

function buildPluginsMetaExport() {
  const plugins = getPlugins()
    .slice()
    .sort((a, b) => (a.order ?? 999) - (b.order ?? 999) || String(a.id).localeCompare(String(b.id)));

  const meta = {};
  plugins.forEach(plugin => {
    meta[plugin.id] = {
      priority: effectivePriority(plugin),
      complexity: effectiveComplexity(plugin),
    };
  });
  return meta;
}

function initExportButtons() {
  const day = (DATA.generated ? String(DATA.generated) : new Date().toISOString()).slice(0, 10);
  const panel = document.getElementById('export-panel');
  const trigger = document.getElementById('export-trigger');
  if (!panel || !trigger) return;

  panel.innerHTML = [
    '<button type="button" class="proj-option export-option" data-format="md">Скачать Markdown (.md)</button>',
    '<button type="button" class="proj-option export-option" data-format="json">Скачать JSON (.json)</button>',
    '<button type="button" class="proj-option export-option" data-format="meta-json">Скачать Meta JSON (.json)</button>',
  ].join('');

  panel.querySelectorAll('[data-format]').forEach(btn => {
    btn.onclick = () => {
      const format = btn.dataset.format;
      if (format === 'md') {
        downloadTextFile('plugin-audit-' + day + '.md', buildMarkdownReport(), 'text/markdown');
      } else if (format === 'json') {
        const json = JSON.stringify({ generated: DATA.generated, plugins: buildUnifiedPluginsForExport() }, null, 2);
        downloadTextFile('plugin-audit-' + day + '.json', json, 'application/json');
      } else if (format === 'meta-json') {
        const json = JSON.stringify(buildPluginsMetaExport(), null, 2);
        downloadTextFile('plugin-meta-' + day + '.json', json, 'application/json');
      }
      panel.classList.remove('open');
    };
  });

  trigger.onclick = e => {
    e.stopPropagation();
    const willOpen = !panel.classList.contains('open');
    closeOpenPanels('export-panel');
    panel.classList.toggle('open', willOpen);
  };
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function escAttr(s) { return escHtml(s); }

init();
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (!PLUGINS_META_URL) {
    console.log('—');
  }

  PLUGINS = buildPlugins(await loadPluginsMeta(PLUGINS_META_URL));

  const { allFiles, projects, sources } = scanByProject(INPUT_DIR);

  if (allFiles.length === 0) {
    console.log(`В каталоге не найдено CSS-файлов: ${INPUT_DIR}`);
    console.log(`Добавьте анонимизированные CSS-файлы проекта в: ${INPUT_DIR}/project-a/`);
    process.exit(0);
  }

  console.log(`Сканирование: ${allFiles.length} CSS-файлов в ${Object.keys(projects).length} проект(ах)...`);

  const generatedDate = new Date().toISOString();

  if (FORMAT === 'html') {
    if (!OUTPUT_PATH) {
      console.log('Для HTML-отчета укажите --output.');
      return;
    }
    const html = renderHtml(projects, sources, generatedDate);
    const out = OUTPUT_PATH;
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, html, 'utf8');
    console.log(`HTML-отчет сохранен: ${out}`);
    return;
  }

  if (FORMAT === 'json') {
    if (!OUTPUT_PATH) {
      console.log('Для JSON-отчета укажите --output.');
      return;
    }
    const json = JSON.stringify({ generated: generatedDate, plugins: aggregatePlugins(projects) }, null, 2);
    const out = OUTPUT_PATH;
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, json, 'utf8');
    console.log(`JSON-отчет сохранен: ${out}`);
    return;
  }

  if (FORMAT === 'markdown') {
    if (!OUTPUT_PATH) {
      console.log('Для Markdown-отчета укажите --output.');
      return;
    }
    const md = renderMarkdown(projects, generatedDate);
    const out = OUTPUT_PATH;
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, md, 'utf8');
    console.log(`Markdown-отчет сохранен: ${out}`);
    return;
  }

  console.log('\n=== Сводка по плагинам ===\n');
  const firstPlugins = Object.values(projects)[0]?.plugins ?? [];
  const maxId = Math.max(...firstPlugins.map(r => r.id.length));
  for (const r of firstPlugins) {
    const icon = r.lightning.startsWith('yes') ? '🟢' : r.lightning.startsWith('none') ? '🔴' : '🟡';
    const status = r.totalMatches === 0
      ? '   0  ⚪'
      : `${String(r.totalMatches).padStart(4)}  ${icon}`;
    console.log(`  ${r.id.padEnd(maxId)}  ${status}  [${r.priority}]`);
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
