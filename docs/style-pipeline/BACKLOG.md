# Backlog (PR-sized) для миграции style pipeline

Формат каждой задачи:

- `Scope`
- `Acceptance criteria`
- `Tests`
- `Effort`

## PR-01: Harness для захвата Baseline (legacy)

- Scope:
  - Добавить скрипты/тесты для запуска текущей legacy style-сборки на fixture inputs.
  - Сохранять golden outputs (`css`, `map`, optional extras) в `test/style_pipeline/fixtures/golden/legacy`.
- Acceptance criteria:
  - CI валидирует структуру baseline fixtures и artifact contract (css + sourcemap + optional extras).
  - Пересъём baseline выполняется вручную отдельным PR.
  - Byte-to-byte воспроизводимость legacy output на всех платформах не является обязательным требованием.
  - Fixtures включают репрезентативные `_main*.css` entries и import/assets кейсы.
- Tests:
  - Integration test, проверяющий генерацию всех baseline artifacts.
- Effort:
  - M

## PR-02: Skeleton нового Rust crate (`style_pipeline`)

- Scope:
  - Создать `crates/style_pipeline` с типами config, типами ошибок и `compile(...)` stub.
- Acceptance criteria:
  - В crate проходит `cargo test`.
  - Публичный API задокументирован в docs crate.
- Tests:
  - Unit tests для defaults и валидации config.
- Effort:
  - S

## PR-03: Skeleton CLI (`style_pipeline_cli`)

- Scope:
  - Создать минимальный runnable CLI с командой `compile` (`input -> output`).
  - Поддержать `--config` и прямой режим `--input/--output`.
- Acceptance criteria:
  - CLI возвращает корректные exit code.
  - Печатает compact diagnostics.
- Tests:
  - CLI integration tests (успех + invalid config).
- Effort:
  - S

## PR-04: Parity обнаружения entry и записи output

- Scope:
  - Реализовать discovery `_main*.css` и parity layout output (модель путей `maps/`).
- Acceptance criteria:
  - Имена произведенных файлов совпадают с legacy-контрактом для покрытых fixtures.
- Tests:
  - Integration tests для правил discovery/output path.
- Effort:
  - M

## PR-05: Интеграция Lightning CSS core

- Scope:
  - Интегрировать Lightning CSS transforms, переключатель minify, targets и sourcemaps.
- Acceptance criteria:
  - CLI и library умеют компилировать fixture inputs с source maps.
- Tests:
  - Unit + integration tests для режимов minify/targets/sourcemap.
- Effort:
  - M

## PR-06: Legacy-compat pre-stage (`import` + URL rewrite)

- Scope:
  - Реализовать import resolution roots и совместимое поведение URL rewrite.
- Acceptance criteria:
  - Поведение совпадает с legacy для import-path и URL rewrite fixtures.
- Tests:
  - Golden/reference fixtures + semantic compare harness.
  - Byte-to-byte совпадение с legacy output не требуется.
  - Проверяется semantic parity по итоговым `mainX.css`.
- Effort:
  - M

## PR-07: Asset stages (`url` rewrite-only)

- Scope:
  - Реализовать минимальный URL rewrite stage для сохранения корректных путей (rewrite-only).
  - Inline/filter по size-threshold реализуется только при подтвержденной необходимости (может быть вынесено в отдельный PR).
- Acceptance criteria:
  - Базовая корректность путей `url(...)` сохраняется.
  - Inline threshold поведение не является обязательным на первом этапе.
- Tests:
  - Integration tests для rewrite-only поведения:
  - относительные `url(...)` корректно переписываются;
  - `data:`/`http(s):`/absolute URLs не изменяются;
  - inline/filter threshold не является обязательной частью этого этапа.
- Effort:
  - L

## PR-07A: Интеграция data-packer логики в основной pipeline

- Scope:
  - Перенести data-packer логику в основной pipeline с контрактом one output per entry (`_mainX.css` -> `mainX.css`).
  - Обеспечить интеграцию данных в итоговый `mainX.css` (для каждого `_mainX.css`) без отдельного `_data.css`.
- Acceptance criteria:
  - Все данные, ранее попадавшие в `_data.css`, присутствуют в соответствующем итоговом `mainX.css`.
  - Не нарушена загрузка/использование этих данных в приложении.
  - Удален отдельный `_data.css` output.
- Tests:
  - Integration + golden tests, подтверждающие semantic parity итоговых `mainX.css` и отсутствие отдельного `_data.css`.
- Effort:
  - L

## PR-08: Опциональный stage SVG fallback

- Scope:
  - Добавить feature-gated генерацию SVG fallback, эквивалентную legacy env-toggle.
- Acceptance criteria:
  - По умолчанию выключено; включается через config/env.
  - Output path совпадает с ожидаемым fallback dir contract.
- Tests:
  - Integration tests с fallback on/off.
- Effort:
  - M

## PR-09: Framework расширений plugin (V1 runtime stages)

- Scope:
  - Ввести trait-based registry stage и детерминированный порядок.
- Acceptance criteria:
  - Сторонний внутренний stage можно зарегистрировать и выполнить.
