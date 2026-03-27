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
    recommendation: 'Rust Pre-stage (обязательный)',
    patterns: [
      { label: '@import string',   re: /@import\s+["']/gm },
      { label: '@import url()',     re: /@import\s+url\(/gm },
    ],
  },
  {
    id: 'postcss-mixins',
    order: 2,
    lightning: 'none',
    priority: 'critical',
    recommendation: 'Rust Pre-stage (обязательный)',
    patterns: [
      { label: '@define-mixin',             re: /@define-mixin\s+\w+/gm },
      { label: '@define-mixin with params', re: /@define-mixin\s+\w+\s+\$\w+/gm },
      { label: '@mixin call',               re: /@mixin\s+\w+/gm },
      { label: '@mixin-content',            re: /@mixin-content/gm },
    ],
  },
  {
    id: 'postcss-axis',
    order: 3,
    lightning: 'none',
    priority: 'high',
    recommendation: 'Rust Pre-stage (обязательный — 32 matches подтверждены)',
    patterns: [
      { label: 'margin-x/y',   re: /\bmargin-[xy]\s*:/gm },
      { label: 'padding-x/y',  re: /\bpadding-[xy]\s*:/gm },
      { label: 'border-x/y',   re: /\bborder-[xy]\s*:/gm },
      { label: 'inset-x/y',    re: /\binset-[xy]\s*:/gm },
    ],
  },
  {
    id: 'postcss-property-lookup',
    order: 4,
    lightning: 'none',
    priority: 'out-of-scope',
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
    recommendation: 'Rust Pre-stage (обязательный)',
    patterns: [
      { label: 'width()',   re: /\bwidth\(['"]/gm },
      { label: 'height()',  re: /\bheight\(['"]/gm },
      { label: 'resolve()', re: /\bresolve\(['"]/gm },
      { label: 'inline()',  re: /\binline\(['"]/gm },
      { label: 'size()',    re: /\bsize\(['"]/gm },
    ],
  },
  {
    id: 'postcss-advanced-variables',
    order: 6,
    lightning: 'none',
    priority: 'critical',
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
  },
  {
    id: 'postcss-color-function',
    order: 7,
    lightning: 'partial',
    priority: 'out-of-scope',
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
    recommendation: '⚠️ Rust Pre-stage обязателен — Lightning CSS не поддерживает BEM-конкатенацию',
    patterns: [
      { label: '&__element',      re: /&__[\w-]+/gm },
      { label: '&--modifier',     re: /&--[\w-]+/gm },
      { label: 'prefix& (a&)',    re: /[a-zA-Z]&(?=[^{])/gm },
    ],
  },
  {
    id: 'postcss-nested (standard)',
    order: 10,
    lightning: 'yes',
    priority: 'native',
    recommendation: 'Lightning CSS покрывает стандартные комбинаторы нативно',
    patterns: [
      { label: '&:pseudo',        re: /&:/gm },
      { label: '&.class',         re: /&\./gm },
      { label: '& > child',       re: /&\s*>/gm },
      { label: '& + sibling',     re: /&\s*\+/gm },
      { label: '& ~ sibling',     re: /&\s*~/gm },
      { label: '&[attr]',         re: /&\[/gm },
    ],
  },
  {
    id: 'postcss-extend',
    order: 11,
    lightning: 'none',
    priority: 'out-of-scope',
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
    recommendation: 'Lightning CSS native — встроенная оптимизация calc()',
    patterns: [
      { label: 'calc() usage', re: /\bcalc\([^)]+\)/gm },
    ],
  },
  {
    id: 'postcss-svg',
    order: 13,
    lightning: 'none',
    priority: 'high',
    recommendation: 'Rust Pre-stage (обязательный) — проверить $var в параметрах',
    patterns: [
      { label: 'svg() no params',       re: /(?<![a-z-])svg\(['"]/gm },
      { label: 'svg() with fill/rules', re: /(?<![a-z-])svg\(['"][^'"]+['"],/gm },
      { label: 'svg() fragment #id',    re: /(?<![a-z-])svg\(['"][^'"]*#[\w-]+['"]/gm },
    ],
  },
  {
    id: 'postcss-url',
    order: 14,
    lightning: 'none',
    priority: 'medium',
    recommendation: 'Rust Pre-stage (rewrite-only)',
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
    recommendation: 'Lightning CSS native — проверить browserslist targets mapping',
    patterns: [
      { label: 'browserslist comment', re: /browsers(?:list)?:\s*['"]/gim },
    ],
  },
  {
    id: 'postcss-data-packer',
    order: 18,
    lightning: 'none',
    priority: 'removed',
    recommendation: 'Намеренно удалён — данные inline в mainX.css, _data.css больше не генерируется',
    patterns: [
      { label: 'data: image inline',    re: /url\(['"]data:image\/[^'"]+['"]\)/gm },
      { label: 'data: font inline',     re: /url\(['"]data:(?:application\/|font\/)[^'"]+['"]\)/gm },
      { label: '_data.css ref (built)', re: /url\(['"][^'"]*_data\.css#/gm },
    ],
  },
];

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
      recommendation: plugin.recommendation,
      totalMatches: 0,
      patterns: [],
    };

    for (const pat of plugin.patterns) {
      const patResult = { label: pat.label, count: 0, examples: [], files: new Set() };

      for (const file of files) {
        const content = fs.readFileSync(file, 'utf8');
        const relPath = path.relative(inputDir, file).replace(/\\/g, '/');
        const matches = content.match(pat.re) ?? [];

        if (matches.length > 0) {
          patResult.count += matches.length;
          patResult.files.add(relPath);
          for (const m of matches) {
            const trimmed = m.trim();
            if (patResult.examples.length < 3 && !patResult.examples.includes(trimmed)) {
              patResult.examples.push(trimmed);
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

  for (const file of allFiles) {
    const rel = path.relative(inputDir, file).replace(/\\/g, '/');
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
  return { allFiles, projects };
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

function renderHtml(projects, generatedDate) {
  const safeData = JSON.stringify({ generated: generatedDate, projects })
    .replace(/<\/script>/gi, '<\\/script>');

  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>intcss Plugin Audit</title>
<style>
:root {
  --bg: #f8fafc; --surface: #fff; --border: #e2e8f0; --text: #1e293b;
  --muted: #64748b; --accent: #3b82f6;
  --critical-bg: #fee2e2; --critical: #dc2626;
  --high-bg: #fff7ed;     --high: #c2410c;
  --medium-bg: #fefce8;   --medium: #a16207;
  --native-bg: #dcfce7;   --native: #15803d;
  --scope-bg: #f1f5f9;    --scope: #64748b;
  --removed-bg: #f1f5f9;  --removed: #94a3b8;
}
*{box-sizing:border-box;margin:0;padding:0}
body{font:14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:var(--bg);color:var(--text)}
#app{max-width:1200px;margin:0 auto;padding:24px 16px}

header{display:flex;align-items:center;gap:12px;margin-bottom:20px;flex-wrap:wrap}
h1{font-size:18px;font-weight:700}
.hdr-meta{color:var(--muted);font-size:12px;margin-left:auto}
select{padding:5px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);font-size:13px;cursor:pointer}

.controls{display:flex;align-items:center;gap:12px;margin-bottom:12px;flex-wrap:wrap}
.filter-tabs{display:flex;gap:4px;flex-wrap:wrap}
.fbtn{padding:4px 12px;border:1px solid var(--border);border-radius:20px;background:var(--surface);cursor:pointer;font-size:12px;transition:all .1s;white-space:nowrap}
.fbtn:hover{border-color:var(--accent)}
.fbtn.active{background:var(--accent);color:#fff;border-color:var(--accent)}
.toggle-zero{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--muted);cursor:pointer;margin-left:auto;white-space:nowrap}
.toggle-zero input{cursor:pointer}

.tbl-wrap{background:var(--surface);border:1px solid var(--border);border-radius:8px;overflow:hidden}
table{width:100%;border-collapse:collapse}
thead th{background:#f8fafc;padding:9px 12px;text-align:left;font-size:11px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;border-bottom:1px solid var(--border);cursor:pointer;white-space:nowrap;user-select:none}
thead th:hover{color:var(--text)}
thead th.sorted{color:var(--accent)}
thead th .sort-arrow{margin-left:4px;opacity:.5}
thead th.sorted .sort-arrow{opacity:1}

tbody tr.pr{cursor:pointer;transition:background .1s}
tbody tr.pr:hover{background:#f8fafc}
tbody tr.pr.open{background:#f8fafc}
tbody tr.pr td{padding:10px 12px;border-bottom:1px solid var(--border);vertical-align:middle}
tbody tr.dr td{padding:0;border-bottom:1px solid var(--border)}
tbody tr.hidden{display:none}

.exp-icon{display:inline-block;width:14px;font-size:10px;color:var(--muted);transition:transform .15s}
.open .exp-icon{transform:rotate(90deg)}

.plugin-name{font-weight:500}
.plugin-order{font-size:11px;color:var(--muted);margin-left:4px}

.badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;white-space:nowrap}
.p-critical{background:var(--critical-bg);color:var(--critical)}
.p-high{background:var(--high-bg);color:var(--high)}
.p-medium{background:var(--medium-bg);color:var(--medium)}
.p-native{background:var(--native-bg);color:var(--native)}
.p-out-of-scope{background:var(--scope-bg);color:var(--scope)}
.p-removed{background:var(--removed-bg);color:var(--removed)}

.l-yes{background:var(--native-bg);color:var(--native)}
.l-none{background:var(--critical-bg);color:var(--critical)}
.l-partial{background:var(--high-bg);color:var(--high)}

.pbadge{cursor:pointer}
.pbadge:hover{opacity:.75}
.pbadge:active{opacity:.6}

.matches{font-weight:600}
.matches-zero{color:var(--muted);font-weight:400}

.detail{padding:12px 16px 16px 38px;background:#fafbfc}
.d-section{margin-bottom:10px}
.d-label{font-size:11px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:5px}
.pats{display:flex;gap:6px;flex-wrap:wrap}
.pat-chip{background:var(--bg);border:1px solid var(--border);border-radius:5px;padding:3px 8px;font-size:12px}
.pat-chip .pcl{color:var(--muted)}
.pat-chip .pcc{font-weight:600;margin-left:3px}
.files-txt{font-size:12px;color:var(--muted);line-height:2}
.files-txt code{background:var(--bg);border:1px solid var(--border);border-radius:3px;padding:0 3px;font-family:'SFMono-Regular',Consolas,monospace;color:var(--text);font-size:11px}
.exs{display:flex;gap:5px;flex-wrap:wrap}
.ex-chip{background:#f1f5f9;border-radius:4px;padding:2px 6px;font-size:12px;font-family:'SFMono-Regular',Consolas,monospace}
.rec-txt{font-size:12px;color:var(--muted);font-style:italic}

.empty-state{padding:32px;text-align:center;color:var(--muted)}
</style>
</head>
<body>
<div id="app">
  <header>
    <h1>intcss Plugin Audit</h1>
    <select id="proj-sel"></select>
    <span class="hdr-meta" id="hdr-meta"></span>
  </header>
  <div class="controls">
    <div class="filter-tabs" id="ftabs"></div>
    <label class="toggle-zero">
      <input type="checkbox" id="hide-zero"> Скрыть нулевые
    </label>
  </div>
  <div class="tbl-wrap">
    <table>
      <thead id="thead"></thead>
      <tbody id="tbody"></tbody>
    </table>
  </div>
</div>
<script>
const DATA = ${safeData};

const PRIORITY_CYCLE = ['critical','high','medium','native','out-of-scope','removed'];
const PRIORITY_LABEL = {
  critical: '🔴 Critical', high: '🟠 High', medium: '🟡 Medium',
  native: '🟢 Native', 'out-of-scope': '⚪ Out of scope', removed: '🔘 Removed'
};
const PRIORITY_WEIGHT = {critical:0,high:1,medium:2,native:3,'out-of-scope':4,removed:5};
const LIGHTNING_LABEL = {yes:'✅ Native', none:'❌ None', partial:'⚠️ Partial'};

const LS_KEY = 'plugin-audit-priorities';

let proj = Object.keys(DATA.projects)[0] || '';
let filter = 'all';
let sortCol = 'order';
let sortDir = 1;
let hideZero = false;
let expanded = new Set();
let overrides = {};

function loadOverrides() {
  try { overrides = JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch { overrides = {}; }
}
function saveOverrides() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(overrides)); } catch {}
}

function getPlugins() {
  return DATA.projects[proj]?.plugins || [];
}

function effectivePriority(plugin) {
  return overrides[plugin.id] ?? plugin.priority;
}

function init() {
  loadOverrides();
  renderProjSel();
  renderAll();
}

function renderAll() {
  renderMeta();
  renderFtabs();
  renderHead();
  renderBody();
}

function renderProjSel() {
  const sel = document.getElementById('proj-sel');
  sel.innerHTML = Object.keys(DATA.projects).map(p =>
    \`<option value="\${p}" \${p === proj ? 'selected' : ''}>\${p}</option>\`
  ).join('');
  sel.onchange = e => { proj = e.target.value; expanded.clear(); renderAll(); };
}

function renderMeta() {
  const d = DATA.projects[proj];
  const date = DATA.generated ? DATA.generated.slice(0,10) : '';
  document.getElementById('hdr-meta').textContent =
    \`\${d?.filesScanned ?? 0} файлов · \${date}\`;
}

function renderFtabs() {
  const plugins = getPlugins();
  const counts = { all: plugins.length };
  for (const p of plugins) {
    const pr = effectivePriority(p);
    counts[pr] = (counts[pr] || 0) + 1;
  }
  const tabs = ['all','critical','high','medium','native','out-of-scope','removed'];
  const labels = {
    all: 'Все', critical: '🔴 Critical', high: '🟠 High', medium: '🟡 Medium',
    native: '🟢 Native', 'out-of-scope': '⚪ Out of scope', removed: '🔘 Removed'
  };
  const ftabs = document.getElementById('ftabs');
  ftabs.innerHTML = tabs.filter(t => t === 'all' || counts[t]).map(t =>
    \`<button class="fbtn\${filter === t ? ' active' : ''}" data-filter="\${t}">\${labels[t]}\${counts[t] ? \` (\${counts[t]})\` : ''}</button>\`
  ).join('');
  ftabs.querySelectorAll('.fbtn').forEach(btn => {
    btn.onclick = () => { filter = btn.dataset.filter; renderFtabs(); renderBody(); };
  });
}

function renderHead() {
  const cols = [
    {key:'order', label:'#'},
    {key:'id', label:'Плагин'},
    {key:'lightning', label:'Lightning CSS'},
    {key:'priority', label:'Приоритет'},
    {key:'matches', label:'Matches'},
  ];
  document.getElementById('thead').innerHTML = \`<tr>\${cols.map(c => {
    const sorted = sortCol === c.key;
    const arrow = sorted ? (sortDir > 0 ? '↑' : '↓') : '↕';
    return \`<th class="\${sorted ? 'sorted' : ''}" data-col="\${c.key}">\${c.label}<span class="sort-arrow">\${arrow}</span></th>\`;
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
  const plugins = getPlugins().filter(p => {
    if (hideZero && p.totalMatches === 0) return false;
    if (filter !== 'all' && effectivePriority(p) !== filter) return false;
    return true;
  });

  const sorted = [...plugins].sort((a, b) => {
    let av, bv;
    if (sortCol === 'order') { av = a.order; bv = b.order; }
    else if (sortCol === 'matches') { av = a.totalMatches; bv = b.totalMatches; }
    else if (sortCol === 'id') { av = a.id; bv = b.id; }
    else if (sortCol === 'lightning') { av = a.lightning; bv = b.lightning; }
    else if (sortCol === 'priority') {
      av = PRIORITY_WEIGHT[effectivePriority(a)] ?? 99;
      bv = PRIORITY_WEIGHT[effectivePriority(b)] ?? 99;
    }
    if (av < bv) return -sortDir;
    if (av > bv) return sortDir;
    return a.order - b.order;
  });

  const tbody = document.getElementById('tbody');
  if (sorted.length === 0) {
    tbody.innerHTML = \`<tr><td colspan="5"><div class="empty-state">Нет плагинов для выбранного фильтра</div></td></tr>\`;
    return;
  }

  const rows = sorted.flatMap(p => {
    const ep = effectivePriority(p);
    const isOpen = expanded.has(p.id);
    const matchHits = p.patterns.filter(pat => pat.count > 0);
    const allFiles = [...new Set(matchHits.flatMap(pat => pat.files))].sort();

    const lightKey = p.lightning.startsWith('yes') ? 'yes' : p.lightning.startsWith('none') ? 'none' : 'partial';

    const detailHtml = isOpen ? \`<tr class="dr" id="dr-\${CSS.escape(p.id)}">
      <td colspan="5">
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
          \${allFiles.length ? \`
          <div class="d-section">
            <div class="d-label">Файлы (\${allFiles.length})</div>
            <div class="files-txt">\${allFiles.slice(0,8).map(f => \`<code>\${escHtml(f)}</code>\`).join(' ')}\${allFiles.length > 8 ? \` <em>+\${allFiles.length - 8} ещё</em>\` : ''}</div>
          </div>\` : ''}
          <div class="d-section">
            <div class="d-label">Рекомендация</div>
            <div class="rec-txt">\${escHtml(p.recommendation)}</div>
          </div>
        </div>
      </td>
    </tr>\` : '';

    return \`<tr class="pr\${isOpen ? ' open' : ''}" data-id="\${escAttr(p.id)}">
      <td><span class="exp-icon">▶</span> <span class="plugin-order">\${p.order}</span></td>
      <td><span class="plugin-name">\${escHtml(p.id)}</span></td>
      <td><span class="badge l-\${lightKey}">\${LIGHTNING_LABEL[lightKey]}</span></td>
      <td><span class="badge p-\${ep} pbadge" data-id="\${escAttr(p.id)}" title="Нажми, чтобы изменить">\${PRIORITY_LABEL[ep]}</span></td>
      <td><span class="\${p.totalMatches === 0 ? 'matches-zero' : 'matches'}">\${p.totalMatches}</span></td>
    </tr>\${detailHtml}\`;
  });

  tbody.innerHTML = rows.join('');

  // Row click to expand
  tbody.querySelectorAll('tr.pr').forEach(tr => {
    tr.onclick = e => {
      if (e.target.closest('.pbadge')) return;
      const id = tr.dataset.id;
      if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
      renderBody();
    };
  });

  // Priority badge click
  tbody.querySelectorAll('.pbadge').forEach(badge => {
    badge.onclick = e => {
      e.stopPropagation();
      const id = badge.dataset.id;
      const plugin = getPlugins().find(p => p.id === id);
      if (!plugin) return;
      const cur = effectivePriority(plugin);
      const idx = PRIORITY_CYCLE.indexOf(cur);
      const next = PRIORITY_CYCLE[(idx + 1) % PRIORITY_CYCLE.length];
      if (next === plugin.priority) delete overrides[id];
      else overrides[id] = next;
      saveOverrides();
      renderFtabs();
      renderBody();
    };
  });
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function escAttr(s) { return escHtml(s); }

document.getElementById('hide-zero').onchange = e => {
  hideZero = e.target.checked;
  renderBody();
};

init();
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const { allFiles, projects } = scanByProject(INPUT_DIR);

if (allFiles.length === 0) {
  console.log(`No CSS files found in: ${INPUT_DIR}`);
  console.log(`Add anonymized project CSS files to: ${INPUT_DIR}/project-a/`);
  process.exit(0);
}

console.log(`Scanning ${allFiles.length} CSS files across ${Object.keys(projects).length} project(s)...`);

const generatedDate = new Date().toISOString();

const DEFAULT_REPORT_DIR = path.join(ROOT, 'test/style_pipeline/usage-audit/report');

if (FORMAT === 'html') {
  const html = renderHtml(projects, generatedDate);
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
  fs.writeFileSync(htmlPath, renderHtml(projects, generatedDate), 'utf8');

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
