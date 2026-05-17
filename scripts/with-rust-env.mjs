#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { delimiter } from 'node:path';

function readUserEnvFromRegistry(name) {
  const result = spawnSync('reg', ['query', 'HKCU\\Environment', '/v', name], {
    encoding: 'utf8',
    windowsHide: true
  });
  if (result.status !== 0) {
    return undefined;
  }
  const match = result.stdout.match(new RegExp(`${name}\\s+REG_(?:SZ|EXPAND_SZ)\\s+(.+)`, 'i'));
  if (!match) {
    return undefined;
  }
  return expandWindowsVars(match[1].trim());
}

function expandWindowsVars(value) {
  return value.replace(/%([^%]+)%/g, (_, varName) => process.env[varName] ?? `%${varName}%`);
}

function buildEnv() {
  const env = { ...process.env };
  if (process.platform !== 'win32') {
    return env;
  }

  const userCargo = readUserEnvFromRegistry('CARGO_HOME');
  const userRustup = readUserEnvFromRegistry('RUSTUP_HOME');
  const userPath = readUserEnvFromRegistry('Path');

  if (userCargo) {
    env.CARGO_HOME = userCargo;
  }
  if (userRustup) {
    env.RUSTUP_HOME = userRustup;
  }
  if (userPath) {
    env.Path = `${userPath}${delimiter}${env.Path ?? ''}`;
  }
  return env;
}

const argv = process.argv.slice(2);
if (argv.length === 0) {
  console.error('Usage: with-rust-env.mjs <command> [args...]');
  process.exit(1);
}

const [command, ...args] = argv;
const child = spawn(command, args, {
  stdio: 'inherit',
  env: buildEnv(),
  shell: process.platform === 'win32',
  windowsHide: true
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

child.on('error', (error) => {
  console.error(`Failed to launch '${command}': ${error.message}`);
  process.exit(127);
});
