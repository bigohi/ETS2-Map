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

if (-not $GameDir) {
  $found = node "$root\tools\game-dir.mjs" 2>$null
  if ($found -and "$found".Trim() -ne 'not found') { $GameDir = "$found".Trim() }
}
if (-not $GameDir -or -not (Test-Path (Join-Path $GameDir 'base.scs'))) {
  Write-Host "Dossier d'Euro Truck Simulator 2 introuvable automatiquement."
  Write-Host "Dans Steam : clic droit sur Euro Truck Simulator 2 > Gérer > Parcourir les fichiers locaux, puis copie l'adresse du dossier."
  $GameDir = (Read-Host "Colle le dossier du jeu ici").Trim().Trim('"')
}
if (-not $GameDir -or -not (Test-Path (Join-Path $GameDir 'base.scs'))) {
  throw "Pas de base.scs dans '$GameDir' : ce n'est pas le dossier d'Euro Truck Simulator 2."
}
$plugins = Join-Path $GameDir 'bin\win_x64\plugins'
$target = Join-Path $plugins 'ets2map_telemetry.dll'
# Read by the plugin: where ETS2 Map is, to start it with the game.
$homeFile = Join-Path $plugins 'ets2map_home.txt'

if ($Uninstall) {
  if (Test-Path $homeFile) { Remove-Item $homeFile -Force }
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
[IO.File]::WriteAllText($homeFile, $root)
"Plugin installé : $target"
"ETS2 Map se lance maintenant tout seul avec le jeu (fenêtre réduite) et se ferme avec lui."
"Au prochain lancement, ETS2 affiche un message sur les fonctions SDK avancées : clique OK."
