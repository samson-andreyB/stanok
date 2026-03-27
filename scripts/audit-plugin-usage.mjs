/**
 * audit-plugin-usage.mjs
 *
 * Сканирует CSS-файлы в usage-audit/input/ и строит отчёт по использованию
 * каждого из 18 плагинов intcss. Группирует по проектам (подпапкам).
 *
 * Usage:
 *   node scripts/audit-plugin-usage.mjs                         # MD + JSON + HTML → report/
 *   node scripts/audit-plugin-usage.mjs --input ./my/css/dir
 *   node scripts/audit-plugin-usage.mjs --format html --output docs/plugin-audit/index.html
 *   node scripts/audit-plugin-usage.mjs --format json
 *   node scripts/audit-plugin-usage.mjs --format markdown
 */

import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Plugin metadata (priority + complexity) — sourced from plugins-meta.json
// ---------------------------------------------------------------------------

const META_PATH = new URL('./plugins-meta.json', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
const PLUGINS_META = JSON.parse(fs.readFileSync(META_PATH, 'utf8'));

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

// ---------------------------------------------------------------------------
// Plugin definitions
// ---------------------------------------------------------------------------

const PLUGINS = [
  {
    id: 'postcss-import',
    order: 1,
    lightning: 'none',
    priority: 'critical',
    complexity: 'medium',
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
    priority: 'critical',
    complexity: 'high',
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
    priority: 'high',
    complexity: 'low',
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
    priority: 'out-of-scope',
    complexity: 'n/a',
    recommendation: 'Out of scope — нет usage в реальных проектах',
    patterns: [
      { label: ': @property-name', re: /:\s*@[a-z][a-z-]+(?!\s*[\w(])/gm },
    ],
  },
  {
    id: 'postcss-assets',
    order: 5,
    lightning: 'none',
    priority: 'critical',
    complexity: 'high',
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
    priority: 'critical',
    complexity: 'high',
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
    priority: 'out-of-scope',
    complexity: 'n/a',
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
    priority: 'out-of-scope',
    complexity: 'n/a',
    recommendation: 'Out of scope — нет usage в реальных проектах',
    patterns: [
      { label: 'strip()', re: /\bstrip\([^)]+\)/gm },
    ],
  },
  {
    id: 'postcss-conditionals',
    order: 9,
    lightning: 'none',
    priority: 'out-of-scope',
    complexity: 'n/a',
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
    priority: 'critical',
    complexity: 'medium',
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
    priority: 'native',
    complexity: 'trivial',
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
    priority: 'out-of-scope',
    complexity: 'n/a',
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
    priority: 'native',
    complexity: 'trivial',
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
    priority: 'high',
    complexity: 'high',
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
    priority: 'out-of-scope',
    complexity: 'n/a',
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
    priority: 'out-of-scope',
    complexity: 'n/a',
    recommendation: 'Rust Post-stage (опциональный) — нет usage в реальных проектах',
    patterns: [
      { label: 'SVG in url() (non-data)', re: /url\(['"](?!data:)[^'"]*\.svg['"]\)/gm },
    ],
  },
  {
    id: 'postcss-color-rgba-fallback',
    order: 16,
    lightning: 'none',
    priority: 'out-of-scope',
    complexity: 'n/a',
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
    priority: 'native',
    complexity: 'trivial',
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
    priority: 'removed',
    complexity: 'n/a',
    recommendation: 'Намеренно удалён — данные inline в mainX.css, _data.css больше не генерируется',
    patterns: [
      { label: 'data: image inline',    re: /url\(['"]data:image\/[^'"]+['"]\)/gm },
      { label: 'data: font inline',     re: /url\(['"]data:(?:application\/|font\/)[^'"]+['"]\)/gm },
      { label: '_data.css ref (built)', re: /url\(['"][^'"]*_data\.css#/gm },
    ],
  },
].map(p => ({ ...p, ...(PLUGINS_META[p.id] ?? {}) }));

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

function scanFiles(files, inputDir) {
  const results = [];

  for (const plugin of PLUGINS) {
    const pluginResult = {
      id: plugin.id,
      order: plugin.order,
      lightning: plugin.lightning,
      priority: plugin.priority,
      complexity: plugin.complexity ?? 'n/a',
      recommendation: plugin.recommendation,
      transforms: plugin.transforms ?? [],
      totalMatches: 0,
      patterns: [],
    };

    for (const pat of plugin.patterns) {
      const patResult = { label: pat.label, count: 0, examples: [], files: new Set(), fileMatches: {}, fileExamples: {} };

      for (const file of files) {
        const content = fs.readFileSync(file, 'utf8');
        const relPath = path.relative(inputDir, file).replace(/\\/g, '/');
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
              if (patResult.fileExamples[relPath].length < 3 && !patResult.fileExamples[relPath].includes(ex)) {
                patResult.fileExamples[relPath].push(ex);
              }
              if (patResult.examples.length < 3 && !patResult.examples.includes(ex)) {
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
    sources[rel] = fs.readFileSync(file, 'utf8');
    const parts = rel.split('/');
    const projectName = parts.length > 1 ? parts[0] : '(root)';
    if (!groups[projectName]) groups[projectName] = [];
    groups[projectName].push(file);
  }

  const projects = {};
  for (const [name, files] of Object.entries(groups)) {
    projects[name] = {
      filesScanned: files.length,
      plugins: scanFiles(files, inputDir),
    };
  }
  return { allFiles, projects, sources };
}

// ---------------------------------------------------------------------------
// Render: Markdown
// ---------------------------------------------------------------------------

function renderMarkdown(projects, generatedDate) {
  const now = generatedDate.slice(0, 10);
  const totalFiles = Object.values(projects).reduce((s, p) => s + p.filesScanned, 0);
  const projectCount = Object.keys(projects).length;

  // Use first project for the main report (or merged if only one)
  const firstProject = Object.values(projects)[0];
  const results = firstProject?.plugins ?? [];

  let md = `# Plugin Usage Audit\n\n`;
  md += `Generated: ${now}  \n`;
  md += `Files scanned: ${totalFiles} CSS files across ${projectCount} project(s)  \n`;
  md += `Input dir: \`${INPUT_DIR}\`\n\n`;
  md += `---\n\n`;

  for (const r of results) {
    const statusIcon = r.totalMatches === 0 ? '⚪' :
      r.lightning.startsWith('yes') ? '🟢' :
      r.lightning.startsWith('none') ? '🔴' : '🟡';

    md += `## ${statusIcon} ${r.id} (order: ${r.order})\n\n`;
    md += `**Lightning CSS:** ${r.lightning}  \n`;
    md += `**Priority:** ${r.priority}  \n`;
    md += `**Recommendation:** ${r.recommendation}  \n`;
    md += `**Total matches:** ${r.totalMatches}\n\n`;

    if (r.totalMatches === 0) {
      md += `> ⚠️ Not found in any file — candidate for removal / out of scope\n\n`;
    } else {
      const patWithHits = r.patterns.filter(p => p.count > 0);
      md += `| Pattern | Count | Examples |\n`;
      md += `|---|---|---|\n`;
      for (const p of patWithHits) {
        const exStr = p.examples.map(e => `\`${e.slice(0, 60)}\``).join(', ');
        md += `| ${p.label} | ${p.count} | ${exStr} |\n`;
      }
      md += `\n`;

      const allFiles = [...new Set(patWithHits.flatMap(p => p.files))].sort();
      if (allFiles.length > 0) {
        md += `Files: ${allFiles.join(', ')}\n\n`;
      }
    }

    md += `---\n\n`;
  }

  md += `## Summary\n\n`;
  md += `| Order | Plugin | Matches | Lightning CSS | Priority | Recommendation |\n`;
  md += `|---|---|---|---|---|---|\n`;
  for (const r of results) {
    const icon = r.totalMatches === 0 ? '⚪ 0' : `**${r.totalMatches}**`;
    const lcs = r.lightning.startsWith('yes') ? '✅' :
      r.lightning.startsWith('none') ? '❌' : '⚠️';
    md += `| ${r.order} | ${r.id} | ${icon} | ${lcs} | ${r.priority} | ${r.recommendation} |\n`;
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
<title>intcss Plugin Audit</title>
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
.proj-trigger .trigger-arrow{margin-left:auto;color:var(--muted);font-size:10px}
.proj-panel{position:absolute;top:calc(100% + 4px);left:0;min-width:200px;max-width:320px;background:var(--surface);border:1px solid var(--border);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.12);z-index:100;overflow:hidden;display:none}
html.dark .proj-panel{box-shadow:0 8px 24px rgba(0,0,0,.4)}
.proj-panel.open{display:block}
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
.toggle-zero{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--muted);cursor:pointer;white-space:nowrap;height:36px;align-self:end;padding-left:4px}
.toggle-zero input{cursor:pointer;margin:0;width:18px;height:18px;flex:0 0 18px}
.search-input{padding:4px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);font-size:13px;width:180px;transition:border-color .15s}
.search-input:focus{outline:none;border-color:var(--accent)}
.search-input::placeholder{color:var(--muted)}
.expand-all-btn{padding:4px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--muted);font-size:12px;cursor:pointer;transition:border-color .15s,color .15s;white-space:nowrap}
.expand-all-btn:hover{border-color:var(--accent);color:var(--text)}
.filter-summary{font-size:11px;color:var(--muted);margin-bottom:10px;min-height:18px}
.filter-summary a{color:var(--accent);cursor:pointer;text-decoration:none}
.filter-summary a:hover{text-decoration:underline}

.view-toggle{display:inline-flex;gap:4px;margin-bottom:2px;padding:3px;border:1px solid var(--border);border-radius:10px;background:var(--surface-soft);width:max-content}
.vbtn{padding:6px 16px;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--muted);cursor:pointer;font-size:13px;font-weight:600;transition:all .15s}
.vbtn:hover{border-color:var(--accent);color:var(--text)}
.vbtn.active{background:var(--accent);color:#fff;border-color:var(--accent)}
@media (max-width: 980px){
  .ctrl-group--filters{grid-template-columns:1fr 1fr}
  .select-field--project{grid-column:1 / -1}
  .toggle-zero{grid-column:1 / -1;padding-left:0}
}
@media (max-width: 640px){
  #app{padding:12px 10px}
  .top-panel{padding:12px}
  .controls{gap:8px}
  .ctrl-group--filters{grid-template-columns:1fr}
  .proj-trigger{max-width:100%}
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
.tbl-wrap{background:var(--surface);border:1px solid var(--border);border-radius:8px;overflow:auto;flex:1 1 0;min-height:0;scrollbar-width:thin;scrollbar-color:var(--border) transparent}
.tbl-wrap::-webkit-scrollbar{width:6px;height:6px}
.tbl-wrap::-webkit-scrollbar-track{background:transparent}
.tbl-wrap::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px}
.tbl-wrap::-webkit-scrollbar-thumb:hover{background:var(--muted)}
table{width:100%;border-collapse:collapse;table-layout:fixed}
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

tbody tr.pr{cursor:pointer;transition:background .1s}
tbody tr.pr:hover{background:var(--hover)}
tbody tr.pr.open{background:var(--hover)}
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

.detail{padding:12px 16px 16px 38px;background:var(--bg)}
.d-section{margin-bottom:10px}
.d-label{font-size:11px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:5px}
.pats{display:flex;gap:6px;flex-wrap:wrap}
.pat-chip{background:var(--bg);border:1px solid var(--border);border-radius:5px;padding:3px 8px;font-size:12px}
.pat-chip .pcl{color:var(--muted)}
.pat-chip .pcc{font-weight:600;margin-left:3px}
.files-txt{font-size:12px;color:var(--muted);line-height:2}
.files-txt code{background:var(--bg);border:1px solid var(--border);border-radius:3px;padding:0 3px;font-family:'SFMono-Regular',Consolas,monospace;color:var(--text);font-size:11px}
.files-txt .file-jump{background:var(--bg);border:1px solid var(--border);border-radius:3px;padding:0 3px;font-family:'SFMono-Regular',Consolas,monospace;color:var(--text);font-size:11px;cursor:pointer}
.files-txt .file-jump:hover{border-color:var(--accent);color:var(--accent)}
.files-txt .file-jump:focus-visible{outline:none;box-shadow:0 0 0 2px var(--focus-ring)}
.proj-usage-row{display:flex;flex-direction:column;gap:6px;margin-bottom:8px}
.proj-usage-row:last-child{margin-bottom:0}
.exs{display:flex;gap:5px;flex-wrap:wrap}
.ex-chip{background:var(--bg);border-radius:4px;padding:2px 6px;font-size:12px;font-family:'SFMono-Regular',Consolas,monospace}
.rec-txt{font-size:12px;color:var(--muted);font-style:italic}
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

.empty-state{padding:32px;text-align:center;color:var(--muted)}
</style>
</head>
<body>
<div id="app">
  <div class="top-panel">
    <header>
      <div class="hdr-title">
        <h1>Plugin Audit</h1>
        <span class="hdr-sub">PostCSS → Rust / Lightning CSS</span>
      </div>
      <div class="hdr-right">
        <span class="hdr-meta" id="hdr-meta"></span>
        <button class="theme-btn" id="theme-btn" title="Переключить тему" aria-label="Переключить тему">🌙</button>
      </div>
    </header>
    <div class="view-toggle">
      <button class="vbtn active" data-view="plugins">Плагины</button>
      <button class="vbtn" data-view="files">Файлы</button>
      <button class="vbtn" data-view="sources">Исходники</button>
    </div>
    <div class="controls">
    <div class="select-field" id="files-plugin-ctrl" style="display:none">
      <span class="ctrl-label">Плагины</span>
      <div class="proj-dropdown" id="files-plugin-dropdown">
        <button class="proj-trigger" id="files-plugin-trigger">
          <span id="files-plugin-trigger-label">Все плагины</span>
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
            <span class="trigger-arrow">▾</span>
          </button>
          <div class="proj-panel" id="complexity-panel"></div>
        </div>
      </label>
      <label class="toggle-zero">
        <input type="checkbox" id="hide-zero"> Скрыть нулевые
      </label>
    </div>
    </div>
  </div>
  <div id="plugins-section" style="display:flex;flex-direction:column;flex:1 1 0;min-height:0">
    <div class="filter-summary" id="filter-summary"></div>
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
</div>
<script>
const DATA = ${safeData};

const PRIORITY_CYCLE = ['critical','high','native','out-of-scope','removed'];
const PRIORITY_LABEL = {
  critical: 'Critical', high: 'High',
  native: 'Native', 'out-of-scope': 'Out of scope', removed: 'Removed'
};
const PRIORITY_WEIGHT = {critical:0,high:1,native:2,'out-of-scope':3,removed:4};
const LIGHTNING_LABEL = {yes:'Native', none:'None', partial:'Partial'};
const COMPLEXITY_LABEL = {trivial:'Trivial', low:'Low', medium:'Medium', high:'High', 'n/a':'N/A'};
const COMPLEXITY_WEIGHT = {trivial:0,low:1,medium:2,high:3,'n/a':4};

const COMPLEXITY_CYCLE = ['trivial','low','medium','high','n/a'];

const LS_KEY = 'plugin-audit-priorities';
const LS_COMPLEXITY_KEY = 'plugin-audit-complexities';
const LS_THEME_KEY = 'plugin-audit-theme';

let projSel = new Set();
let filters = new Set();
let complexityFilters = new Set();
let sortCol = 'order';
let sortDir = 1;
let hideZero = false;
let expanded = new Set();
let fileExpanded = new Set();
let filesProjKey = Object.keys(DATA.projects)[0] || '';
let filePluginFilters = new Set();
let sourceProjKey = Object.keys(DATA.projects)[0] || '';
let sourceSelectedFile = '';
let sourceHighlightLine = null;
let overrides = {};
let complexityOverrides = {};
let searchQuery = '';
let popover = { id: null, el: null };
let expandAll = false;

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

function getPlugins(keys) {
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
  return overrides[plugin.id] ?? plugin.priority;
}

function effectiveComplexity(plugin) {
  return complexityOverrides[plugin.id] ?? plugin.complexity;
}

function effectivePriorityById(id, plugins) {
  const p = plugins.find(x => x.id === id);
  return p ? effectivePriority(p) : 'out-of-scope';
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
  ['proj-panel', 'priority-panel', 'complexity-panel', 'files-plugin-panel'].forEach(id => {
    if (id !== exceptId) document.getElementById(id)?.classList.remove('open');
  });
}

function renderFilesProjTabs() {
  const projects = Object.keys(DATA.projects);
  const container = document.getElementById('files-proj-tabs');
  container.innerHTML = projects.map(key =>
    \`<button class="fptab\${filesProjKey === key ? ' active' : ''}" data-proj="\${escAttr(key)}">\${escHtml(key)}</button>\`
  ).join('');
  container.querySelectorAll('.fptab').forEach(btn => {
    btn.onclick = () => {
      filesProjKey = btn.dataset.proj;
      fileExpanded.clear();
      filePluginFilters.clear();
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
    if (filePluginFilters.size === 0) { triggerLabel.textContent = \`Все (\${plugins.length})\`; return; }
    if (filePluginFilters.size === 1) { triggerLabel.textContent = [...filePluginFilters][0]; return; }
    triggerLabel.textContent = \`Выбрано: \${filePluginFilters.size}\`;
  }

  function renderPanel() {
    panel.innerHTML = [
      \`<label class="proj-option all-option"><input type="checkbox" id="fpf-all" \${filePluginFilters.size === 0 ? 'checked' : ''}> Все (\${plugins.length})</label>\`,
      ...plugins.map(p =>
        \`<label class="proj-option"><input type="checkbox" data-plugin="\${escAttr(p.id)}" \${filePluginFilters.has(p.id) ? 'checked' : ''}> \${escHtml(p.id)}</label>\`
      ),
    ].join('');
    updateLabel();
    panel.querySelector('#fpf-all').onchange = () => {
      filePluginFilters.clear();
      fileExpanded.clear();
      renderPanel();
      renderFilesTable();
    };
    panel.querySelectorAll('[data-plugin]').forEach(cb => {
      cb.onchange = () => {
        const id = cb.dataset.plugin;
        if (cb.checked) filePluginFilters.add(id); else filePluginFilters.delete(id);
        fileExpanded.clear();
        renderPanel();
        renderFilesTable();
      };
    });
  }

  renderPanel();
  document.getElementById('files-plugin-trigger').onclick = e => {
    e.stopPropagation();
    const willOpen = !panel.classList.contains('open');
    closeOpenPanels('files-plugin-panel');
    panel.classList.toggle('open', willOpen);
  };
}

function renderFilesTable() {
  const plugins = getFilesPlugins();
  let rows = buildFileIndex(plugins);
  if (filePluginFilters.size > 0) {
    rows = rows.filter(r => r.plugins.some(p => filePluginFilters.has(p.id)));
  }
  document.getElementById('files-thead').innerHTML =
    \`<tr><th></th><th>Файл</th><th>Matches</th><th>Плагины</th></tr>\`;
  document.getElementById('files-tbody').innerHTML = rows.map(r => {
    const isOpen = fileExpanded.has(r.file);
    const sortedPlugins = r.plugins.slice().sort((a, b) => (PRIORITY_WEIGHT[a.priority] ?? 99) - (PRIORITY_WEIGHT[b.priority] ?? 99));
    const detailPlugins = filePluginFilters.size > 0 ? sortedPlugins.filter(p => filePluginFilters.has(p.id)) : sortedPlugins;
    const mainRow = \`
      <tr class="fr\${isOpen ? ' open' : ''}" data-file="\${escAttr(r.file)}">
        <td class="exp-col"><span class="exp-icon">\${isOpen ? '▼' : '▶'}</span></td>
        <td><span class="file-path">\${escHtml(r.file)}</span></td>
        <td><span class="matches">\${r.total}</span></td>
        <td><div class="plugin-chips">\${
          sortedPlugins.map(p => \`<span class="badge p-\${escAttr(effectivePriorityById(p.id, plugins))}">\${escHtml(p.id)} <span class="count-muted">\${p.count}</span></span>\`).join('')
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
                  <span class="badge p-\${escAttr(effectivePriorityById(p.id, plugins))}">\${escHtml(p.id)}</span>
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
    '<button class="fptab' + (sourceProjKey === key ? ' active' : '') + '" data-proj="' + escAttr(key) + '">' + escHtml(key) + '</button>'
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
  document.getElementById('plugins-section').style.display = isPlugins ? 'flex' : 'none';
  document.getElementById('files-section').style.display = isFiles ? 'flex' : 'none';
  document.getElementById('sources-section').style.display = isSources ? 'flex' : 'none';
  document.getElementById('plugins-filters-ctrl').style.display = isPlugins ? '' : 'none';
  document.getElementById('files-plugin-ctrl').style.display = isFiles ? '' : 'none';
  if (isFiles) renderFilesView();
  if (isSources) renderSourcesView();
}

function openFileInFilesView(filePath) {
  const projectKey = String(filePath).split('/')[0] || '';
  if (projectKey && DATA.projects[projectKey]) filesProjKey = projectKey;
  filePluginFilters.clear();
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
  loadTheme();
  loadOverrides();
  loadComplexityOverrides();
  const isDark = document.documentElement.classList.contains('dark');
  document.getElementById('theme-btn').textContent = isDark ? '☀️' : '🌙';
  document.getElementById('theme-btn').onclick = toggleTheme;
  ['proj-panel', 'priority-panel', 'complexity-panel', 'files-plugin-panel'].forEach(id => {
    const panel = document.getElementById(id);
    if (panel) panel.addEventListener('click', e => e.stopPropagation());
  });
  renderProjSel();
  renderAll();
  initPopover();
  initCxPopover();
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
    const allSel = projSel.size === 0;
    if (allSel) triggerLabel.textContent = \`Все (\${projects.length})\`;
    else if (projSel.size === 1) triggerLabel.textContent = [...projSel][0];
    else triggerLabel.textContent = \`Выбрано: \${projSel.size}\`;
  }

  function renderPanel() {
    const allSel = projSel.size === 0;
    panel.innerHTML = [
      \`<label class="proj-option all-option"><input type="checkbox" id="po-all" \${allSel ? 'checked' : ''}> Все (\${projects.length})</label>\`,
      ...projects.map(p =>
        \`<label class="proj-option"><input type="checkbox" data-proj="\${escAttr(p)}" \${projSel.has(p) ? 'checked' : ''}> \${escHtml(p)}</label>\`
      )
    ].join('');
    updateTriggerLabel();
    panel.querySelector('#po-all').onchange = () => {
      projSel.clear();
      expanded.clear(); expandAll = false;
      renderPanel(); renderAll();
    };
    panel.querySelectorAll('[data-proj]').forEach(cb => {
      cb.onchange = () => {
        const key = cb.dataset.proj;
        if (cb.checked) projSel.add(key);
        else projSel.delete(key);
        expanded.clear(); expandAll = false;
        renderPanel(); renderAll();
      };
    });
  }

  renderPanel();

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
  const selectedProjects = projSel.size === 0 ? Object.keys(DATA.projects) : [...projSel];
  const total = selectedProjects.reduce((s, k) => s + (DATA.projects[k]?.filesScanned ?? 0), 0);
  const date = DATA.generated ? DATA.generated.slice(0,10) : '';
  document.getElementById('hdr-meta').textContent = \`\${total} файлов · \${date}\`;
}

function renderFtabs() {
  const allPlugins = getPlugins();
  const plugins = allPlugins.filter(p => {
    if (hideZero && p.totalMatches === 0) return false;
    if (searchQuery && !p.id.toLowerCase().includes(searchQuery.toLowerCase())) return false;
    return true;
  });
  const counts = { all: plugins.length };
  for (const p of plugins) {
    const pr = effectivePriority(p);
    counts[pr] = (counts[pr] || 0) + 1;
  }
  const options = ['all','critical','high','native','out-of-scope','removed'];
  const labels = {
    all: 'Все', critical: 'Critical', high: 'High',
    native: 'Native', 'out-of-scope': 'Out of scope', removed: 'Removed'
  };
  const panel = document.getElementById('priority-panel');
  const triggerLabel = document.getElementById('priority-trigger-label');
  const available = options.filter(t => t !== 'all' && counts[t]);

  function updateLabel() {
    if (filters.size === 0) {
      triggerLabel.textContent = \`Все (\${counts.all ?? 0})\`;
    } else if (filters.size === 1) {
      const key = [...filters][0];
      triggerLabel.textContent = \`\${labels[key]} (\${counts[key] ?? 0})\`;
    } else {
      triggerLabel.textContent = \`Выбрано: \${filters.size}\`;
    }
  }

  panel.innerHTML = [
    \`<label class="proj-option all-option"><input type="checkbox" id="pr-all" \${filters.size === 0 ? 'checked' : ''}> Все (\${counts.all ?? 0})</label>\`,
    ...available.map(key =>
      \`<label class="proj-option"><input type="checkbox" data-priority="\${key}" \${filters.has(key) ? 'checked' : ''}> \${labels[key]} (\${counts[key] ?? 0})</label>\`
    )
  ].join('');
  updateLabel();

  panel.querySelector('#pr-all').onchange = () => {
    filters.clear();
    renderFtabs();
    renderBody();
  };
  panel.querySelectorAll('[data-priority]').forEach(cb => {
    cb.onchange = () => {
      const key = cb.dataset.priority;
      if (cb.checked) filters.add(key);
      else filters.delete(key);
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
    if (hideZero && p.totalMatches === 0) return false;
    if (searchQuery && !p.id.toLowerCase().includes(searchQuery.toLowerCase())) return false;
    return true;
  });
  const counts = { all: plugins.length };
  for (const p of plugins) {
    const cx = effectiveComplexity(p);
    counts[cx] = (counts[cx] || 0) + 1;
  }
  const options = ['all', ...COMPLEXITY_CYCLE];
  const labels = { all: 'Все', trivial: 'Trivial', low: 'Low', medium: 'Medium', high: 'High', 'n/a': 'N/A' };
  const panel = document.getElementById('complexity-panel');
  const triggerLabel = document.getElementById('complexity-trigger-label');
  const available = options.filter(t => t !== 'all' && counts[t]);

  function updateLabel() {
    if (complexityFilters.size === 0) {
      triggerLabel.textContent = \`Все (\${counts.all ?? 0})\`;
    } else if (complexityFilters.size === 1) {
      const key = [...complexityFilters][0];
      triggerLabel.textContent = \`\${labels[key]} (\${counts[key] ?? 0})\`;
    } else {
      triggerLabel.textContent = \`Выбрано: \${complexityFilters.size}\`;
    }
  }

  panel.innerHTML = [
    \`<label class="proj-option all-option"><input type="checkbox" id="cx-all" \${complexityFilters.size === 0 ? 'checked' : ''}> Все (\${counts.all ?? 0})</label>\`,
    ...available.map(key =>
      \`<label class="proj-option"><input type="checkbox" data-complexity="\${key}" \${complexityFilters.has(key) ? 'checked' : ''}> \${labels[key]} (\${counts[key] ?? 0})</label>\`
    )
  ].join('');
  updateLabel();

  panel.querySelector('#cx-all').onchange = () => {
    complexityFilters.clear();
    renderCxtabs();
    renderBody();
  };
  panel.querySelectorAll('[data-complexity]').forEach(cb => {
    cb.onchange = () => {
      const key = cb.dataset.complexity;
      if (cb.checked) complexityFilters.add(key);
      else complexityFilters.delete(key);
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
    {key:'lightning', label:'Lightning CSS', title:'Поддержка в Lightning CSS: yes / partial / none'},
    {key:'complexity', label:'Сложность', title:'Сложность реализации в Rust Pre-stage'},
    {key:'priority', label:'Приоритет', title:'Приоритет миграции (кликни на бейдж для изменения)'},
    {key:'matches', label:'Matches', title:'Количество совпадений паттернов во всех файлах'},
  ];
  document.getElementById('thead').innerHTML = \`<tr>\${cols.map(c => {
    const sorted = sortCol === c.key;
    const arrow = sorted ? (sortDir > 0 ? '↑' : '↓') : '↕';
    const ariaSort = sorted ? (sortDir > 0 ? 'ascending' : 'descending') : 'none';
    return \`<th class="\${sorted ? 'sorted' : ''}" data-col="\${c.key}" title="\${escAttr(c.title)}" aria-sort="\${ariaSort}">\${c.label}<span class="sort-arrow">\${arrow}</span></th>\`;
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
    if (hideZero && p.totalMatches === 0) return false;
    if (filters.size > 0 && !filters.has(effectivePriority(p))) return false;
    if (complexityFilters.size > 0 && !complexityFilters.has(effectiveComplexity(p))) return false;
    if (searchQuery && !p.id.toLowerCase().includes(searchQuery.toLowerCase())) return false;
    return true;
  });
  renderFilterSummary(allPlugins.length, plugins.length);

  const sorted = [...plugins].sort((a, b) => {
    let av, bv;
    if (sortCol === 'order') { av = a.order; bv = b.order; }
    else if (sortCol === 'matches') { av = a.totalMatches; bv = b.totalMatches; }
    else if (sortCol === 'id') { av = a.id; bv = b.id; }
    else if (sortCol === 'lightning') { av = a.lightning; bv = b.lightning; }
    else if (sortCol === 'complexity') {
      av = COMPLEXITY_WEIGHT[a.complexity] ?? 99;
      bv = COMPLEXITY_WEIGHT[b.complexity] ?? 99;
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
            <div class="exs">\${p.patterns.flatMap(pat => pat.examples.slice(0,2))
              .slice(0,8).map(e => \`<code class="ex-chip">\${escHtml(e.slice(0,70))}</code>\`).join('')}</div>
          </div>\` : ''}
          \${projectUsageList.length ? \`
          <div class="d-section">
            <div class="d-label">Проекты (\${projectUsageList.length})</div>
            <div>\${projectUsageList.map(item => \`
              <div class="proj-usage-row">
                <div class="pats"><span class="pat-chip"><span class="pcl">\${escHtml(item.project)}</span><span class="pcc">\${item.matches} / \${item.filesCount} ф.</span></span></div>
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
          <div class="d-section">
            <div class="d-label">Рекомендация</div>
            <div class="rec-txt">\${escHtml(p.recommendation)}</div>
          </div>
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
      <td><span class="badge cx-\${ec === 'n/a' ? 'na' : ec} cxbadge" data-id="\${escAttr(p.id)}" title="Изменить сложность">\${COMPLEXITY_LABEL[ec] ?? ec}\${cxDotHtml}</span></td>
      <td><span class="badge p-\${ep} pbadge" data-id="\${escAttr(p.id)}" title="Изменить приоритет">\${PRIORITY_LABEL[ep]}\${dotHtml}</span></td>
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
  popover.el.innerHTML = PRIORITY_CYCLE.map(val =>
    \`<div class="popover-row\${cur === val ? ' current' : ''}" data-val="\${val}">\${PRIORITY_LABEL[val]}</div>\`
  ).join('');
  popover.el.querySelectorAll('.popover-row').forEach(row => {
    row.onclick = e => {
      e.stopPropagation();
      const next = row.dataset.val;
      if (next === plugin.priority) delete overrides[pluginId];
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
  cxPopover.el.innerHTML = COMPLEXITY_CYCLE.map(val =>
    \`<div class="popover-row\${cur === val ? ' current' : ''}" data-val="\${val}">\${COMPLEXITY_LABEL[val]}</div>\`
  ).join('');
  cxPopover.el.querySelectorAll('.popover-row').forEach(row => {
    row.onclick = e => {
      e.stopPropagation();
      const next = row.dataset.val;
      if (next === plugin.complexity) delete complexityOverrides[pluginId];
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
  if (filters.size > 0) parts.push(\`приоритет: <b>\${[...filters].join(', ')}</b>\`);
  if (complexityFilters.size > 0) parts.push(\`сложность: <b>\${[...complexityFilters].join(', ')}</b>\`);
  if (searchQuery) parts.push(\`поиск: <b>\${escHtml(searchQuery)}</b>\`);
  if (hideZero) parts.push('скрыты нулевые');
  const el = document.getElementById('filter-summary');
  if (parts.length === 0) { el.textContent = ''; return; }
  el.innerHTML = \`Показано \${shown} из \${total} · \${parts.join(' · ')} · <a id="reset-filters">Сбросить</a>\`;
  document.getElementById('reset-filters').onclick = () => {
    filters.clear(); complexityFilters.clear(); searchQuery = ''; hideZero = false;
    document.getElementById('search-input').value = '';
    document.getElementById('hide-zero').checked = false;
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

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function escAttr(s) { return escHtml(s); }

document.getElementById('hide-zero').onchange = e => {
  hideZero = e.target.checked;
  renderFtabs(); renderCxtabs(); renderBody();
};

init();
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const { allFiles, projects, sources } = scanByProject(INPUT_DIR);

if (allFiles.length === 0) {
  console.log(`No CSS files found in: ${INPUT_DIR}`);
  console.log(`Add anonymized project CSS files to: ${INPUT_DIR}/project-a/`);
  process.exit(0);
}

console.log(`Scanning ${allFiles.length} CSS files across ${Object.keys(projects).length} project(s)...`);

const generatedDate = new Date().toISOString();

const DEFAULT_REPORT_DIR = path.join(ROOT, 'test/style_pipeline/usage-audit/report');

if (FORMAT === 'html') {
  const html = renderHtml(projects, sources, generatedDate);
  const out = OUTPUT_PATH ?? path.join(DEFAULT_REPORT_DIR, 'plugin-usage.html');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, html, 'utf8');
  console.log(`HTML report written to: ${out}`);

} else if (FORMAT === 'json') {
  const json = JSON.stringify({ generated: generatedDate, projects }, null, 2);
  const out = OUTPUT_PATH ?? path.join(DEFAULT_REPORT_DIR, 'plugin-usage.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, json, 'utf8');
  console.log(`JSON report written to: ${out}`);

} else if (FORMAT === 'markdown') {
  const md = renderMarkdown(projects, generatedDate);
  const out = OUTPUT_PATH ?? path.join(DEFAULT_REPORT_DIR, 'plugin-usage.md');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, md, 'utf8');
  console.log(`Markdown report written to: ${out}`);

} else {
  // FORMAT === 'all' (default): write all three formats
  fs.mkdirSync(DEFAULT_REPORT_DIR, { recursive: true });

  const mdPath   = path.join(DEFAULT_REPORT_DIR, 'plugin-usage.md');
  const jsonPath = path.join(DEFAULT_REPORT_DIR, 'plugin-usage.json');
  const htmlPath = path.join(DEFAULT_REPORT_DIR, 'plugin-usage.html');

  fs.writeFileSync(mdPath,   renderMarkdown(projects, generatedDate), 'utf8');
  fs.writeFileSync(jsonPath, JSON.stringify({ generated: generatedDate, projects }, null, 2), 'utf8');
  fs.writeFileSync(htmlPath, renderHtml(projects, sources, generatedDate), 'utf8');

  // Console summary
  console.log('\n=== Plugin Usage Summary ===\n');
  const firstPlugins = Object.values(projects)[0]?.plugins ?? [];
  const maxId = Math.max(...firstPlugins.map(r => r.id.length));
  for (const r of firstPlugins) {
    const icon = r.lightning.startsWith('yes') ? '🟢' : r.lightning.startsWith('none') ? '🔴' : '🟡';
    const status = r.totalMatches === 0
      ? '   0  ⚪'
      : `${String(r.totalMatches).padStart(4)}  ${icon}`;
    console.log(`  ${r.id.padEnd(maxId)}  ${status}  [${r.priority}]`);
  }
  console.log(`\nMarkdown: ${mdPath}`);
  console.log(`JSON:     ${jsonPath}`);
  console.log(`HTML:     ${htmlPath}`);
}
