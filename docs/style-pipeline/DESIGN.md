# Целевой дизайн: Rust Style Pipeline (Lightning CSS core)

## 1) Scope и границы

### Зоны ответственности Lightning CSS

- CSS parsing/transform/minify/prefixing и target-based lowering.
- Генерация source map.
- Стандартные синтаксические возможности, поддерживаемые core Lightning CSS.

### Зоны ответственности нашего Rust wrapper

- Обнаружение project-файлов (`_main*.css` contract compatibility с legacy).
- Оркестрация нескольких файлов и раскладка output (`maps/`, опциональные side artifacts).
- Нормализация путей и diagnostics, совместимые с legacy.
- Extension stages для feature'ов, не покрытых Lightning CSS.
- Консолидация данных legacy `postcss-data-packer` в итоговый entry-output (`mainX.css`) без отдельного `_data.css`.

Evidence для текущих ограничений совместимости:

- Паттерн входа `_main*.css` (`scripts/build-css.mjs:137`).
- Схема output css + sourcemap path (`scripts/build-css.mjs:292`, `scripts/build-css.mjs:295`, `scripts/build-css.mjs:303`).
- Кастомная post-обработка нормализации URL (`scripts/build-css.mjs:398`).
- Runtime payload уже включает вычисленные пути (`src-tauri/src/main.rs:1658`).

## 2) Публичный API библиотеки (`crates/style_pipeline`)

```rust
pub struct PipelineConfig {
    pub entries: Vec<Entry>,
    pub out_dir: std::path::PathBuf,
    pub source_maps: SourceMapMode,
    pub minify: bool,
    pub targets: Targets,
    pub browserslist_query: Option<String>,
    pub import_roots: Vec<std::path::PathBuf>,
    pub asset: AssetConfig,
    pub compatibility: CompatibilityMode, // LegacyCompatible | StrictLightning
}

pub struct CompileRequest {
    pub cwd: std::path::PathBuf,
    pub config: PipelineConfig,
}

pub struct CompileArtifact {
    pub entry: std::path::PathBuf,
    pub css_path: std::path::PathBuf,
    pub map_path: Option<std::path::PathBuf>,
    pub extra_outputs: Vec<std::path::PathBuf>,
}

pub struct CompileResult {
    pub artifacts: Vec<CompileArtifact>,
    pub diagnostics: Vec<Diagnostic>,
}

pub fn compile(req: CompileRequest) -> Result<CompileResult, PipelineError>;
```

Примечания к дизайну:

- `compatibility` изолирует legacy-особенности (например, переписывание URL из `import-transform.js`).
- API библиотеки не зависит от UI и может использоваться в Tauri backend, CI или stand-alone tools.

## 3) CLI UX (`crates/style_pipeline_cli`)

Предлагаемые команды:

- `style-pipeline compile --config style-pipeline.toml`
- `style-pipeline compile --input path/to/_mainX.css --output path/to/mainX.css`
- `style-pipeline compare --legacy-cmd "<cmd>" --config style-pipeline.toml` (для shadow mode)
- `style-pipeline doctor` (печатает diagnostics окружения и конфигурации)

Полезные флаги:

- `--watch`
- `--minify/--no-minify`
- `--sourcemap inline|external|none`
- `--targets "last 2 versions, not dead"` или `--targets-file`
- `--compat legacy|strict`
- `--stdin --stdout` (режим transform для одного файла)

Модель ошибок/exit code:

- `0` успех
- `1` compile/config/runtime error
- `2` превышен порог mismatch (`compare` mode)

## 4) Формат конфигурации

По умолчанию: TOML (`style-pipeline.toml`).

```toml
version = 1
mode = "legacy_compatible"
minify = false
source_maps = "external"
targets = "last 5 versions, Chrome 27, ff 12, ie 8, ie 9, opera 12"

[paths]
project_dir = "."
entries_glob = "assets/css/src/_main*.css"
out_dir = "assets/css"
maps_dir = "assets/css/maps"
img_dest_dir = "assets/img/dest"

[legacy]
enable_svg_fallback = false
inline_max_size_kb = 1
rewrite_old_moz_gradient_tokens = true
```

Почему TOML:

- Нативная эргономика Rust ecosystem.
- Удобные комментарии и стабильные diff'ы.

## 5) Pipeline stages

