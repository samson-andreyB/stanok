# Release Notes

## 2.5.0 (2026-02-16)

### Что изменилось

- Подготовлен перенос path-utils в Rust: пути для CSS-пайплайна рассчитываются в Rust и передаются в `build-css.mjs` через payload.
- Удалён `scripts/path-utils.mjs` из репозитория.
- Из runtime-упаковки удалён `path-utils.mjs`; в runtime-скриптах оставлен только `build-css.mjs`.
- Добавлены Rust unit-тесты на контракт расчёта путей для CSS.

## 2.4.0 (2026-02-16)

### Что изменилось

- Сборка изображений полностью переведена на Rust backend.
- Удалён runtime-скрипт `scripts/build-images.mjs`.
- Обновлена упаковка runtime-скриптов: оставлен только `build-css.mjs`.
- Обновлены manual CI-проверки под Rust image pipeline (без проверки `build-images.mjs`).

## 2.3.0 (2026-02-16)

### Что изменилось

- Перенесена оркестрация сборки из Node `build-worker.mjs` в Rust.
- Удален `tauri-plugin-shell`, запуск node-скриптов теперь через `std::process::Command`.
- Удален устаревший `scripts/build-worker.mjs`.
- Обновлена упаковка runtime-скриптов Node:
  - `build-css.mjs`
  - `build-images.mjs`
  - `path-utils.mjs`
- Обновлены проверки в CI под новый runtime flow.

### Зачем

- Меньше слоев между UI и сборкой.
- Проще отлаживать runtime-процессы.
- Снижен риск расхождения между локальным запуском и RPM-сборкой.
