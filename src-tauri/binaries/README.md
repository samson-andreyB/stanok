Node sidecar binaries for Tauri `externalBin`.

Place platform builds here using Tauri naming:

- Linux: `node-x86_64-unknown-linux-gnu`
- Windows: `node-x86_64-pc-windows-msvc.exe`
- macOS arm64: `node-aarch64-apple-darwin`
- macOS x64 (optional): `node-x86_64-apple-darwin`

Tauri config uses:

- `bundle.externalBin = ["binaries/node"]`

So each release bundle should include the matching sidecar binary for its target triple.
