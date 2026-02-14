import { spawnSync } from 'node:child_process';

export function runCommand(cmd, args = [], options = {}) {
  return spawnSync(cmd, args, {
    encoding: 'utf8',
    shell: process.platform === 'win32',
    ...options,
  });
}

export function hasCommand(cmd) {
  const checker = process.platform === 'win32' ? 'where' : 'which';
  const result = spawnSync(checker, [cmd], { stdio: 'ignore' });
  return result.status === 0;
}

export function runOrExit(cmd, args = []) {
  const result = runCommand(cmd, args, { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}

export function cmdOk(cmd, args = ['--version']) {
  const result = runCommand(cmd, args);
  return {
    ok: result.status === 0,
    out: (result.stdout || result.stderr || '').trim().split('\n')[0] || '',
  };
}

export function pkgOk(name) {
  const result = runCommand('pkg-config', ['--exists', name], { stdio: 'ignore' });
  return result.status === 0;
}
