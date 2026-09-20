# Converts the local pi-vcc working copy into the upstream git submodule.
# Run from any directory:  .\scripts\setup-upstream-vcc.ps1
$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

if (-not (Test-Path '.git')) {
    throw "Not a git repository: $repo"
}

if (Test-Path 'third_party/pi-vcc') {
    Write-Host 'Removing the local pi-vcc placeholder copy...'
    Remove-Item -Recurse -Force 'third_party/pi-vcc'
}

if (Test-Path '.gitignore') {
    Write-Host 'Removing the ignore rule for third_party/pi-vcc...'
    $lines = Get-Content '.gitignore' | Where-Object { $_.Trim() -ne '/third_party/pi-vcc/' }
    Set-Content '.gitignore' $lines
}

Write-Host 'Adding upstream pi-vcc as a submodule...'
git submodule add https://github.com/sting8k/pi-vcc.git third_party/pi-vcc

Write-Host 'Committing...'
git add .gitignore .gitmodules third_party/pi-vcc
git commit -m 'Use upstream pi-vcc as a git submodule'

Write-Host ''
Write-Host 'Done. Update it later with:'
Write-Host '  git submodule update --remote --merge third_party/pi-vcc'
