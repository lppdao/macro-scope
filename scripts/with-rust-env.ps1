param(
  [Parameter(Mandatory = $true, ValueFromRemainingArguments = $true)]
  [string[]] $Command
)

$cargoHome = [Environment]::GetEnvironmentVariable('CARGO_HOME', 'User')
$rustupHome = [Environment]::GetEnvironmentVariable('RUSTUP_HOME', 'User')
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')

if ($cargoHome) {
  $env:CARGO_HOME = $cargoHome
}

if ($rustupHome) {
  $env:RUSTUP_HOME = $rustupHome
}

if ($userPath) {
  $env:Path = "$userPath;$env:Path"
}

if (-not (Get-Command $Command[0] -ErrorAction SilentlyContinue)) {
  Write-Error "Command '$($Command[0])' was not found after loading user Rust environment variables."
  exit 1
}

& $Command[0] @($Command | Select-Object -Skip 1)
exit $LASTEXITCODE
