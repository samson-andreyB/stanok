# План миграции: intcss/postcss -> Rust + Lightning CSS

## 1) As-Is Baseline (что есть сейчас)

- Сборка стилей запускается из Rust-команды `build_styles` и через `run_build_orchestrated(...)` маршрутизируется в Node-скрипт `build-css.mjs` (`src-tauri/src/main.rs:310`, `src-tauri/src/main.rs:1545`, `src-tauri/src/main.rs:1592`).
- Выполнение в runtime использует Node sidecar + `NODE_PATH` для упакованных runtime-модулей (`src-tauri/src/main.rs:905`, `src-tauri/src/main.rs:910`, `scripts/prepare-sidecar-node.mjs:66`, `scripts/prepare-sidecar-node.mjs:75`).
- Входы CSS: все файлы, соответствующие `_main*.css` в `<style_dir>/src` (`scripts/build-css.mjs:135`, `scripts/build-css.mjs:137`).
- Выходы CSS: `<style_dir>/<main*.css>` + внешний sourcemap в `maps/<file>.map` (`scripts/build-css.mjs:292`, `scripts/build-css.mjs:293`, `scripts/build-css.mjs:295`, `scripts/build-css.mjs:303`).
- Дополнительные выходы:
  - опциональные SVG fallback assets (`scripts/build-css.mjs:71`, `scripts/build-css.mjs:282`, `scripts/build-css.mjs:284`);
  - дополнительный `_data.css` через `postcss-data-packer` (`scripts/build-css.mjs:267`, `scripts/build-css.mjs:270`).
- Цепочка плагинов централизована в `intcss` в фиксированном порядке (`node_modules/intcss/index.js:3`), затем регистрируется в цикле (`node_modules/intcss/index.js:114`, `node_modules/intcss/index.js:127`).
- CI/release проверяют наличие `build-css.mjs` и `intcss` в runtime-бандле (`.github/workflows/build-desktop-linux.yml:94`, `.github/workflows/build-desktop-linux.yml:97`, `.github/workflows/build-desktop-windows.yml:43`, `.github/workflows/build-desktop-macos.yml:54`, `.github/workflows/release.yml:127`).

## 2) Контракт intcss как Black-Box (выведен из кода)

### Контракт API/поведения

- `intcss` экспортирует один PostCSS plugin (`postcss.plugin('intcss', ...)`) (`node_modules/intcss/index.js:109`).
- Модель options:
  - каждый processor читает либо namespace-specific options (`options[namespace]`), либо полный root options object (`node_modules/intcss/index.js:115`);
  - defaults processor'а объединяются с options (`node_modules/intcss/index.js:118`, `node_modules/intcss/index.js:123`);
  - processor можно отключить через option `disable` (`node_modules/intcss/index.js:126`).
- Import transform переписывает относительные `url(...)` в URL в стиле absolute-from-project-root (`node_modules/intcss/import-transform.js:9`, `node_modules/intcss/import-transform.js:19`, `node_modules/intcss/import-transform.js:22`).

### Плагины, включенные в intcss (фактический порядок)

1. `postcss-import` (`node_modules/intcss/index.js:5`)
2. `postcss-mixins` (`node_modules/intcss/index.js:13`)
3. `postcss-axis` (`node_modules/intcss/index.js:18`)
4. `postcss-property-lookup` (`node_modules/intcss/index.js:25`)
5. `postcss-assets` (`node_modules/intcss/index.js:32`)
6. `postcss-advanced-variables` (`node_modules/intcss/index.js:37`)
7. `postcss-color-function` (`node_modules/intcss/index.js:42`)
8. `postcss-strip-units` (`node_modules/intcss/index.js:47`)
9. `postcss-conditionals` (`node_modules/intcss/index.js:52`)
10. `postcss-nested` (`node_modules/intcss/index.js:57`)
11. `postcss-extend` (`node_modules/intcss/index.js:62`)
12. `postcss-calc` (`node_modules/intcss/index.js:67`)
13. `postcss-svg` (`node_modules/intcss/index.js:72`)
14. `postcss-url` (`node_modules/intcss/index.js:80`)
15. `postcss-svg-fallback` (`node_modules/intcss/index.js:88`)
16. `postcss-color-rgba-fallback` (`node_modules/intcss/index.js:93`)
17. `autoprefixer` (`node_modules/intcss/index.js:98`)
18. `postcss-data-packer` (`node_modules/intcss/index.js:103`)

