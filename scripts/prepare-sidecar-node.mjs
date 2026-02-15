import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const tauriRoot = path.join(repoRoot, 'src-tauri');
const binariesDir = path.join(tauriRoot, 'binaries');
const runtimeRoot = path.join(tauriRoot, 'runtime-node');
const runtimeModulesDir = path.join(runtimeRoot, 'node_modules');
const runtimeScriptsDir = path.join(runtimeRoot, 'scripts');
const sourceScriptsDir = path.join(repoRoot, 'scripts');
const sourceNodeModulesDir = path.join(repoRoot, 'node_modules');
const sourceNodeBin = process.env.STANOK_NODE_BIN || process.execPath;

const args = new Set(process.argv.slice(2));
const copyFullNodeModules = !args.has('--minimal');
const skipNodeModulesCopy = args.has('--skip-node-modules');

function detectTargetTriple() {
  const arch = process.arch;
  const platform = process.platform;

  if (platform === 'linux' && arch === 'x64') return 'x86_64-unknown-linux-gnu';
  if (platform === 'win32' && arch === 'x64') return 'x86_64-pc-windows-msvc';
  if (platform === 'darwin' && arch === 'arm64') return 'aarch64-apple-darwin';
  if (platform === 'darwin' && arch === 'x64') return 'x86_64-apple-darwin';

  throw new Error(`Unsupported platform/arch for auto-detect: ${platform}/${arch}`);
}

function sidecarBinaryName(triple) {
  return process.platform === 'win32' ? `node-${triple}.exe` : `node-${triple}`;
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function copyNodeBinary() {
  const triple = detectTargetTriple();
  const destName = sidecarBinaryName(triple);
  const destPath = path.join(binariesDir, destName);
  ensureDir(binariesDir);
  fs.rmSync(destPath, { force: true });
  if (!fs.existsSync(sourceNodeBin)) {
    throw new Error(`Node binary not found: ${sourceNodeBin}`);
  }
  fs.copyFileSync(sourceNodeBin, destPath);
  if (process.platform !== 'win32') {
    fs.chmodSync(destPath, 0o755);
  }
  return { triple, destName, destPath };
}

function shouldSkipEntry(srcPath) {
  const basename = path.basename(srcPath);
  if (basename === '.cache') return true;
  if (basename === '.vite') return true;
  if (basename === '.bin') return true;
  return false;
}

function copyRuntimeNodeModules() {
  if (!fs.existsSync(sourceNodeModulesDir)) {
    throw new Error(`Source node_modules not found: ${sourceNodeModulesDir}`);
  }

  ensureDir(runtimeRoot);
  fs.rmSync(runtimeModulesDir, { recursive: true, force: true });
  ensureDir(runtimeModulesDir);

  if (copyFullNodeModules) {
    fs.cpSync(sourceNodeModulesDir, runtimeModulesDir, {
      recursive: true,
      dereference: true,
      filter: (src) => !shouldSkipEntry(src),
    });
    return 'full';
  }

  const minimalPackages = [
    'intcss',
    'postcss5',
    'assets',
    'postcss',
    'postcss-import',
    'postcss-url',
    'postcss-data-packer',
    'postcss-svg',
    'postcss-svg-fallback',
    'postcss-extend',
    'postcss-advanced-variables',
    'postcss-conditionals',
    'postcss-assets',
    'postcss-axis',
    'postcss-property-lookup',
    'postcss-strip-units',
  ];

  for (const pkgName of minimalPackages) {
    const from = path.join(sourceNodeModulesDir, pkgName);
    const to = path.join(runtimeModulesDir, pkgName);
    if (!fs.existsSync(from)) continue;
    fs.cpSync(from, to, { recursive: true, dereference: true });
  }
  return 'minimal';
}

function copyRuntimeScripts() {
  if (!fs.existsSync(sourceScriptsDir)) {
    throw new Error(`Source scripts dir not found: ${sourceScriptsDir}`);
  }
  ensureDir(runtimeRoot);
  fs.rmSync(runtimeScriptsDir, { recursive: true, force: true });
  fs.cpSync(sourceScriptsDir, runtimeScriptsDir, { recursive: true, dereference: true });
  return runtimeScriptsDir;
}

function main() {
  const { triple, destPath } = copyNodeBinary();
  const copiedScripts = copyRuntimeScripts();
  let mode = 'skipped';
  if (!skipNodeModulesCopy) {
    mode = copyRuntimeNodeModules();
  }

  console.log(`Sidecar Node prepared: ${destPath}`);
  console.log(`Runtime scripts copied: ${copiedScripts}`);
  console.log(`Source Node binary: ${sourceNodeBin}`);
  console.log(`Target triple: ${triple}`);
  if (!skipNodeModulesCopy) {
    console.log(`Runtime modules copied: ${mode}`);
    console.log(`Runtime modules dir: ${runtimeModulesDir}`);
  } else {
    console.log('Runtime modules copy skipped (--skip-node-modules).');
  }
}

main();
