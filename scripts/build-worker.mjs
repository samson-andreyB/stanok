import readline from 'node:readline';
import { runBuild as runCssBuild } from './build-css.mjs';
import { runBuild as runImagesBuild } from './build-images.mjs';

const handlers = {
  'build-css.mjs': runCssBuild,
  'build-images.mjs': runImagesBuild,
};

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

rl.on('line', async (line) => {
  if (!line || !line.trim()) {
    return;
  }

  let req;
  try {
    req = JSON.parse(line);
  } catch {
    writeResponse({ id: null, ok: false, error: 'Invalid JSON request' });
    return;
  }

  const id = req?.id ?? null;
  const script = String(req?.script || '');
  const payload = req?.payload;
  const handler = handlers[script];

  if (!handler) {
    writeResponse({ id, ok: false, error: `Unsupported script: ${script}` });
    return;
  }
  if (!payload || typeof payload !== 'object') {
    writeResponse({ id, ok: false, error: 'Invalid build payload' });
    return;
  }

  try {
    const output = await handler(payload);
    writeResponse({ id, ok: true, output: output || '' });
  } catch (error) {
    const message = formatError(error);
    writeResponse({ id, ok: false, error: message });
  }
});

function writeResponse(response) {
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

function formatError(error) {
  if (!error || typeof error !== 'object') {
    return String(error);
  }

  const plugin = error.plugin ? `${String(error.plugin)}: ` : '';
  const file = error.file || error.fileName || error.input?.file || '';
  const line = error.line ?? error.lineNumber ?? error.input?.line;
  const column = error.column ?? error.columnNumber ?? error.input?.column;
  const reason = error.reason || error.originalMessage || error.message || 'Ошибка сборки';

  if (file && line && column) {
    return `${plugin}${file}:${line}:${column}: ${reason}`;
  }
  if (file) {
    return `${plugin}${file}: ${reason}`;
  }
  return `${plugin}${reason}`;
}