### Scope freeze по плагинам (не переносим в Rust pipeline текущей итерации)

- `postcss-property-lookup` (`node_modules/intcss/index.js:25`)
- `postcss-strip-units` (`node_modules/intcss/index.js:47`)
- `postcss-conditionals` (`node_modules/intcss/index.js:52`)
- `postcss-color-rgba-fallback` (`node_modules/intcss/index.js:93`)

### Версии, зафиксированные в репозитории

- `intcss` из git commit `034bbf...` (`package-lock.json:2031`).
- Внутренние зависимости `intcss` включают legacy `postcss@5` и набор плагинов выше (`package-lock.json:2033`).
- Корневые runtime-пакеты для копирования: `intcss`, `postcss5`, `assets` (`scripts/prepare-sidecar-node.mjs:75`).

## 3) Поэтапная стратегия миграции

## Output Contract

- Выбран вариант **A: per-entry** (без дополнительного breaking change относительно legacy контракта `<style_dir>/<main*.css>`).
- Для каждого входного файла `_mainX.css` в `<style_dir>/src` генерируется соответствующий итоговый CSS `mainX.css` в `<style_dir>/`.
- Контракт one output per entry применяется на всех стадиях миграции, в тестах и в cutover-критериях.

## Definition of Parity

- Parity определяется как **semantic parity**, а не byte-to-byte parity.
- Допустимы отличия в порядке свойств/правил, whitespace, комментариях и minify-форматировании, если итоговая семантика CSS не меняется.
- Сравнение проводится по итоговому CSS per entry (`_mainX.css` -> `mainX.css`) и его runtime-эффекту, а не по текстовому совпадению legacy output.

## Parity checks

### 1) Artifact contract checks

- Для каждого entry существует итоговый CSS-файл `mainX.css`.
- External sourcemap существует и валиден:
  - JSON корректно парсится;
  - содержит `sources`;
  - `mappings` не пустой.
- При включенном SVG fallback существуют ожидаемые fallback-ассеты.

### 2) Semantic CSS checks

- Сравнение выполняется по нормализованной структуре CSS.
- Игнорируются whitespace, комментарии и несущественные форматные различия.
- Допускается различный порядок деклараций внутри правила, если семантика не меняется.
- Глобальное переупорядочивание CSS-правил не допускается, чтобы не ломать каскад.

### 3) Runtime smoke checks (опционально)

- Минимальная e2e/smoke-проверка подтверждает, что приложение/рендер не сломан.
- Достаточно проверки базового сценария загрузки и применения стилей.

## Intentional Breaking Change: Removal of _data.css

- В новом pipeline файл `_data.css` **больше не генерируется**.
- Под «данными» понимаются CSS-правила/артефакты, которые ранее выносились `postcss-data-packer` в отдельный `_data.css`.
- Эти правила интегрируются в соответствующий итоговый `mainX.css` для каждого entry.
- Интеграция выполняется на стадии `post_transform` (после основной трансформации Lightning CSS).
- Для сохранения корректности каскада не меняется порядок критичных правил относительно исходного entry-потока.
- В Stage 0 legacy `_data.css` хранится только как reference baseline и не является parity requirement для нового pipeline.
- Это осознанное и допустимое архитектурное изменение, а не регрессия.
- `postcss-data-packer` считается legacy-компонентом и удаляется в рамках финальной стадии миграции.

## Stage 0: Baseline и fixtures

Цель: зафиксировать текущее поведение.

- Создать golden fixtures из output текущего pipeline для репрезентативных входов `_main*.css`.
- Включить в snapshot-артефакты legacy output: сгенерированные CSS, sourcemaps, legacy `_data.css` (как reference) и опциональные `svg_fallback` assets.
- Добавить команду запуска legacy pipeline в детерминированном режиме (рекомендуется fixed env + workers=1).

Критерии готовности:

- Golden-набор покрывает ключевые поведения текущего скрипта:
  - import resolution, фильтрацию asset URL, data packing, sourcemaps, autoprefixing, переключатель svg fallback.
