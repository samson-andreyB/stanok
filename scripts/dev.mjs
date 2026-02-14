import { hasCommand, pkgOk, runOrExit } from './cli-utils.mjs';
const isLinux = process.platform === 'linux';
const isWindows = process.platform === 'win32';

if (!hasCommand('cargo')) {
  console.error('\n[Tauri] Не найден cargo (Rust toolchain).');
  console.error('[Tauri] Установите Rust: https://rustup.rs');
  console.error('[Tauri] Запускаю только фронтенд режим: npm run dev:web\n');
  runOrExit('npm', ['run', 'dev:web']);
}

if (!isWindows && !hasCommand('cc')) {
  console.error('\n[Tauri] Не найден C-компилятор (cc/gcc/clang).');
  console.error('[Tauri] Для Fedora установите: sudo dnf install -y gcc');
  console.error('[Tauri] Запускаю только фронтенд режим: npm run dev:web\n');
  runOrExit('npm', ['run', 'dev:web']);
}

if (isLinux) {
  if (!hasCommand('pkg-config')) {
    console.error('\n[Tauri] Не найден pkg-config.');
    console.error('[Tauri] Для Fedora установите: sudo dnf install -y pkgconf-pkg-config');
    console.error('[Tauri] Запускаю только фронтенд режим: npm run dev:web\n');
    runOrExit('npm', ['run', 'dev:web']);
  }

  const hasWebkit = pkgOk('webkit2gtk-4.1') || pkgOk('webkit2gtk-4.0');
  const hasGtk3 = pkgOk('gtk+-3.0');
  if (!hasWebkit || !hasGtk3) {
    console.error('\n[Tauri] Не найдены системные dev-библиотеки WebKitGTK/GTK3.');
    console.error('[Tauri] Для Fedora установите: sudo dnf install -y webkit2gtk4.1-devel gtk3-devel');
    console.error('[Tauri] Запускаю только фронтенд режим: npm run dev:web\n');
    runOrExit('npm', ['run', 'dev:web']);
  }
}

runOrExit('tauri', ['dev']);
