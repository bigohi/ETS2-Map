// Finds the Euro Truck Simulator 2 install folder from Steam's library list.
// Override with the ETS2_DIR environment variable or --game "<dir>".
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

export function findGameDir(argv = process.argv) {
  const i = argv.indexOf('--game');
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  if (process.env.ETS2_DIR) return process.env.ETS2_DIR;

  const steamRoots = [
    steamPathFromRegistry(),
    'C:\\Program Files (x86)\\Steam',
    'C:\\Program Files\\Steam',
    path.join(process.env.LOCALAPPDATA ?? '', 'Steam'),
  ];
  const libraries = new Set();
  for (const root of steamRoots.filter(Boolean)) {
    const vdf = path.join(root, 'steamapps', 'libraryfolders.vdf');
    if (!fs.existsSync(vdf)) continue;
    libraries.add(root);
    for (const m of fs.readFileSync(vdf, 'utf8').matchAll(/"path"\s+"([^"]+)"/g)) {
      libraries.add(m[1].replace(/\\\\/g, '\\'));
    }
  }
  for (const lib of libraries) {
    const dir = path.join(lib, 'steamapps', 'common', 'Euro Truck Simulator 2');
    if (fs.existsSync(path.join(dir, 'base.scs'))) return dir;
  }
  return null;
}

// Steam can be installed anywhere: ask the registry first.
function steamPathFromRegistry() {
  if (process.platform !== 'win32') return null;
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const m = out.match(/SteamPath\s+REG_SZ\s+(.+)/);
    return m ? path.normalize(m[1].trim()) : null;
  } catch {
    return null;
  }
}

// Run directly (works with spaces/accents in the folder path).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(findGameDir() ?? 'not found');
}
