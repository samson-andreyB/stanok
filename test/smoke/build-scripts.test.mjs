import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

function runNodeScript(scriptPath, payload) {
  const fullScriptPath = path.resolve(scriptPath);
  return spawnSync(process.execPath, [fullScriptPath, JSON.stringify(payload)], {
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

async function createSmokeTempDir() {
  const base = path.join(process.cwd(), '.tmp-smoke');
  await fs.mkdir(base, { recursive: true });
  return fs.mkdtemp(path.join(base, 'stanok-smoke-'));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('build-images copies changed file', async () => {
  const tmp = await createSmokeTempDir();
  const group = path.join(tmp, 'demo');
  const srcImg = path.join(group, 'assets', 'img', 'src');
  await fs.mkdir(srcImg, { recursive: true });
  await fs.writeFile(path.join(srcImg, 'x.png'), 'png');

  const res = runNodeScript(path.join('scripts', 'build-images.mjs'), {
    projects_path: tmp,
    project_name: 'demo/main',
    config: baseConfig(),
  });

  assert.equal(res.status, 0, res.stderr);
  const destFile = path.join(group, 'assets', 'img', 'dest', 'x.png');
  const copied = await fs.readFile(destFile, 'utf8');
  assert.equal(copied, 'png');
});

test('build-images is incremental for unchanged files', async () => {
  const tmp = await createSmokeTempDir();
  const group = path.join(tmp, 'demo');
  const srcImg = path.join(group, 'assets', 'img', 'src');
  await fs.mkdir(srcImg, { recursive: true });
  const imgFile = path.join(srcImg, 'x.png');
  await fs.writeFile(imgFile, 'png');

  const payload = {
    projects_path: tmp,
    project_name: 'demo/main',
    config: baseConfig(),
  };

  const first = runNodeScript(path.join('scripts', 'build-images.mjs'), payload);
  assert.equal(first.status, 0, first.stderr);
  const destFile = path.join(group, 'assets', 'img', 'dest', 'x.png');
  const firstContent = await fs.readFile(destFile, 'utf8');
  assert.equal(firstContent, 'png');
  const firstStat = await fs.stat(destFile);

  const second = runNodeScript(path.join('scripts', 'build-images.mjs'), payload);
  assert.equal(second.status, 0, second.stderr);
  const secondStat = await fs.stat(destFile);
  assert.equal(secondStat.mtimeMs, firstStat.mtimeMs, 'unchanged file should not be recopied');

  await sleep(20);
  await fs.writeFile(imgFile, 'png2');
  const third = runNodeScript(path.join('scripts', 'build-images.mjs'), payload);
  assert.equal(third.status, 0, third.stderr);
  const thirdContent = await fs.readFile(destFile, 'utf8');
  assert.equal(thirdContent, 'png2');
  const thirdStat = await fs.stat(destFile);
  assert.ok(thirdStat.mtimeMs >= secondStat.mtimeMs, 'changed file should be recopied');
});

test('build-css prints compact error for invalid css', async () => {
  const tmp = await createSmokeTempDir();
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

test('build-css is incremental and rebuilds on imported dependency change', async () => {
  const tmp = await createSmokeTempDir();
  const group = path.join(tmp, 'demo');
  const srcCss = path.join(group, 'assets', 'css', 'src');
  const moduleDir = path.join(srcCss, 'modules');
  const destImg = path.join(group, 'assets', 'img', 'dest');
  await fs.mkdir(moduleDir, { recursive: true });
  await fs.mkdir(destImg, { recursive: true });
  await fs.writeFile(path.join(destImg, 'x.png'), 'png');

  await fs.writeFile(path.join(srcCss, '_main.css'), "@import 'modules/_part';\n");
  const depFile = path.join(moduleDir, '_part.css');
  await fs.writeFile(depFile, ".A { background-image: url('/assets/img/dest/x.png'); }\n");

  const payload = {
    projects_path: tmp,
    project_name: 'demo/main',
    config: baseConfig(),
  };

  const first = runNodeScript(path.join('scripts', 'build-css.mjs'), payload);
  assert.equal(first.status, 0, first.stderr);
  const outCss = path.join(group, 'assets', 'css', 'main.css');
  const cacheFile = path.join(group, 'assets', 'css', '.css-build-cache.json');
  const firstCssText = await fs.readFile(outCss, 'utf8');
  assert.ok(firstCssText.length > 0, 'compiled css must be generated');
  const firstCssStat = await fs.stat(outCss);
  const firstCache = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
  assert.ok(firstCache.entries?.['_main.css'], 'cache entry for _main.css must exist');

  const second = runNodeScript(path.join('scripts', 'build-css.mjs'), payload);
  assert.equal(second.status, 0, second.stderr);
  const secondCssStat = await fs.stat(outCss);
  assert.equal(secondCssStat.mtimeMs, firstCssStat.mtimeMs, 'unchanged css should be skipped');

  await sleep(20);
  await fs.writeFile(depFile, ".A { background-image: url('/assets/img/dest/x.png'); color: #123456; }\n");
  const third = runNodeScript(path.join('scripts', 'build-css.mjs'), payload);
  assert.equal(third.status, 0, third.stderr);
  const thirdCssText = await fs.readFile(outCss, 'utf8');
  assert.ok(thirdCssText.includes('#123456'), 'changed dependency should trigger rebuild');
  const thirdCssStat = await fs.stat(outCss);
  assert.ok(thirdCssStat.mtimeMs >= secondCssStat.mtimeMs, 'rebuilt css should be rewritten');
});
