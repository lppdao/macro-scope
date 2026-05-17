# Macro Scope

Macro Scope is a VS Code extension prototype for C/C++ files. It starts a Rust LSP server, parses preprocessor control blocks, and shows the macro-control chain for the current cursor line in a native tree view.

## Supported platforms

- Windows x64 (`win32-x64`)
- Linux x64 (`linux-x64`), built against musl for broad glibc-version compatibility

The extension picks the right server binary at runtime from `server/bin/<platform>-<arch>/` (e.g. `server/bin/linux-x64/macro-scope-server`).

## Development

Install dependencies:

```sh
npm install
```

Compile the TypeScript extension client:

```sh
npm run compile
```

Run the Rust parser/server tests on the host platform:

```sh
npm run test-server
```

Build the Rust LSP server for the host platform (no cross-compile):

```sh
npm run build-server
```

The host build is for local development and is **not** guaranteed to be portable across distros (on Linux it dynamically links against the host glibc).

## Building release binaries

### Windows x64

```sh
npm run build-server:win32-x64
```

Requires the `x86_64-pc-windows-msvc` Rust target. If not installed:

```sh
rustup target add x86_64-pc-windows-msvc
```

Output: `server/bin/win32-x64/macro-scope-server.exe`.

### Linux x64 (static musl — recommended for distribution)

The Linux binary is built with `cargo zigbuild` against `x86_64-unknown-linux-musl`, producing a statically linked executable that runs on any glibc/musl Linux distribution (kernel ≥ 2.6.39). This is the build that should ship in the VSIX.

One-time setup (on Windows, Linux, or macOS hosts):

```sh
# 1. Install Zig (Zigbuild uses it as the C/linker toolchain). Pick one:
pip install ziglang             # cross-platform; exposes "python -m ziglang"
# or download a Zig release from https://ziglang.org/download/ and put it on PATH
# or: brew install zig / scoop install zig / choco install zig

# 2. Install the cargo-zigbuild subcommand
cargo install --locked cargo-zigbuild

# 3. Add the musl target
rustup target add x86_64-unknown-linux-musl
```

Then build:

```sh
npm run build-server:linux-x64
```

Output: `server/bin/linux-x64/macro-scope-server` (static musl, no glibc dependency).

#### Native Linux host: skip zigbuild

If you build on a Linux host you can avoid zigbuild entirely and let `cargo`
link directly:

```sh
sudo apt-get install -y musl-tools     # provides musl-gcc as the linker
rustup target add x86_64-unknown-linux-musl
npm run build-server:linux-x64 -- --no-zigbuild
```

This is what the CI workflow does on `ubuntu-latest`. zigbuild is still
required when cross-building from Windows/macOS to Linux.

### All supported targets

```sh
npm run build-server:all
```

Runs the Windows and Linux release builds in sequence.

## Packaging

Build the release binaries you want to ship, then package the VSIX:

```sh
npm run compile
npm run test-server
npm run build-server:all
npm run package:vsix
```

The generated file is named from the version in `package.json`, for example:

```text
macro-scope-0.1.2.vsix
```

Install the generated VSIX into VS Code:

```sh
code --install-extension ./macro-scope-0.1.2.vsix
```

## Packaging checklist

Before creating a release VSIX:

1. Update the extension version in `package.json` and `package-lock.json`.
2. Run `npm run compile`.
3. Run `npm run test-server`.
4. Run `npm run build-server:all` (or only the targets you want to ship).
5. Confirm the bundled binaries exist under `server/bin/<platform>-<arch>/`.
6. Run `npm run package:vsix`.
7. Install the generated VSIX locally and smoke-test a C/C++ file with nested `#if/#else/#endif` blocks on each target platform you ship.

## Runtime binary resolution

At activation the extension looks up the server binary in this order:

1. `server/bin/<platform>-<arch>/macro-scope-server[.exe]` (shipped by the VSIX)
2. `server/bin/macro-scope-server[.exe]` (legacy layout, kept for backward compatibility)
3. `server/target/<target-triple>/release/macro-scope-server[.exe]` (when developing locally with `--target`)
4. `server/target/release/macro-scope-server[.exe]` (host-default `cargo build`)
5. `server/target/debug/macro-scope-server[.exe]`

On Linux/macOS the extension also ensures the chosen file has the executable bit set (some zip-based VSIX flows drop the +x bit).

## Notes for Windows hosts

The npm Rust scripts use `scripts/with-rust-env.mjs` to load `CARGO_HOME`, `RUSTUP_HOME`, and the User `Path` from the registry before invoking Cargo. This keeps builds working even when the parent process was started before those variables were refreshed.

If Cargo fails with `拒绝访问` / `Access is denied` while rewriting files under `server/target`, close any running VS Code Extension Host or old `macro-scope-server.exe` process and rerun the command. If the old target directory is locked by another process, use a fresh target directory for a one-off verification:

```sh
CARGO_TARGET_DIR=./server/target-test npm run test-server
```

On Windows PowerShell:

```powershell
$env:CARGO_TARGET_DIR = "$PWD\server\target-test"
npm run test-server
```

## Troubleshooting

### Windows: `cargo zigbuild` cannot find Zig (`error: failed to run 'zig'` / `python -m ziglang` fails)

`cargo-zigbuild` finds the Zig compiler in this order:

1. The `ZIG` environment variable (full path to a Zig binary or launcher)
2. A `zig` / `zig.exe` / `zig.cmd` file on `PATH`
3. `python3 -m ziglang` / `python -m ziglang`

On Windows, the `python` command is often resolved to the Microsoft Store
"app execution alias" stub at
`%LOCALAPPDATA%\Microsoft\WindowsApps\python.exe`. That stub immediately exits
with code 49 and no output when launched non-interactively, so step 3 above
silently fails even after `pip install --user ziglang` succeeds.

The clean workaround is a one-line `zig.cmd` shim placed in a directory that
is already on `PATH` (for example `%CARGO_HOME%\bin`, which contains
`cargo.exe`):

```cmd
@"C:\Users\<you>\AppData\Local\Programs\Python\Python312\python.exe" -m ziglang %*
```

Replace the path with the location of your real Python interpreter
(`where.exe python` shows every candidate; pick the one **not** under
`WindowsApps`). After saving the file, verify it works:

```sh
where zig          # should print the path to zig.cmd
cmd //c "zig version"  # should print 0.16.0 or similar
```

`cargo zigbuild` will then locate Zig through `PATH` without any further
configuration. The shim is a local machine setup; it is not part of the
repository.

### Linux/macOS

Install Zig the usual way for your distribution (`brew install zig`,
`apt install zig`, or `pip install --user ziglang`, which on POSIX systems
exposes a working `python -m ziglang` automatically). No shim needed.
