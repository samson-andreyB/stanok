import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const RUN_E2E = process.env.STANOK_RUN_E2E === '1';

test('tauri dev startup smoke', { skip: !RUN_E2E }, async () => {
  const child = spawn('npm', ['run', 'dev'], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });

  let output = '';
  let done = false;

  const onData = (chunk) => {
    output += chunk.toString();
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);

  try {
    await waitFor(
      () =>
        output.includes('VITE v') &&
        output.includes('Local:   http://127.0.0.1:5173/') &&
        output.includes('Running `target/debug/stanok`'),
      90_000
    );
    done = true;
  } finally {
    child.stdout.off('data', onData);
    child.stderr.off('data', onData);
    killProcessTree(child);
  }

  assert.equal(done, true, `Dev startup markers were not detected.\n\nOutput:\n${tail(output, 4000)}`);
});

async function waitFor(check, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (check()) {
      return;
    }
    await sleep(250);
  }
  throw new Error(`Timeout ${timeoutMs}ms`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function killProcessTree(child) {
  if (!child || child.killed) {
    return;
  }

  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    // ignore
  }

  setTimeout(() => {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // ignore
    }
  }, 1500);
}

function tail(value, maxLen) {
  if (value.length <= maxLen) {
    return value;
  }
  return value.slice(value.length - maxLen);
}
