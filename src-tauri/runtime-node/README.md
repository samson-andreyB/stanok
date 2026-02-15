Bundled Node.js runtime for production builds.

Expected layout:

- `runtime-node/linux-x64/node`
- `runtime-node/win-x64/node.exe`
- `runtime-node/macos-arm64/node`
- optional: `runtime-node/macos-x64/node`
- `runtime-node/node_modules/*` (runtime JS deps used by build scripts)

Use Node 20 LTS for all platforms to keep behavior consistent.

At runtime the app resolves Node in this order:

1. bundled runtime in app resources
2. local `src-tauri/runtime-node/*` (dev fallback)
3. system `node` from PATH
