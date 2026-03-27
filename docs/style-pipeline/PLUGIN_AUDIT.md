# Анализ плагинов intcss: карта использования и покрытие Lightning CSS

## Цель

Для каждого из 18 плагинов: описание, покрытие Lightning CSS, рекомендация по переносу,
сложность. Затем — автоматизированный сбор usage по реальным проектным стилям.

---

## 18 плагинов: описание и рекомендации

| # | Плагин | Что делает | Lightning CSS | Рекомендация | Сложность |
|---|---|---|---|---|---|
| 1 | postcss-import | `@import` → inline файлов, circular detection | Нет | Rust Pre-stage | Средняя |
| 2 | postcss-mixins | `@define-mixin` / `@mixin` / `@mixin-content` | Нет | Rust Pre-stage | **Высокая** |
| 3 | postcss-axis | `margin-x/y`, `padding-x/y` → expand | Нет | Проверить usage → удалить или Low | Низкая |
| 4 | postcss-property-lookup | `width: @height` — ссылка на свойство | Нет | Out of scope | — |
| 5 | postcss-assets | `width()`, `height()`, `resolve()` — из файлов | Нет | Rust Pre-stage | Средняя |
| 6 | postcss-advanced-variables | `$var: value` / `$var` SCSS-переменные | Нет | Rust Pre-stage (только переменные) | Средняя |
| 7 | postcss-color-function | Legacy `color(red shade(10%))` | Частично | Out of scope (нет fixtures) | — |
| 8 | postcss-strip-units | `strip(10px)` → `10` | Нет | Out of scope | — |
| 9 | postcss-conditionals | `@if` / `@else` блоки | Нет | Out of scope | — |
| 10 | postcss-nested | Вложенные `&` — двойная природа ⚠️ | **Частично** | BEM → Rust Pre-stage; стандарт → Lightning | **Высокая** |
| 11 | postcss-extend | `@extend .class`, `%placeholder` | Нет | Rust Pre-stage | **Высокая** |
| 12 | postcss-calc | Упрощение `calc()` | **Да** | Lightning CSS native | — |
| 13 | postcss-svg | `svg('file', 'fill: red')` → data URL | Нет | Rust Pre-stage | Средняя |
| 14 | postcss-url | Rebase / inline `url(...)` | Нет | Rust Pre-stage (rewrite-only) | Средняя |
| 15 | postcss-svg-fallback | PNG fallback для SVG + `.no-svg` rules | Нет | Rust Post-stage (опционально) | **Высокая** |
| 16 | postcss-color-rgba-fallback | `rgba()` → hex fallback для IE8 | Нет | Out of scope (IE8 мёртв) | — |
| 17 | autoprefixer | Вендорные префиксы по browserslist | **Да** | Lightning CSS native | — |
| 18 | postcss-data-packer | Выносит data URI в `_data.css` | Нет | Намеренно удалён | — |

---

## Детали по каждому плагину

### 1. `postcss-import` — порядок: 1-й

Рекурсивно разворачивает `@import "path"` — вставляет содержимое файла inline.
Custom import roots (lib, bPath), дедупликация, circular-detection.
URL внутри импортированных файлов переписываются относительно нового контекста.

```css
/* До */
@import "variables";
@import "lib/mixins";
/* После — содержимое обоих файлов inline */
```

**Lightning CSS:** не разворачивает `@import` — ответственность bundler'а.
**Поиск:** `@import`
**Рекомендация:** обязательный Pre-stage.

---

### 2. `postcss-mixins` — порядок: 2-й

Переиспользуемые CSS-блоки. `@define-mixin` — определение, `@mixin` — вызов.
Параметры с default-значениями. `@mixin-content` — вставка произвольного блока внутрь.

```css
/* До */
@define-mixin clearfix { &::after { content: ""; display: table; clear: both; } }
.wrap { @mixin clearfix; }
/* После */
.wrap::after { content: ""; display: table; clear: both; }
```

**Lightning CSS:** нет.
**Поиск:** `@define-mixin`, `@mixin `, `@mixin-content`
**Рекомендация:** обязательный Pre-stage.
**Сложность:** параметры, scoping, `@mixin-content`, вложенные вызовы.

---

### 3. `postcss-axis` — порядок: 3-й

Shorthand `margin-x/y`, `padding-x/y` и другие осевые свойства → expand в пары.

```css
/* До */  .box { margin-x: 10px; padding-y: 20px; }
/* После */ .box { margin-left: 10px; margin-right: 10px; padding-top: 20px; padding-bottom: 20px; }
```

