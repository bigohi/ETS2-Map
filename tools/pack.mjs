// Builds dist/ETS2-Map-Convoi.zip: everything a friend needs to join a convoy,
// without the map tools (map, road graph and plugin are prebuilt).
//   npm run pack
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NAME = 'ETS2-Map-Convoi';
const DIST = path.join(ROOT, 'dist');
const OUT = path.join(DIST, NAME);

const need = ['data/map/meta.json', 'data/map/route.bin', 'plugin/build/ets2map_telemetry.dll'];
for (const f of need) {
  if (!fs.existsSync(path.join(ROOT, f))) {
    console.error(`Missing ${f}: run "npm run map" and "npm run plugin:build" first.`);
    process.exit(1);
  }
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const copy = (rel, filter = () => true) => {
  const src = path.join(ROOT, rel);
  const dst = path.join(OUT, rel);
  fs.cpSync(src, dst, { recursive: true, filter: (s) => fs.statSync(s).isDirectory() || filter(s) });
};

for (const f of ['server/server.js', 'server/route.js', 'server/convoy.js', 'server/convoy-hub.js', 'tools/game-dir.mjs', 'package.json']) copy(f);
copy('web');
copy('node_modules/qrcode-terminal');
copy('plugin/build/ets2map_telemetry.dll');
copy('plugin/install.ps1');
// Map: only the gzip twins (the server inflates them for old browsers),
// plus the files the server itself reads.
copy('data/map', (s) => {
  const base = path.basename(s);
  if (['meta.json', 'route.json', 'route.bin'].includes(base)) return true;
  if (s.includes(`${path.sep}icons${path.sep}`)) return true;
  return s.endsWith('.json.gz');
});

const cmd = (name, body) => fs.writeFileSync(path.join(OUT, name), body.replace(/\n/g, '\r\n'));
const nodeCheck = `where node >nul 2>nul
if errorlevel 1 (
  echo Node.js n'est pas installe. Installation avec winget...
  winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
  echo Ferme cette fenetre et relance ce fichier.
  pause
  exit /b 1
)
`;
cmd('1 - Installer le plugin.cmd', `@echo off
cd /d "%~dp0"
${nodeCheck}powershell -NoProfile -ExecutionPolicy Bypass -File plugin\\install.ps1
pause
`);
cmd('2 - Lancer ETS2 Map.cmd', `@echo off
cd /d "%~dp0"
${nodeCheck}node server\\server.js %*
pause
`);
fs.writeFileSync(path.join(OUT, 'LISEZ-MOI.txt'), `ETS2 Map - convoi
=================

1. Installe Node.js si besoin (le fichier 1 le fait tout seul avec winget).
2. Double-clique "1 - Installer le plugin.cmd" (une seule fois, ETS2 ferme).
3. Double-clique "2 - Lancer ETS2 Map.cmd" et laisse la fenetre ouverte.
4. Sur ton telephone (meme Wi-Fi que le PC), ouvre l'adresse affichee
   (ex. http://192.168.1.20:8080/) ou scanne le QR code.
5. Sur le telephone : bouton "Convoi" (icone 2 personnes), mets ton pseudo
   et le MEME code de convoi que tes potes, puis "Rejoindre".
6. Lance ETS2. Au premier lancement, clique OK sur le message "SDK".

Sur la carte : itineraire en rouge, potes en couleur avec leur pseudo,
leurs itineraires en pointilles. Appui long sur la carte = itineraire vers ce point.

Si Windows demande l'acces reseau pour Node.js : autorise "Reseaux prives".
Desinstaller le plugin : powershell -File plugin\\install.ps1 -Uninstall
`.replace(/\n/g, '\r\n'));

const zip = path.join(DIST, `${NAME}.zip`);
fs.rmSync(zip, { force: true });
// Windows' own bsdtar writes zip files (Git's GNU tar would not).
const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
const r = spawnSync(tar, ['-a', '-c', '-f', zip, '-C', DIST, NAME], { stdio: 'inherit' });
if (r.status !== 0) { console.error('zip failed'); process.exit(1); }
const mb = (fs.statSync(zip).size / 1048576).toFixed(1);
console.log(`${zip} (${mb} MB)`);