- Tests:
  - Unit tests для ordering/conflict resolution.
  - Example plugin test.
- Effort:
  - M

## PR-10: Compile-time plugin pack (V2 registry по feature)

- Scope:
  - Добавить feature-flag registry для plugin crates.
- Acceptance criteria:
  - Build profile воспроизводимо управляет наличием plugin.
- Tests:
  - Matrix tests для комбинаций feature.
- Effort:
  - M

## PR-11: Shadow mode comparator и отчеты

- Scope:
  - Добавить команду запуска нового pipeline в shadow mode и сравнения с legacy outputs.
- Acceptance criteria:
  - Читаемый diff report + machine-readable summary.
  - Опция CI-fail по threshold.
  - Сравнение основано на semantic parity итоговых `mainX.css`, без требования byte-to-byte совпадения.
- Tests:
  - Integration tests для semantic compare режима и игнорирования ожидаемой разницы по отсутствующему `_data.css`.
- Effort:
  - M

## PR-12: Интеграция в Tauri под feature flag

- Scope:
  - Подключить в orchestration `build_styles` опциональный вызов Rust pipeline вместо Node script.
- Acceptance criteria:
  - Runtime-switch (`legacy`/`rust`) без удаления legacy path.
- Tests:
  - Текущие smoke tests проходят.
  - Новый integration test проверяет выбранный engine.
- Effort:
  - M

## PR-13: Миграция CI и packaging

- Scope:
  - Обновить workflows: валидировать Rust style binary/CLI вместо runtime-требований `intcss` для нового режима.
  - Удалить проверки, предполагающие наличие отдельного `_data.css`, и закрепить контракт one output per entry (`_mainX.css` -> `mainX.css`).
- Acceptance criteria:
  - Build/release workflows проходят в Rust mode.
  - Legacy checks сохранены, пока существует migration flag.
  - В CI/packaging нет требований к `_data.css` как отдельному артефакту.
- Tests:
  - Workflow smoke validation на Linux/Windows/macOS.
- Effort:
  - M

## PR-14: Переключение default и окно deprecation

- Scope:
  - Сделать Rust pipeline режимом по умолчанию; сохранить legacy fallback на заданное окно.
- Acceptance criteria:
  - Нет high-severity регрессий в течение soak period.
- Tests:
  - Полный suite, включая golden/shadow comparisons.
- Effort:
  - S

## PR-14A: Переключение default на Rust + fallback

- Scope:
  - Переключить default engine на `rust`.
  - Сохранить fallback на `legacy` при ошибках Rust pipeline.
- Acceptance criteria:
  - В приложении по умолчанию используется `rust`.
  - При ошибках Rust сборка не ломается, выполняется fallback на `legacy`.
- Tests:
  - Smoke/regression проверки режима default + fallback.
- Effort:
  - S

## PR-14B: Стабилизация default rust режима (soak + scope freeze)

- Status:
  - В работе.
- Scope:
  - Зафиксировать compatibility scope для текущего окна deprecation.
  - Доработать тестовую матрицу претрансформов (imports/vars/mixins/nested/extend/resolve/svg).
  - Стабилизировать поведение fallback и диагностик в soak периоде.
- Acceptance criteria:
  - Rust режим остается default, при ошибках сохраняется безопасный fallback.
  - Явно зафиксированы out-of-scope кейсы текущей итерации (`postcss-property-lookup`, `postcss-strip-units`, `postcss-conditionals`, `postcss-color-rgba-fallback`, расширенный SVG DSL вне базового `svg("name", "[color]/[fill]/[stroke]")`).
  - Тесты претрансформов покрывают согласованный compatibility scope.
- Tests:
  - Unit/integration тесты по всем поддерживаемым претрансформам.
  - Негативные кейсы для out-of-scope синтаксиса с понятной диагностикой/fallback.
- Effort:
  - M

## PR-15: Очистка legacy

- Scope:
  - Удалить legacy intcss/postcss runtime-only path для стилей и связанные packaging checks.
  - Явно удалить зависимость от `postcss-data-packer` из legacy style-цепочки.
- Acceptance criteria:
  - Нет runtime-зависимости от `node_modules/intcss` для компиляции стилей.
- Tests:
  - CI release pipelines проходят после cleanup.
- Effort:
  - M

## Зависимости / порядок

1. PR-01 -> PR-02 -> PR-03 -> PR-04 -> PR-05
2. PR-06/07/07A/08 параллельно после PR-05
3. PR-09/10 могут стартовать после PR-02, финализируются после PR-06/07/07A/08
4. PR-11 после parity-critical stages
5. PR-12 -> PR-13 -> PR-14 -> PR-14B -> PR-15

## Примечания по источнику evidence

- Текущие контракты, на которые ссылаются план/дизайн, основаны на:
  - `scripts/build-css.mjs`
  - `src-tauri/src/main.rs`
  - `node_modules/intcss/index.js`
  - `node_modules/intcss/import-transform.js`
  - `scripts/prepare-sidecar-node.mjs`
  - `.github/workflows/*`