Порядок stage по умолчанию:

1. `discover_entries`
2. `read_source`
3. `pre_transform` (legacy import/url compatibility)
4. `lightning_transform`
5. `post_transform` (legacy-нормализации, интеграция data-packer-данных в итоговый CSS, опциональные extras)
6. `emit_outputs`
7. `emit_diagnostics`

Это повторяет текущее поведение скрипта, где legacy-нормализация выполняется после генерации результата postcss (`scripts/build-css.mjs:299`, `scripts/build-css.mjs:398`).

Правило one output per entry:

- Для каждого entry `_mainX.css` генерируется соответствующий output `mainX.css` (ведущий `_` удаляется).
- Отдельный `_data.css` не генерируется.
- Данные, которые раньше выделялись в `_data.css` через `postcss-data-packer`, инлайнятся в соответствующий `mainX.css` на этапе `post_transform` после `lightning_transform`.

### Parity contract

- Semantic parity проверяется для каждого итогового `mainX.css`, byte-to-byte совпадение не требуется.
- Artifact checks:
  - существует итоговый `mainX.css` для каждого entry;
  - external sourcemap валиден (JSON parse ok, есть `sources`, `mappings` не пустой);
  - при включенном SVG fallback ожидаемые fallback assets присутствуют.
- Semantic checks:
  - сравнение по нормализованной структуре CSS (игнор whitespace/comments/форматирования);
  - глобальное переупорядочивание правил не допускается (чтобы не ломать каскад).
- Runtime smoke checks (опционально):
  - минимальная e2e/smoke проверка, что рендер/применение стилей не сломаны.

## 6) Error model и diagnostics

Унифицированные типы:

- `ConfigError` (некорректный config/path).
- `ResolveError` (import или asset resolution).
- `CompileError` (syntax/transform).
- `EmitError` (запись в файловую систему).
- `ComparisonError` (shadow/golden mismatch).

Каждый diagnostic включает:

- `code` (стабильный машинный код),
- `message`,
- `severity`,
- опционально `file/line/column`,
- опционально `hints`.

Текущие ограничения, влияющие на это:

- Ожидание compact output из тестов (`test/smoke/build-scripts.test.mjs:45`, `test/smoke/build-scripts.test.mjs:46`).
- Контракт compaction/enrichment ошибок на Rust-стороне (`src-tauri/src/main.rs:992`, `src-tauri/src/main.rs:941`, `src-tauri/src/main.rs:2195`).

## 7) Аудит и mapping PostCSS/intcss

Легенда статусов:

- `Covered by Lightning CSS`
- `Can be removed`
- `Needs replacement (Rust stage)`
- `Temporary legacy`
- `Intentional removal as separate artifact`

