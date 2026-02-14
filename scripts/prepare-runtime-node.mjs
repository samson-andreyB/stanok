import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const sourceNodeModules = path.join(repoRoot, 'node_modules');
const sourceScriptsDir = path.join(repoRoot, 'scripts');
const runtimeRoot = path.join(repoRoot, 'src-tauri', 'runtime-node');
const runtimeScriptsDir = path.join(runtimeRoot, 'scripts');
const runtimeNodeModules = path.join(runtimeRoot, 'node_modules');

const ENTRY_PACKAGES = ['intcss', 'postcss5'];

const requireFromRepo = createRequire(path.join(repoRoot, 'package.json'));
const copiedPackages = new Set();

async function main() {
  await fs.rm(runtimeRoot, { recursive: true, force: true });
  await fs.mkdir(runtimeScriptsDir, { recursive: true });
  await fs.mkdir(runtimeNodeModules, { recursive: true });

  await copyBuildScripts();
  for (const pkg of ENTRY_PACKAGES) {
    await copyPackageTree(pkg, repoRoot);
  }

  const runtimePkg = {
    name: 'stanok-runtime-node',
    private: true,
    type: 'module',
  };
  await fs.writeFile(
    path.join(runtimeRoot, 'package.json'),
    JSON.stringify(runtimePkg, null, 2),
    'utf8'
  );
  console.log(`Runtime node deps prepared: ${copiedPackages.size} packages`);
}

async function copyBuildScripts() {
  const files = await fs.readdir(sourceScriptsDir);
  for (const file of files) {
    if (!file.endsWith('.mjs')) {
      continue;
    }
    const from = path.join(sourceScriptsDir, file);
    const to = path.join(runtimeScriptsDir, file);
    await fs.copyFile(from, to);
  }
}

async function copyPackageTree(packageName, basedir) {
  const packageDir = await resolvePackageDir(packageName, basedir);
  const manifestPath = path.join(packageDir, 'package.json');
  const relToNodeModules = path.relative(sourceNodeModules, packageDir);
  if (relToNodeModules.startsWith('..') || path.isAbsolute(relToNodeModules)) {
    throw new Error(`Package ${packageName} resolved outside node_modules: ${packageDir}`);
  }

  const destDir = path.join(runtimeNodeModules, relToNodeModules);
  const key = relToNodeModules.replace(/\\/g, '/');
  if (copiedPackages.has(key)) {
    return;
  }

  await fs.mkdir(path.dirname(destDir), { recursive: true });
  await fs.cp(packageDir, destDir, { recursive: true });
  copiedPackages.add(key);

  const manifestRaw = await fs.readFile(manifestPath, 'utf8');
  const manifest = JSON.parse(manifestRaw);
  const deps = Object.keys(manifest.dependencies || {});
  for (const dep of deps) {
    await copyPackageTree(dep, packageDir);
  }
}

async function resolvePackageDir(packageName, basedir) {
  for (const lookupRoot of [basedir, repoRoot]) {
    const directDir = path.join(lookupRoot, 'node_modules', ...packageName.split('/'));
    const directManifest = path.join(directDir, 'package.json');
    if (await exists(directManifest)) {
      return directDir;
    }
  }

  const rootDirectDir = path.join(sourceNodeModules, ...packageName.split('/'));
  if (await exists(path.join(rootDirectDir, 'package.json'))) {
    return rootDirectDir;
  }

  try {
    const entryPath = requireFromRepo.resolve(packageName, { paths: [basedir, sourceNodeModules] });
    let cursor = path.dirname(entryPath);
    for (let i = 0; i < 8; i += 1) {
      const manifest = path.join(cursor, 'package.json');
      if (await exists(manifest)) {
        return cursor;
      }
      const next = path.dirname(cursor);
      if (next === cursor) {
        break;
      }
      cursor = next;
    }
  } catch {
    // continue to error below
  }

  throw new Error(`Runtime package not found: ${packageName}`);
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

main().catch((error) => {
  console.error(error?.message || String(error));
  process.exit(1);
});
