import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

function runNodeScript(scriptPath, payload) {
  return spawnSync(process.execPath, [scriptPath, JSON.stringify(payload)], {
    encoding: 'utf8',
    cwd: process.cwd(),
  });
}

function baseConfig() {
  return {
    nest: '',
    root: 'assets/',
    style: 'css',
    img: 'img',
    layouts: '_layouts',
    b: 'src/b',
    html: '_html',
    lib: '../lib',
    browsers: ['last 2 versions'],
  };
}

test('build-css prints compact error for invalid css', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'stanok-smoke-'));
  const group = path.join(tmp, 'demo');
  const srcCss = path.join(group, 'assets', 'css', 'src');
  await fs.mkdir(srcCss, { recursive: true });
  await fs.writeFile(path.join(srcCss, '_main.css'), '.A { color: red');

  const res = runNodeScript(path.join('scripts', 'build-css.mjs'), {
    projects_path: tmp,
    project_name: 'demo/main',
    config: baseConfig(),
  });

  assert.notEqual(res.status, 0);
  const output = `${res.stderr || ''}\n${res.stdout || ''}`.trim();
  if (output) {
    assert.ok(!output.includes('source:'), 'error output should not dump full source');
    assert.ok(output.split('\n').length <= 2, `error should be compact, got: ${output}`);
  }
});
