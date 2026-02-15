Bundled Node.js runtime for production builds.

Expected layout:

- `runtime-node/node_modules/*` (runtime JS deps used by build scripts)
- `runtime-node/scripts/*` (build worker and scripts)

Use Node 20 LTS for all platforms to keep behavior consistent.

At runtime the app resolves Node in this order:

1. sidecar binary from `bundle.externalBin` (`binaries/node-*`)
2. local `src-tauri/binaries/node-*` (dev fallback)
3. system `node` from PATH (debug only)