**Lightning CSS:** нет.
**Поиск:** `margin-x:`, `margin-y:`, `padding-x:`, `padding-y:`, `border-x:`, `border-y:`
**Рекомендация:** проверить usage в реальных проектах. Если не используется — **удалить**.

---

### 4. `postcss-property-lookup` — порядок: 4-й

Ссылка `@property-name` на другое свойство в том же правиле (Stylus-стиль).

```css
/* До */  .box { width: 100px; height: @width; }
/* После */  .box { width: 100px; height: 100px; }
```

**Lightning CSS:** нет.
**Поиск:** `: @[a-z][a-z-]+` (не `@import`/`@media`)
**Рекомендация:** out of scope. Нет evidence в проекте.

---

### 5. `postcss-assets` — порядок: 5-й

`width('img.png')`, `height('img.png')` → реальные пиксели файла.
`resolve('path')` → URL из load paths. `inline('path')` → base64 data URI.

```css
/* До */  .icon { width: width('sun.png'); background: url(resolve('sun.png')); }
/* После */  .icon { width: 48px; background: url('/img/dest/sun.png'); }
```

**Lightning CSS:** нет.
**Поиск:** `width(`, `height(`, `resolve(`, `inline(`
**Рекомендация:** обязательный Pre-stage; привязан к load paths из конфига.

---

### 6. `postcss-advanced-variables` — порядок: 6-й

`$name: value` — объявление, `$name` — подстановка. Также: `@for`, `@each`, `@if/@else`.
В проекте используются главным образом переменные.

```css
/* До */  $primary: #2f6ad9;  $size: 16px;  a { color: $primary; font-size: $size; }
/* После */  a { color: #2f6ad9; font-size: 16px; }
```

**Lightning CSS:** нет (CSS `--var` — другой механизм).
**Поиск:** `$[a-zA-Z][\w-]*\s*:` (объявление), `$[a-zA-Z]` (использование)
**Рекомендация:** Pre-stage для `$variable`. Контрол-флоу (`@for`, `@if`) — проверить usage.

---

### 7. `postcss-color-function` — порядок: 7-й

Legacy `color()` из старого W3C draft: `color(red shade(10%))`, `color(blue lighten(20%))`.
Трансформирует в `rgba()`/`rgb()`.

```css
/* До */  .box { background: color(red shade(10%)); }
/* После */  .box { background: rgba(229, 0, 0, 1); }
```

**Lightning CSS:** современный `color()` — да; `shade()/tint()/lighten()/darken()` — нет.
**Поиск:** `color.*shade(`, `color.*tint(`, `color.*lighten(`, `color.*darken(`
**Рекомендация:** out of scope. Нет fixtures. Если найдено — обсудить отдельно.

---

### 8. `postcss-strip-units` — порядок: 8-й

`strip(10px)` → `10`. Для CSS-вычислений без единиц измерения.

```css
/* До */  .box { line-height: calc(strip(16px) / strip(14px) * 1em); }
/* После */  .box { line-height: 1.142857em; }
```

**Lightning CSS:** нет.
**Поиск:** `strip(`
**Рекомендация:** out of scope. Нет fixtures.

---

### 9. `postcss-conditionals` — порядок: 9-й

`@if` / `@else if` / `@else` на основе значений переменных.

```css
/* До */  $env: prod;  body { @if $env == dev { outline: 1px red; } }
/* После */  body { }
```

**Lightning CSS:** нет.
**Поиск:** `@if `, `@else `
**Рекомендация:** out of scope. Нет fixtures.

---

### 10. `postcss-nested` — порядок: 10-й ⚠️

**Делает две разные вещи:**

**A) Стандартные комбинаторы** → Lightning CSS покрывает:
```css
.btn { &:hover { color: blue; } &.active { } & > .icon { } }
```

**B) BEM-конкатенация** → Lightning CSS НЕ покрывает:
```css
.Block { &__elem { } }   →   .Block__elem { }
.Block { &--mod { } }    →   .Block--mod { }
```

**Почему Lightning CSS не справляется с BEM:**
CSS Nesting spec — `&` ссылается на *selector*, а не конкатенирует строки.
`&__elem` Lightning CSS оставит как есть → невалидный CSS, стили не применятся.
Commit `7ea21b6`: "add narrow nested pre-transform for legacy ampersand patterns".

> ⚠️ **Ошибка в `DESIGN.md` строка 197:** "Covered by Lightning CSS nesting support"
> Верно: частично. BEM (`&__`, `&--`) требует Rust Pre-stage.

**Lightning CSS:** только стандартные комбинаторы.
**Поиск BEM:** `&__`, `&--`, `[a-z]&` (& не в начале)
**Поиск стандарт:** `&:`, `& >`, `& +`, `&.`, `& ~`
**Рекомендация:** Pre-stage для BEM обязателен. Проверить глубину вложенности в реальных проектах.