| Plugin/function | Назначение в текущем стеке | Где подключен | Пример использования в этом репозитории | Статус миграции | Rust-стратегия |
|---|---|---|---|---|---|
| `postcss-import` + custom transform | import resolution + URL rewrite | `node_modules/intcss/index.js:5`, `node_modules/intcss/import-transform.js:11` | В скрипте настроены import roots (`scripts/build-css.mjs:236`) | Needs replacement | Pre-Lightning resolver + опциональная compatibility-stage для URL rewrite |
| `postcss-mixins` | custom mixins | `node_modules/intcss/index.js:13` | Конкретных style fixture в репозитории нет; feature включен по умолчанию | Needs replacement | Pre-Lightning stage с macro-like expansion (AST/token based) |
| `postcss-axis` | shorthand helpers | `node_modules/intcss/index.js:18` | Конкретных fixture в репозитории не найдено | Can be removed or replacement | Предпочтительно удалить; добавить опциональный compatibility plugin, если нужен реальным проектам |
| `postcss-property-lookup` | ссылки на свойства | `node_modules/intcss/index.js:25` | Конкретных fixture в репозитории не найдено | Needs replacement | Pre-Lightning resolver зависимостей declaration |
| `postcss-assets` | helper-функции для assets | `node_modules/intcss/index.js:32` | Настроен load path (`scripts/build-css.mjs:244`) | Needs replacement | Pre-Lightning asset resolver, привязанный к `img/dest` |
| `postcss-advanced-variables` | variables/control features | `node_modules/intcss/index.js:37` | Конкретных fixture в репозитории не найдено | Needs replacement | Pre-Lightning processor переменных |
| `postcss-color-function` | legacy color() function | `node_modules/intcss/index.js:42` | Конкретных fixture не найдено | Covered or replacement | Предпочтительно Lightning/native color transforms; fallback pre-stage для неподдерживаемого синтаксиса |
| `postcss-strip-units` | helper strip units | `node_modules/intcss/index.js:47` | Конкретных fixture не найдено | Needs replacement | Легковесный pre-transform |
| `postcss-conditionals` | условный CSS | `node_modules/intcss/index.js:52` | Конкретных fixture не найдено | Needs replacement | Preprocessor-like stage (feature-gated) |
| `postcss-nested` | nested rules | `node_modules/intcss/index.js:57` | Конкретных fixture не найдено | Covered by Lightning CSS nesting support | Использовать Lightning CSS напрямую |
| `postcss-extend` | наследование selector'ов | `node_modules/intcss/index.js:62` | Конкретных fixture не найдено | Needs replacement | Pre-transform expansion модели `%`/extend |
| `postcss-calc` | упрощение calc | `node_modules/intcss/index.js:67` | Конкретных fixture не найдено | Covered by Lightning CSS/minifier behaviors | Использовать Lightning CSS |
| `postcss-svg` | helper для inline SVG | `node_modules/intcss/index.js:72` | Настроены SVG paths (`scripts/build-css.mjs:247`) | Needs replacement | Asset/SVG stage до Lightning |
| `postcss-url` | rewrite/inlining URL | `node_modules/intcss/index.js:80` | Используются `maxSize`, `filter` (`scripts/build-css.mjs:250`) | Needs replacement | Минимальный rewrite-only stage для корректных путей; inline/filter по size-threshold только при подтвержденной необходимости (отдельный PR) |
| `postcss-svg-fallback` | генерация PNG fallback | `node_modules/intcss/index.js:88` | Опционально по env (`scripts/build-css.mjs:71`, `scripts/build-css.mjs:283`) | Needs replacement | Отдельный опциональный stage генерации assets |
| `postcss-color-rgba-fallback` | rgba fallback для старых браузеров | `node_modules/intcss/index.js:93` | Fixture не найдено | Can be removed or temporary legacy | Оставлять только если это требуется матрицей target |
| `autoprefixer` | вендорные префиксы по browser list | `node_modules/intcss/index.js:98` | browsers задаются из payload (`scripts/build-css.mjs:100`, `scripts/build-css.mjs:263`) | Covered by Lightning CSS | Настроить targets/browsers в Lightning |
| `postcss-data-packer` | эмитит дополнительный `_data.css` | `node_modules/intcss/index.js:103` | custom logic destination/map (`scripts/build-css.mjs:267`) | Intentional removal as separate artifact | Post-Lightning inline stage: перенос данных в итоговый `mainX.css` без отдельного файла |

Примечания:

- Конкретные project CSS-примеры для многих плагинов в текущем snapshot репозитория отсутствуют; видна только wiring-логика runtime pipeline (`scripts/build-css.mjs:235`), а smoke-тесты покрывают только сценарий invalid-css (`test/smoke/build-scripts.test.mjs:29`).

## 8) Модель расширений (Rust plugins)

### V1: Runtime “pipeline stages” через traits + registry

```rust
pub trait PreTransformStage {
    fn name(&self) -> &'static str;
    fn run(&self, ctx: &mut StageContext, input: CssInput) -> Result<CssInput, StageError>;
}

pub trait PostTransformStage {
    fn name(&self) -> &'static str;
    fn run(&self, ctx: &mut StageContext, output: CssOutput) -> Result<CssOutput, StageError>;
}
```

- Registry — это упорядоченный вектор в config.
- Conflict resolution: явный порядок stage + стабильный priority integer.
- Версионирование: semver API plugin'ов привязан к major `style_pipeline`.

### V2: Compile-time plugin crates + feature flags

- Plugin crates реализуют traits и линкуются на compile-time.
- Registry генерируется из включенных features (`cargo` features, без dynamic loading).
- Лучше безопасность и воспроизводимость для desktop packaging.

Пример:

- features `style_pipeline`: `plugin_legacy_import`, `plugin_data_inline`, `plugin_svg_fallback`.

### Dynamic `dylib` plugins (опциональное обсуждение)

