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

  return { triple, destPath };
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

  const minimalRootPackages = [
    'intcss',
    'postcss5',
    'assets',
  ];

  const packageSet = collectRuntimePackageClosure(minimalRootPackages);
  for (const pkgName of packageSet) {
    const from = resolvePackageDir(sourceNodeModulesDir, pkgName);
    const to = resolvePackageDir(runtimeModulesDir, pkgName);
    if (!from || !fs.existsSync(from)) continue;
    ensureDir(path.dirname(to));
    fs.cpSync(from, to, { recursive: true, dereference: true });
  }
  return `minimal (${packageSet.size} packages)`;
}

function collectRuntimePackageClosure(rootPackages) {
  const queue = [...new Set(rootPackages)];
  const rootSet = new Set(queue);
  const visited = new Set();
  const missingRoots = [];

  while (queue.length > 0) {
    const pkgName = queue.shift();
    if (!pkgName || visited.has(pkgName)) continue;

    const pkgDir = resolvePackageDir(sourceNodeModulesDir, pkgName);
    if (!pkgDir || !fs.existsSync(pkgDir)) {
      if (rootSet.has(pkgName)) {
        missingRoots.push(pkgName);
      }
      continue;
    }

    visited.add(pkgName);

    const pkgJsonPath = path.join(pkgDir, 'package.json');
    if (!fs.existsSync(pkgJsonPath)) continue;

    let pkgJson;
    try {
      pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
    } catch {
      continue;
    }

    const deps = Object.keys(pkgJson.dependencies || {});
    const optionalDeps = Object.keys(pkgJson.optionalDependencies || {});

    for (const dep of [...deps, ...optionalDeps]) {
      if (!visited.has(dep)) queue.push(dep);
    }
  }

  if (missingRoots.length > 0) {
    console.warn(`Minimal runtime: missing root packages: ${missingRoots.join(', ')}`);
  }

  return visited;
}

function resolvePackageDir(nodeModulesRoot, pkgName) {
  if (!pkgName) return null;
  if (pkgName.startsWith('@')) {
    const [scope, name] = pkgName.split('/');
    if (!scope || !name) return null;
    return path.join(nodeModulesRoot, scope, name);
  }
  return path.join(nodeModulesRoot, pkgName);
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
