$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $scriptDir

& (Join-Path $scriptDir 'with-rust-env.ps1') cargo build --manifest-path (Join-Path $repoRoot 'server/Cargo.toml') --release
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}

$extension = if ($IsWindows -or $env:OS -eq 'Windows_NT') { '.exe' } else { '' }
$source = Join-Path $repoRoot "server/target/release/macro-scope-server$extension"
$destinationDir = Join-Path $repoRoot 'server/bin'
$destination = Join-Path $destinationDir "macro-scope-server$extension"

New-Item -ItemType Directory -Force -Path $destinationDir | Out-Null
Copy-Item -LiteralPath $source -Destination $destination -Force
