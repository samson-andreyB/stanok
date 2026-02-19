import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO_ROOT = process.cwd();
const CASES_PATH = path.join(REPO_ROOT, 'test', 'style_pipeline', 'cases', 'legacy-baseline.cases.json');
const UPDATE_BASELINE = process.env.STANOK_UPDATE_STYLE_BASELINE === '1';

function runLegacyBuild(payload, env = {}) {
  return spawnSync(process.execPath, [path.join('scripts', 'build-css.mjs'), JSON.stringify(payload)], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...env,
    },
  });
}

function readCases() {
  const raw = fssync.readFileSync(CASES_PATH, 'utf8');
  return JSON.parse(raw);
}

async function copyDir(from, to) {
  await fs.rm(to, { recursive: true, force: true });
  await fs.mkdir(path.dirname(to), { recursive: true });
  await fs.cp(from, to, { recursive: true });
}

async function captureGoldenOutputs(workRoot, goldenRoot, c) {
  await fs.rm(goldenRoot, { recursive: true, force: true });
  await fs.mkdir(goldenRoot, { recursive: true });

  const outputCssDir = path.join(workRoot, 'demo', 'assets', 'css');
  if (fssync.existsSync(outputCssDir)) {
    await fs.cp(outputCssDir, path.join(goldenRoot, 'demo', 'assets', 'css'), { recursive: true });
    await fs.rm(path.join(goldenRoot, 'demo', 'assets', 'css', 'src'), { recursive: true, force: true });
  }

  for (const relPath of c.optional_extra_paths || []) {
    const srcPath = path.join(workRoot, relPath);
    if (!fssync.existsSync(srcPath)) continue;
    const dstPath = path.join(goldenRoot, relPath);
    await fs.mkdir(path.dirname(dstPath), { recursive: true });
    await fs.cp(srcPath, dstPath, { recursive: true });
  }
}

async function collectFiles(root) {
  const out = [];
  if (!fssync.existsSync(root)) return out;

  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        out.push(path.relative(root, full).split(path.sep).join('/'));
      }
    }
  }

  await walk(root);
  out.sort();
  return out;
}

function assertValidSourceMap(mapRaw, mapPath) {
  let parsed;
  try {
    parsed = JSON.parse(mapRaw);
  } catch (error) {
    assert.fail(`Invalid sourcemap JSON at ${mapPath}: ${String(error)}`);
  }

  assert.ok(Array.isArray(parsed.sources), `${mapPath}: sources must be an array`);
  assert.ok(parsed.sources.length > 0, `${mapPath}: sources must not be empty`);
  assert.equal(typeof parsed.mappings, 'string', `${mapPath}: mappings must be a string`);
  assert.ok(parsed.mappings.length > 0, `${mapPath}: mappings must not be empty`);
}

test('legacy baseline fixtures satisfy artifact contract', async () => {
  const cases = readCases();
  assert.ok(Array.isArray(cases) && cases.length > 0, 'cases must be non-empty');

  for (const c of cases) {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), `stanok-style-baseline-${c.id}-`));
    try {
      const inputRootAbs = path.join(REPO_ROOT, c.input_root);
      const workRoot = path.join(tempRoot, 'work');
      await copyDir(inputRootAbs, workRoot);

      const projectsPath = c.projects_path_mode === 'input_root'
        ? workRoot
        : path.join(workRoot, 'projects');

      const payload = {
        projects_path: projectsPath,
        project_name: c.project_name,
        config: c.config,
      };

      const result = runLegacyBuild(payload, c.env || {});
      assert.equal(
        result.status,
        0,
        [
          `legacy build failed for case=${c.id}`,
          `stdout:\n${result.stdout || ''}`,
          `stderr:\n${result.stderr || ''}`,
        ].join('\n')
      );

      for (const relPath of c.required_outputs) {
        const absPath = path.join(workRoot, relPath);
        assert.ok(fssync.existsSync(absPath), `missing css output: ${relPath}`);
        const css = await fs.readFile(absPath, 'utf8');
        assert.ok(css.trim().length > 0, `css output is empty: ${relPath}`);
      }

      for (const relPath of c.required_maps) {
        const absPath = path.join(workRoot, relPath);
        assert.ok(fssync.existsSync(absPath), `missing sourcemap: ${relPath}`);
        const raw = await fs.readFile(absPath, 'utf8');
        assertValidSourceMap(raw, relPath);
      }

      for (const relPath of c.optional_extra_paths || []) {
        const absPath = path.join(workRoot, relPath);
        if (fssync.existsSync(absPath)) {
          const st = await fs.stat(absPath);
          assert.ok(st.isDirectory() || st.isFile(), `optional path must be file/dir: ${relPath}`);
        }
      }

      const goldenRootAbs = path.join(REPO_ROOT, c.golden_root);
      if (UPDATE_BASELINE) {
        await captureGoldenOutputs(workRoot, goldenRootAbs, c);
      } else {
        assert.ok(fssync.existsSync(goldenRootAbs), `missing golden baseline dir: ${c.golden_root}`);

        const goldenFiles = await collectFiles(goldenRootAbs);
        assert.ok(goldenFiles.length > 0, `golden baseline is empty: ${c.golden_root}`);

        for (const relPath of [...c.required_outputs, ...c.required_maps]) {
          assert.ok(
            goldenFiles.includes(relPath),
            `golden baseline missing expected artifact: ${c.golden_root}/${relPath}`,
          );
        }
      }
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  }
});