Не рекомендуются по умолчанию.

Риски:

- Хрупкость ABI между версиями Rust/compiler.
- Сложность безопасности/supply-chain и packaging.
- Ниже воспроизводимость для desktop app bundles.

Когда это допустимо:

- Внутренний toolchain со строгим version lock + подписанные plugin artifacts.

## 9) План тестирования (полная функциональность)

### Unit tests

- Парсинг/дефолты/валидация config.
- Порядок stage и conflict resolution.
- Формат diagnostics и parity compact mode.
- Legacy compatibility helpers (`_main` discovery, URL rewrite rules).

### Integration tests

- Входная CSS-директория -> output CSS + sourcemaps.
- Outputs, связанные с assets (данные из legacy data-packer в соответствующем `mainX.css`, опциональный `svg_fallback`).
- URL rewrite корректен; inline/filter поведение тестируется отдельно и не является обязательным на первом этапе.
- Поведение CLI/exit code.

### Golden tests

- Baseline, сгенерированный текущим pipeline (Stage 0).
- Сравнение нового output с legacy:
  - normalized semantic compare для каждого итогового `mainX.css`,
  - различия из-за отсутствия отдельного `_data.css` трактуются как ожидаемые.

### Edge cases для включения (с Evidence из репозитория)

1. Отсутствует аргумент payload (`scripts/build-css.mjs:448`).
2. Отсутствуют `projects_path/project_name` (`scripts/build-css.mjs:222`).
3. Пустые или некорректные build paths (`scripts/build-css.mjs:208`).
4. Нет файлов `_main*.css` (`scripts/build-css.mjs:137`, `scripts/build-css.mjs:139`).
5. Параллельная обработка стилей: число workers и queue (`scripts/build-css.mjs:143`, `scripts/build-css.mjs:425`).
6. Порядок custom import roots (`scripts/build-css.mjs:238`).
7. Поведение allow-list URL filter для inline assets (`scripts/build-css.mjs:253`, `scripts/build-css.mjs:257`).
8. Путь annotation для внешнего sourcemap (`scripts/build-css.mjs:293`, `scripts/build-css.mjs:295`).
9. Post-нормализация старых moz gradient tokens (`scripts/build-css.mjs:400`).
10. Опциональный переключатель SVG fallback через env (`scripts/build-css.mjs:71`, `scripts/build-css.mjs:282`).
11. Ожидаемый compact error output в smoke test (`test/smoke/build-scripts.test.mjs:45`).
12. Дедупликация queue в Rust orchestrator (`src-tauri/src/main.rs:1556`, `src-tauri/src/main.rs:1614`).
13. Проверка runtime modules при отсутствующих dependencies (`src-tauri/src/main.rs:2201`, `src-tauri/src/main.rs:2222`).
14. Повторные style build по событиям watch (`src/main.js:233`, `src/main.js:244`, `src/main.js:269`).
15. Совместимость вычисления runtime paths с JS-контрактом (`src-tauri/src/main.rs:2350`, `src-tauri/src/main.rs:2358`, `src-tauri/src/main.rs:1658`).

### Структура fixtures

- `test/style_pipeline/fixtures/input/...`
- `test/style_pipeline/fixtures/golden/legacy/...`
- `test/style_pipeline/fixtures/golden/rust/...`
- `test/style_pipeline/cases/*.toml`

## 10) Альтернативы и компромиссы

### Option A (recommended): Rust wrapper + Lightning CSS core

- Плюсы: производительность, целевое состояние Rust-only, унифицированные diagnostics, отсутствие зависимости style build от Node runtime.
- Минусы: нужны кастомные replacement stages для legacy plugin features.

### Option B: Сохранить Lightning CSS, но оставить частичный legacy через Node sidecar (временно)

- Плюсы: самая быстрая миграция, ниже ранний риск.
- Минусы: нарушает конечную цель Rust-only; операционная сложность (двойной toolchain).

### Option C: Rust-only без Lightning CSS (custom parser/transforms)

- Плюсы: полный контроль.
- Минусы: высокая сложность/риск; дольше путь к parity; выше стоимость поддержки.

Рекомендация:

- Принять Option A как финальную архитектуру.
- Использовать Option B только как краткоживущий переход на Stage 1/2, если gaps parity блокируют rollout.
