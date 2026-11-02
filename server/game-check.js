// Explains why no truck data arrives from ETS2, and fixes what it can:
// installs the plugin into the game folder that is actually running.

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { findGameDir } from '../tools/game-dir.mjs';

const DLL = 'ets2map_telemetry.dll';

function ps(command) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve('');
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { timeout: 15000, windowsHide: true }, (err, out) => resolve(err ? '' : String(out).trim()));
  });
}

let documentsDir = null;
async function gameLogPath() {
  documentsDir ??= (await ps("[Environment]::GetFolderPath('MyDocuments')")) || path.join(process.env.USERPROFILE ?? '', 'Documents');
  return path.join(documentsDir, 'Euro Truck Simulator 2', 'game.log.txt');
}

/** Folder of the running game (from its .exe), else the one found through Steam. */
async function locate() {
  const out = await ps("$p = Get-Process eurotrucks2 -ErrorAction SilentlyContinue | Select-Object -First 1; if ($p) { $p.Path; [DateTimeOffset]::new($p.StartTime).ToUnixTimeMilliseconds() }");
  const [exe, start] = out ? out.split(/\r?\n/).map((l) => l.trim()) : [];
  const running = !!exe;
  const fromExe = exe ? path.resolve(path.dirname(exe), '..', '..') : null;
  return { running, exe, startMs: Number(start) || 0, gameDir: fromExe && fs.existsSync(path.join(fromExe, 'base.scs')) ? fromExe : findGameDir([]) };
}

function sameFile(a, b) {
  try { return fs.statSync(a).size === fs.statSync(b).size && fs.readFileSync(a).equals(fs.readFileSync(b)); } catch { return false; }
}

/** Copies the plugin next to the game if it is missing or outdated. Returns 'installed' | 'ok' | 'locked' | 'no-game' | 'no-source'. */
export async function ensurePlugin(dllSource) {
  if (!fs.existsSync(dllSource)) return { result: 'no-source' };
  const { gameDir } = await locate();
  if (!gameDir) return { result: 'no-game' };
  const target = path.join(gameDir, 'bin', 'win_x64', 'plugins', DLL);
  if (sameFile(dllSource, target)) return { result: 'ok', target };
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(dllSource, target);
    return { result: 'installed', target };
  } catch {
    return { result: 'locked', target }; // in use by a running game: an older copy is loaded
  }
}

/**
 * Why there is no truck: one of
 *  no-game      ETS2 is not running
 *  no-plugin    running, plugin missing (and could not be installed)
 *  restart      plugin installed after the game started: restart ETS2
 *  not-loaded   plugin present but the game did not load it (see game.log.txt)
 *  menu         data arrives but no truck on the road yet (menus / loading)
 *  no-data      plugin loaded but nothing reaches this window
 */
export async function diagnose({ dllSource, packetsSeen }) {
  const { running, gameDir, startMs } = await locate();
  if (!running) return { why: 'no-game', gameDir };
  if (packetsSeen) return { why: 'menu', gameDir };
  const target = gameDir ? path.join(gameDir, 'bin', 'win_x64', 'plugins', DLL) : null;
  if (!target || !fs.existsSync(target)) {
    const fix = await ensurePlugin(dllSource);
    return { why: fix.result === 'installed' ? 'restart' : 'no-plugin', gameDir, installed: fix.result === 'installed' };
  }
  let log = '';
  try { log = fs.readFileSync(await gameLogPath(), 'latin1'); } catch { /* no log yet */ }
  // The log restarts with each game launch: only the current session counts.
  if (!/loading 'ets2map_telemetry'/i.test(log)) {
    // Copied after the game started: the game only loads plugins at launch.
    return { why: startMs && fs.statSync(target).mtimeMs > startMs ? 'restart' : 'not-loaded', gameDir };
  }
  if (!/\[ets2map\]/.test(log)) return { why: 'not-loaded', gameDir };
  return { why: 'no-data', gameDir };
}

export const WHY_TEXT = {
  'no-game': 'ETS2 n\'est pas lancé.',
  'no-plugin': 'Plugin absent du dossier du jeu : lance « 1 - Installer le plugin » avec ETS2 fermé.',
  restart: 'Plugin installé pendant que le jeu tournait : redémarre ETS2.',
  'not-loaded': 'ETS2 n\'a pas chargé le plugin : redémarre ETS2 et clique OK sur le message « SDK ».',
  menu: 'ETS2 envoie bien ses données : charge ton profil et prends la route.',
  'no-data': 'Plugin chargé mais rien n\'arrive : un autre ETS2 Map tourne déjà ? Ferme les autres fenêtres et relance.',
};
