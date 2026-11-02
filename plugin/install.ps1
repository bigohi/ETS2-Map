# Installs (or removes) the ETS2-Map telemetry plugin in the game folder:
#   <ETS2>\bin\win_x64\plugins\ets2map_telemetry.dll
# Usage: plugin\install.ps1 [-GameDir "<ETS2 folder>"] [-Uninstall]
param(
  [string]$GameDir,
  [switch]$Uninstall
)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here

if (-not $GameDir) { $GameDir = (node "$root\tools\game-dir.mjs").Trim() }
if (-not $GameDir -or -not (Test-Path (Join-Path $GameDir 'base.scs'))) {
  throw "Euro Truck Simulator 2 introuvable. Relance avec -GameDir 'D:\...\Euro Truck Simulator 2'"
}
$plugins = Join-Path $GameDir 'bin\win_x64\plugins'
$target = Join-Path $plugins 'ets2map_telemetry.dll'

if ($Uninstall) {
  if (Test-Path $target) { Remove-Item $target -Force; "Plugin supprimé : $target" } else { "Plugin absent, rien à faire." }
  return
}

$dll = Join-Path $here 'build\ets2map_telemetry.dll'
if (-not (Test-Path $dll)) { & (Join-Path $here 'build.ps1') | Out-Null }
if (Get-Process eurotrucks2 -ErrorAction SilentlyContinue) {
  Write-Warning "ETS2 est lancé : le plugin sera pris en compte au prochain démarrage du jeu."
}
New-Item -ItemType Directory -Force $plugins | Out-Null
Copy-Item $dll $target -Force
"Plugin installé : $target"
"Au prochain lancement, ETS2 affiche un message sur les fonctions SDK avancées : clique OK."
