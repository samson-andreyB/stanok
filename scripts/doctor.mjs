import fs from 'node:fs';
import { cmdOk, pkgOk } from './cli-utils.mjs';

const checks = [];

function add(name, ok, details = '') {
  checks.push({ name, ok, details });
}

const cargo = cmdOk('cargo');
add('cargo', cargo.ok, cargo.out || 'not found');

const rustc = cmdOk('rustc');
add('rustc', rustc.ok, rustc.out || 'not found');

const cc = cmdOk('cc');
add('cc', cc.ok, cc.out || 'not found');

const git = cmdOk('git');
add('git', git.ok, git.out || 'not found');

const pkgCfg = cmdOk('pkg-config');
add('pkg-config', pkgCfg.ok, pkgCfg.out || 'not found');

if (pkgCfg.ok) {
  add('gtk+-3.0 (pkg-config)', pkgOk('gtk+-3.0'));
  add('webkit2gtk-4.1 (pkg-config)', pkgOk('webkit2gtk-4.1'));
  add('libsoup-3.0 (pkg-config)', pkgOk('libsoup-3.0'));
}

const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const cargoToml = fs.readFileSync('src-tauri/Cargo.toml', 'utf8');

const apiVersion = packageJson.dependencies?.['@tauri-apps/api'] || '';
const cliVersion = packageJson.devDependencies?.['@tauri-apps/cli'] || '';
const tauriCrate = (cargoToml.match(/^tauri\s*=\s*\{\s*version\s*=\s*"([^"]+)"/m) || [])[1] || '';
const tauriBuildCrate = (cargoToml.match(/^tauri-build\s*=\s*\{\s*version\s*=\s*"([^"]+)"/m) || [])[1] || '';

const major = (v) => String(v).replace(/^[^0-9]*/, '').split('.')[0];
const sameMajor = major(apiVersion) && major(apiVersion) === major(cliVersion) && major(apiVersion) === major(tauriCrate) && major(apiVersion) === major(tauriBuildCrate);

add('Tauri package/crate major versions aligned', Boolean(sameMajor), `api=${apiVersion}, cli=${cliVersion}, tauri=${tauriCrate}, tauri-build=${tauriBuildCrate}`);

let failed = 0;
for (const c of checks) {
  if (!c.ok) failed += 1;
  const marker = c.ok ? 'OK  ' : 'FAIL';
  const details = c.details ? ` :: ${c.details}` : '';
  console.log(`${marker} ${c.name}${details}`);
}

if (failed) {
  console.error(`\nDoctor finished with ${failed} failing check(s).`);
  process.exit(1);
}

console.log('\nDoctor finished successfully.');