---

### 11. `postcss-extend` — порядок: 11-й

`@extend .selector` — добавляет текущий селектор к другому правилу (объединяет селекторы).
`%placeholder` — абстрактный селектор для extend (не попадает в output сам по себе).

```css
/* До */
%btn-base { padding: 10px; }
.btn-a { @extend %btn-base; background: blue; }
.btn-b { @extend %btn-base; background: gray; }
/* После */
.btn-a, .btn-b { padding: 10px; }
.btn-a { background: blue; }  .btn-b { background: gray; }
```

**Lightning CSS:** нет.
**Поиск:** `@extend [.%]`, `^\s*%[\w-]+\s*{`
**Рекомендация:** обязательный Pre-stage.
**Сложность:** двухпроходный анализ, порядок правил должен сохраняться.

---

### 12. `postcss-calc` — порядок: 12-й

Упрощает `calc()`: вычисляет константы (`10px + 5px` → `15px`),
несовместимые единицы (`100% - 20px`) оставляет как есть.

```css
/* До */  .box { padding: calc(10px + 5px); width: calc(100% - 20px); }
/* После */  .box { padding: 15px; width: calc(100% - 20px); }
```

**Lightning CSS:** да, встроенная оптимизация `calc()`.
**Рекомендация:** полностью покрыт Lightning CSS.

---

### 13. `postcss-svg` — порядок: 13-й

`svg('file.svg', 'fill: red; stroke: blue')` → data URL с изменёнными SVG-атрибутами.
Fragment identifiers: `svg('sprites.svg#icon-name')`.

```css
/* До */  .icon { background: svg('arrow.svg', 'fill: #2f6ad9'); }
/* После */  .icon { background: url("data:image/svg+xml,..."); }
```

**Lightning CSS:** нет.
**Поиск:** `\bsvg\(['"` (осторожно: не `background-svg`)
**Рекомендация:** обязательный Pre-stage. Проверить в проектах: переменные `$color` в параметрах, fragment ids.

---

### 14. `postcss-url` — порядок: 14-й

Rebase относительных `url(...)` к project root. Опционально: inline как data URI по size + filter.
Конфиг проекта: `maxSize: 1KB`, filter `/dest/|/lib/|/src/b/`.

```css
/* До */  .bg { background: url('../img/bg.png'); }
/* После */  .bg { background: url('/project/assets/img/bg.png'); }
```

**Lightning CSS:** не изменяет `url()`.
**Поиск:** `url(` (относительные и абсолютные пути)
**Рекомендация:** rewrite-only Pre-stage. Inline по size-threshold — вторичный.

---

### 15. `postcss-svg-fallback` — порядок: 15-й

Генерирует PNG-файлы для SVG в `url()`, добавляет `.no-svg .selector` правила.
Опциональный (env-toggle). Output: `img/svg_fallback/`.

```css
/* До */  .icon { background: url('icon.svg'); background-size: 32px; }
/* После (extra rule) */  .no-svg .icon { background-image: url('icon-32x32.png'); }
```

**Lightning CSS:** нет.
**Поиск:** `url.*\.svg` (не data URI)
**Рекомендация:** опциональный Post-stage. Нужен resvg для SVG→PNG.
Проверить: используется ли `.no-svg` в реальных проектах сейчас.

---

### 16. `postcss-color-rgba-fallback` — порядок: 16-й

Solid hex fallback перед `rgba()` для IE8 (alpha-blending с белым фоном).

```css
/* До */  .box { background: rgba(255, 0, 0, 0.5); }
/* После */  .box { background: #ff8080; background: rgba(255, 0, 0, 0.5); }
```

**Lightning CSS:** нет дублирующего fallback.
**Поиск:** `rgba(`
**Рекомендация:** out of scope. IE8 мёртв. Если найдено в проектах — обсудить актуальность.

---

### 17. `autoprefixer` — порядок: 17-й

Вендорные префиксы (`-webkit-`, `-moz-`, `-ms-`) по browserslist.
Проект: `last 5 versions, Chrome 27, ff 12, ie 8, ie 9, opera 12`.

```css
/* До */  .box { display: flex; user-select: none; }
/* После */  .box { display: -webkit-flex; display: flex; -webkit-user-select: none; user-select: none; }
```

**Lightning CSS:** да, встроенный prefixing через `targets`/browserslist.
**Рекомендация:** полностью покрыт Lightning CSS.
**Важно:** проверить что browserslist корректно транслируется в Lightning CSS targets.
Особенно `ie 8`, `ie 9`, `opera 12` — Lightning CSS может иметь другое покрытие prefix для них.

