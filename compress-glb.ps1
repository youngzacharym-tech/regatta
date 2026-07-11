# Compress a .glb with Draco geometry compression.
#
# Reads the current stage/public/regatta.glb, backs up the uncompressed
# original as regatta-uncompressed.glb.bak, writes a compressed regatta.glb.
#
# Usage from PowerShell:
#   .\compress-glb.ps1
#
# Requires Node.js + npx (installed as part of Node).

$publicDir = Join-Path $PSScriptRoot "stage\public"
$source = Join-Path $publicDir "regatta.glb"
$temp = Join-Path $publicDir "regatta-draco.glb"
# Backup lives OUTSIDE stage/public — Vite copies public/ into every build,
# and a 27 MB .bak has no business in the deployed bundle.
$backupDir = Join-Path $PSScriptRoot "backups"
if (-not (Test-Path $backupDir)) { New-Item -ItemType Directory $backupDir | Out-Null }
$backup = Join-Path $backupDir "regatta-uncompressed.glb.bak"

if (-not (Test-Path $source)) {
    Write-Error "No regatta.glb at $source"
    exit 1
}

$before = (Get-Item $source).Length / 1MB
Write-Host "Before: $([math]::Round($before, 2)) MB"

npx --yes "@gltf-transform/cli@latest" draco $source $temp
if ($LASTEXITCODE -ne 0) {
    Write-Error "gltf-transform draco failed"
    exit $LASTEXITCODE
}

Move-Item $source $backup -Force
Move-Item $temp $source -Force

$after = (Get-Item $source).Length / 1MB
$ratio = $before / $after
Write-Host "After:  $([math]::Round($after, 2)) MB  ($([math]::Round($ratio, 1))x smaller)"
Write-Host "Backup saved to $backup"
