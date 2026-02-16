# Release Checklist

## 1. Версии

- Обновить версию в:
  - `package.json`
  - `src-tauri/tauri.conf.json`
  - `src-tauri/Cargo.toml`
  - `src-tauri/Cargo.lock`
- Проверить версию Node в `.nvmrc`.

## 2. Локальная проверка

- `npm ci`
- `cargo check --manifest-path src-tauri/Cargo.toml`
- Проверить запуск приложения и сборку:
  - обработка стилей
  - обработка изображений
  - watcher (start/stop)

## 3. CI сборка

- Запустить `Build Desktop (Linux RPM)`.
- Убедиться, что прошли:
  - `Validate runtime modules inside RPM`
  - `Smoke test installed RPM runtime`

## 4. Релизный smoke после установки

- Установить RPM из артефакта.
- Проверить в UI:
  - версия приложения
  - версия Tauri
  - версия Node
  - успешные сборки CSS/изображений без ошибок модулей.

## 5. Node policy

- Node обновляем только через `.nvmrc`.
- Обновление major-версии Node делать отдельной задачей.
- После смены Node обязательно прогонять полный CI workflow и ручной smoke на установленном RPM.
