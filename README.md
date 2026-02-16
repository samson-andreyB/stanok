# stanok

Инструмент для упрощения работы с файлами проектов. Версия переписана на Tauri.

## Стек

- `Tauri 2` (`@tauri-apps/api`, `@tauri-apps/cli`, `tauri`, `tauri-build`)
- `Vite 5` (фронтенд)
- Сборка проектных стилей: `intcss` + `postcss@5` (`scripts/build-css.mjs`)
- Сборка изображений: `scripts/build-images.mjs`
- Файловые watcher'ы: `notify` (Rust), с fallback на polling
- Build worker: `scripts/build-worker.mjs` (persistent Node process)

## Разработка

```bash
npm install
npm run dev
```

`npm run dev` запускает `tauri dev`, а если системные зависимости не найдены, автоматически переключается на `npm run dev:web`.

Дополнительные команды:

```bash
npm run dev:web
npm run build:web
npm run doctor
npm run test:e2e
```

`test:e2e` по умолчанию пропускается. Для запуска startup-smoke:

```bash
STANOK_RUN_E2E=1 npm run test:e2e
```

## Сборка

```bash
npm run build
```

## Релиз Через GitHub Actions

В репозитории есть workflow для десктоп-сборок:
- `.github/workflows/build-desktop.yml` (`Build Desktop (Linux RPM)`)
- `.github/workflows/build-desktop-windows.yml` (`Build Desktop (Windows)`)
- `.github/workflows/build-desktop-macos.yml` (`Build Desktop (macOS)`)

Как собрать:

1. Открыть `Actions` и выбрать нужный workflow по платформе.
2. Нажать `Run workflow`.
3. Скачать артефакт:
- `stanok-linux` (`rpm`)
- `stanok-windows` (`nsis`, `msi`)
- `stanok-macos` (`app`, `dmg`)

## Примечания

- Для работы приложения нужны `cargo/rustc`, `cc`, `pkg-config`, `git`.
- Runtime `node` поставляется вместе с приложением (sidecar + `runtime-node`).
- Проверка окружения: `npm run doctor`.
- Кэш списка проектов хранится в `~/.cache/stanok` (или `$XDG_CACHE_HOME/stanok`) и живет `1 час`.

## Node Version Policy

- Единый источник версии Node: файл `.nvmrc`.
- CI (`actions/setup-node`) использует `node-version-file: .nvmrc`.
- Скрипт `prepare:sidecar-node` кладет в runtime ту же версию Node, что выбрана в окружении сборки.
- Менять major-версию Node только отдельным PR с прогоном `workflow` и smoke-проверкой RPM.

## Platform Notes

- Метрики ресурсов (`CPU`/`RAM`) поддерживаются на Linux, Windows и macOS.
- Linux-специфичные проверки (`pkg-config`, `gtk`, `webkit`) выполняются только на Linux.
  На Windows/macOS в `doctor` они помечаются как `skipped`.
- Путь к кэшу проектов:
  - `XDG_CACHE_HOME/stanok` (если задано)
  - `LOCALAPPDATA/stanok` (Windows fallback)
  - `HOME/.cache/stanok`
  - `temp_dir()/stanok` (резервный fallback)