---

### 18. `postcss-data-packer` — порядок: 18-й

Извлекает `url(data:...)` из CSS → отдельный `_data.css`. Дедупликация данных.

```css
/* До */  .icon { background: url('data:image/svg+xml;base64,...'); }
/* После */  main.css → ссылка; _data.css → сами данные
```

**Lightning CSS:** нет.
**Рекомендация:** намеренно удалён. `_data.css` больше не генерируется, данные inline в `mainX.css`.
**Проверить в проектах:** нет ли зависимостей на `_data.css` в HTML/JS.

---

## Автоматизация: usage audit

### Структура в репозитории

```
test/style_pipeline/usage-audit/
  input/          ← анонимизированные source CSS (коммитить)
    project-a/
    project-b/
  built/          ← скомпилированный PostCSS output (опционально)
  report/         ← .gitignore, генерируется скриптом
    plugin-usage.md
    plugin-usage.json
```

### Скрипт `scripts/audit-plugin-usage.mjs`

```bash
npm run audit:plugins
# → сканирует test/style_pipeline/usage-audit/input/
# → создаёт report/ с Markdown + JSON
```

**Формат отчёта на каждый плагин:**
```markdown
## postcss-axis (order: 3)
Total matches: 0
⚠️ Not found — candidate for removal

## postcss-mixins (order: 2)
Total matches: 47
| Pattern        | Count | Example                   |
| @define-mixin  |   12  | `@define-mixin placeholder`|
| @mixin call    |   35  | `@mixin link;`            |
| @mixin-content |    3  | `@mixin-content;`         |
Files: project-a/_main.css, project-b/modules/_nav.css
```

### Паттерны по плагинам

```js
const PLUGINS = [
  { id: 'postcss-import',    patterns: [/@import\s+["']/gm, /@import\s+url\(/gm] },
  { id: 'postcss-mixins',    patterns: [/@define-mixin\s+\w+/gm, /@mixin\s+\w+/gm, /@mixin-content/gm] },
  { id: 'postcss-axis',      patterns: [/margin-[xy]\s*:/gm, /padding-[xy]\s*:/gm, /border-[xy]\s*:/gm] },
  { id: 'postcss-property-lookup', patterns: [/:\s*@[a-z][a-z-]+(?!\s*\()/gm] },
  { id: 'postcss-assets',    patterns: [/\bwidth\(['"]/gm, /\bheight\(['"]/gm, /\bresolve\(['"]/gm, /\binline\(['"]/gm] },
  { id: 'postcss-vars',      patterns: [/\$[a-zA-Z][\w-]*\s*:/gm, /@for\s+\$\w+/gm, /@if\s+/gm] },
  { id: 'postcss-color-fn',  patterns: [/\bcolor\([^)]*(?:shade|tint|lighten|darken)\(/gm] },
  { id: 'postcss-strip',     patterns: [/\bstrip\([^)]+\)/gm] },
  { id: 'postcss-cond',      patterns: [/@if\s+/gm, /@else\s/gm] },
  { id: 'postcss-nested-bem', patterns: [/&__[\w-]+/gm, /&--[\w-]+/gm, /[a-zA-Z]&/gm] },
  { id: 'postcss-nested-std', patterns: [/&\s*[>+~:.[]/gm] },
  { id: 'postcss-extend',    patterns: [/@extend\s+[.%]/gm, /^\s*%[\w-]+\s*\{/gm] },
  { id: 'postcss-calc',      patterns: [/\bcalc\([^)]+\)/gm] },
  { id: 'postcss-svg',       patterns: [/(?<![a-z-])svg\(['"]/gm] },
  { id: 'postcss-url',       patterns: [/url\(['"](?!data:|https?:)[^'"]+['"]\)/gm] },
  { id: 'postcss-svg-fb',    patterns: [/url\(['"][^'"]*\.svg['"]\)/gm] },
  { id: 'postcss-rgba-fb',   patterns: [/\brgba\(/gm] },
  { id: 'postcss-data',      patterns: [/url\(['"]data:/gm] },
]
```

### Что даёт built CSS дополнительно

| Плагин | Что проверить в built |
|---|---|
| data-packer | Наличие `_data.css`, ссылки `url('_data.css#...')` из main |
| svg-fallback | Наличие `.no-svg` правил |
| url | Корректность rebased путей |
| autoprefixer | Набор добавленных префиксов |

---

## Результат анализа

По итогам отчёта:
1. **Нулевой usage** → документировать как "out of scope" в `DESIGN.md`
2. **Есть usage** → зафиксировать конкретные конструкции в scope Rust-stage
3. **Edge-cases из реальных проектов** → добавить в fixtures для regression-тестов