- Для нового pipeline `_data.css` не считается обязательным артефактом parity.
- CI может генерировать/проверять baseline на всех поддерживаемых платформах.

Риски:

- Legacy output включает недетерминированное форматирование/порядок.

Rollback:

- Rollout отсутствует; только baseline.

## Stage 1: Rust pipeline в shadow mode

Цель: новый Rust pipeline работает параллельно и не влияет на поставляемый output.

- Добавить library `style_pipeline` + CLI.
- Собирать CSS в отдельную shadow-директорию (`.shadow-css` или аналог).
- Сравнивать с golden из Stage 0 и/или с output legacy runtime:
  - semantic compare (AST-подобная нормализация) только для итогового CSS per entry (`mainX.css`).
  - различия, обусловленные отсутствием отдельного `_data.css`, считаются ожидаемыми и игнорируются.

Критерии готовности:

- Shadow pass rate >= согласованного semantic-порога по итоговым файлам `mainX.css`.
- Известные diff'ы разобраны и документированы.
- Нет регрессий в текущем production flow.

Риски:

- Отличия source map, технически корректные, но текстово отличающиеся.
- Legacy plugin features без 1:1 эквивалента в Lightning CSS.

Rollback:

- Отключить shadow job через feature flag / CI flag; legacy остается источником истины.

## Stage 2: Переключение под флагом (новый default в opt-in ветке)

Цель: направить `build_styles` в Rust path за явным config/flag.

- Сохранить возможность вызова legacy Node path (`--engine legacy`).
- Переключать default по окружениям (сначала dev, затем CI, затем release candidates).

Критерии готовности:

- Все обязательные тесты проходят (unit/integration/golden/e2e smoke).
- Нет незакрытых проблем миграции P0/P1.
- Packaging валидирован без runtime-зависимости от `intcss` для experimental-канала.
- Новый pipeline не имеет зависимости от отдельного `_data.css`; все соответствующие данные присутствуют в соответствующих `mainX.css`.

Риски:

- Операционные: тайминг watch loop/queue или предположения по output path.

Rollback:

- Один flip конфигурации возвращает legacy `build-css.mjs`.

## Stage 3: Удаление legacy

Цель: удалить `intcss`/legacy postcss runtime path.

- Удалять Node style runtime packaging path только после окна стабильности Stage 2.
- Явно удалить `postcss-data-packer` из legacy-цепочки вместе с удалением legacy style runtime path.
- Перед полным удалением оставить один релиз со скрытым legacy fallback (опционально).

Критерии готовности:

- Стабильное production-поведение в течение согласованного soak period.
- CI/release workflows мигрированы на проверки в стиле Rust.

Риски:

- Скрытые edge cases в старых проектных стилях вне покрытых fixtures.

Rollback:

- Повторно включить legacy path из tagged branch/hotfix release.

## 4) Реестр рисков (top)

1. **Риск feature parity**: `postcss-axis`, `postcss-extend` вероятно требуют кастомных Rust stages.
2. **Риск совместимости**: legacy-поведение import/url (`import-transform.js`) содержит project-specific переписывание URL.
3. **Риск assets/URL (high)**: `postcss-url`/`postcss-assets` + `import-transform.js` могут дать несовместимое разрешение путей.
   - При ошибке: не грузятся изображения/фоновые изображения, появляются некорректные runtime URL, особенно на platform-specific путях (включая Windows path normalization).
4. **Риск parity sourcemap**: сгенерированные mappings/annotations должны соответствовать ожиданиям потребителя (`maps/<file>.map`).
5. **Риск packaging**: CI сейчас жестко проверяет наличие `intcss` в runtime-артефактах.

## 5) Cutover Gates

- Gate G1: fixtures Stage 0 добавлены и воспроизводимы.
- Gate G2: semantic shadow-сравнение Stage 1 по файлам `mainX.css` стабильно в CI.
- Gate G3: Stage 2 default-on в dev + release-candidate без высокосерьезных регрессий.
- Gate G4: PR очистки Stage 3 после soak period.

## 6) Явные “Do Not”

- Не переписывать всю style-логику в одном PR.
- Не удалять legacy pipeline до появления shadow и rollback-контролей.
- Не связывать новый core crate сборки стилей с UI/Tauri runtime.
