import path from 'node:path';

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
