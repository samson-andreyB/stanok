# Release Notes

## 2.4.0 (2026-02-16)

### Что изменилось

- Сборка изображений полностью переведена на Rust backend.
- Удалён runtime-скрипт `scripts/build-images.mjs`.
- Обновлена упаковка runtime-скриптов: оставлены `build-css.mjs` и `path-utils.mjs`.
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
