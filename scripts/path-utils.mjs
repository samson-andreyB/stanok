import path from 'node:path';
import os from 'node:os';

export function normalizeRel(value) {
  return String(value || '').replace(/^[/\\]+/, '').replace(/[/\\]+$/, '');
}

export function normalizeRoot(root) {
  if (root === '') return '';
  const rel = normalizeRel(root);
  return rel ? `${rel}/` : 'assets/';
}

export function resolveProjectDir(projectsPath, projectName, nest) {
  const group = String(projectName).split('/')[0];
  const nestPath = normalizeRel(nest || '');
  return nestPath ? path.join(projectsPath, group, nestPath) : path.join(projectsPath, group);
}

export function buildPathToProjectsRoot(nest) {
  const n = normalizeRel(nest);
  if (!n) return '';
  const level = n.split(/[\\/]/).length;
  return '../'.repeat(level);
}

export function resolveStanokCacheRoot() {
  const custom = String(process.env.STANOK_CACHE_DIR || '').trim();
  if (custom) {
    return path.resolve(custom);
  }

  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || process.env.APPDATA || os.tmpdir(), 'stanok');
  }

  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Caches', 'stanok');
  }

  return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'stanok');
}
