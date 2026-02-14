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
- `.github/workflows/build-desktop.yml`

Как собрать Windows/macOS/Linux:

1. Открыть `Actions` -> `Build Desktop (Windows + macOS + Linux)`.
2. Нажать `Run workflow`.
3. Скачать артефакты:
- `stanok-windows` (`msi`, `nsis`)
- `stanok-macos` (`app`, `dmg`)
- `stanok-linux` (`deb`, `rpm`)

## Примечания

- Для работы приложения нужны `node`, `cargo/rustc`, `cc`, `pkg-config`, `git`.
- Проверка окружения: `npm run doctor`.
- Кэш списка проектов хранится в `~/.cache/stanok` (или `$XDG_CACHE_HOME/stanok`) и живет `1 час`.
