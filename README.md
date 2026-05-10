# Macro Scope

Macro Scope is a VS Code extension prototype for C/C++ files. It starts a Rust LSP server, parses preprocessor control blocks, and shows the macro-control chain for the current cursor line in a native tree view.

## Development

Install dependencies:

```powershell
npm install
```

Compile the TypeScript extension client:

```powershell
npm run compile
```

Run the Rust parser/server tests:

```powershell
npm run test-server
```

Build the Rust LSP server and copy the release binary into `server/bin`:

```powershell
npm run build-server
```

Build everything needed before packaging:

```powershell
npm run compile
npm run test-server
npm run build-server
```

## Packaging

Package the extension as a VSIX:

```powershell
npm run package:vsix
```

The generated file is named from the version in `package.json`, for example:

```text
macro-scope-0.1.2.vsix
```

Install the generated VSIX into VS Code:

```powershell
code --install-extension .\macro-scope-0.1.2.vsix
```

## Packaging Checklist

Before creating a release VSIX:

1. Update the extension version in `package.json` and `package-lock.json`.
2. Run `npm run compile`.
3. Run `npm run test-server`.
4. Run `npm run build-server`.
5. Run `npm run package:vsix`.
6. Install the generated VSIX locally and smoke-test a C/C++ file with nested `#if/#else/#endif` blocks.

The extension prefers the bundled server binary under `server/bin`. During local development, if no bundled binary exists, it falls back to `server/target/release` and then `server/target/debug`.

On Windows, the npm Rust scripts load `CARGO_HOME`, `RUSTUP_HOME`, and User `Path` before invoking Cargo. This keeps builds working even when the parent process was started before the Rust environment variables were refreshed.

If Cargo fails with `拒绝访问` / `Access is denied` while rewriting files under `server/target`, close any running VS Code Extension Host or old `macro-scope-server.exe` process and rerun the command. If the old target directory is locked by another process, use a fresh target directory for one-off verification:

```powershell
$env:CARGO_TARGET_DIR = "$PWD\server\target-test"
npm run test-server
```
