#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');

const TARGETS = {
  'win32-x64': {
    triple: 'x86_64-pc-windows-msvc',
    zigbuild: false,
    ext: '.exe'
  },
  'linux-x64': {
    triple: 'x86_64-unknown-linux-musl',
    zigbuild: true,
    ext: ''
  }
};

function hostKey() {
  const key = `${process.platform}-${process.arch}`;
  if (!(key in TARGETS)) {
    throw new Error(
      `Unsupported host ${key}. Pass --target explicitly (one of: ${Object.keys(TARGETS).join(', ')}).`
    );
  }
  return key;
}

function parseArgs(argv) {
  let target;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--target') {
      target = argv[++i];
    } else if (arg.startsWith('--target=')) {
      target = arg.slice('--target='.length);
    } else if (arg === '-h' || arg === '--help') {
      printUsage();
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      printUsage();
      process.exit(2);
    }
  }
  return { target, explicit: target !== undefined };
}

function printUsage() {
  console.log(`Usage: build-server.mjs [--target <platform-arch>]

Targets:
  win32-x64   Build for Windows x64 (cargo build --target x86_64-pc-windows-msvc)
  linux-x64   Build for Linux x64 with static musl linkage (cargo zigbuild
              --target x86_64-unknown-linux-musl) — requires cargo-zigbuild and zig.

Without --target, builds for the host platform using the default Rust toolchain
(no --target passed to cargo). Suitable for local development; not guaranteed
to be portable across Linux distros.`);
}

const { target, explicit } = parseArgs(process.argv.slice(2));
const key = target ?? hostKey();
const cfg = TARGETS[key];
if (!cfg) {
  console.error(`Unknown --target "${key}". Supported: ${Object.keys(TARGETS).join(', ')}`);
  process.exit(2);
}

if (!explicit) {
  console.log(
    `Building macro-scope-server for host (${key}). ` +
      `Use --target linux-x64 to cross-build a static musl binary suitable for release.`
  );
} else {
  console.log(`Building macro-scope-server for ${key} (${cfg.triple}).`);
}

const manifest = join(repoRoot, 'server', 'Cargo.toml');
const subcommand = cfg.zigbuild ? 'zigbuild' : 'build';
const cargoArgs = [subcommand, '--manifest-path', manifest, '--release'];
if (explicit) {
  cargoArgs.push('--target', cfg.triple);
}

const useEnvWrapper = process.platform === 'win32';
const wrapper = join(scriptDir, 'with-rust-env.mjs');
const cmd = useEnvWrapper ? process.execPath : 'cargo';
const args = useEnvWrapper ? [wrapper, 'cargo', ...cargoArgs] : cargoArgs;

console.log(`> ${cmd} ${args.map(quoteIfSpace).join(' ')}`);
const build = spawnSync(cmd, args, { stdio: 'inherit' });
if (build.status !== 0) {
  if (build.error) {
    console.error(build.error.message);
  }
  process.exit(build.status ?? 1);
}

const releaseDir = explicit
  ? join(repoRoot, 'server', 'target', cfg.triple, 'release')
  : join(repoRoot, 'server', 'target', 'release');
const srcBin = join(releaseDir, `macro-scope-server${cfg.ext}`);

if (!existsSync(srcBin)) {
  console.error(`Build succeeded but binary not found at ${srcBin}`);
  process.exit(1);
}

const destDir = join(repoRoot, 'server', 'bin', key);
const destBin = join(destDir, `macro-scope-server${cfg.ext}`);
mkdirSync(destDir, { recursive: true });
copyFileSync(srcBin, destBin);
if (cfg.ext === '' && process.platform !== 'win32') {
  chmodSync(destBin, 0o755);
}
console.log(`Copied ${srcBin}\n    -> ${destBin}`);

function quoteIfSpace(s) {
  return /\s/.test(s) ? `"${s}"` : s;
}
