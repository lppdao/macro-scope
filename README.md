# Macro Scope

Macro Scope is a VS Code extension prototype for C/C++ files. It starts a Rust LSP server, parses preprocessor control blocks, and shows the macro-control chain for the current cursor line in a native tree view.

## Development

```powershell
npm install
npm run compile
npm run test-server
npm run build-server
```

The extension looks for the server binary under `server/target/release` first, then `server/target/debug`.

On Windows, the npm Rust scripts load `CARGO_HOME`, `RUSTUP_HOME`, and User `Path` before invoking Cargo. This keeps builds working even when the parent process was started before the Rust environment variables were refreshed.
