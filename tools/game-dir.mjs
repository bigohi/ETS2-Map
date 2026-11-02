// Finds the Euro Truck Simulator 2 install folder from Steam's library list.
// Override with the ETS2_DIR environment variable or --game "<dir>".
import fs from 'node:fs';
import path from 'node:path';

export function findGameDir(argv = process.argv) {
  const i = argv.indexOf('--game');
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  if (process.env.ETS2_DIR) return process.env.ETS2_DIR;

  const steamRoots = [
    'C:\\Program Files (x86)\\Steam',
    'C:\\Program Files\\Steam',
    path.join(process.env.LOCALAPPDATA ?? '', 'Steam'),
  ];
  const libraries = new Set();
  for (const root of steamRoots) {
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

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}`) {
  console.log(findGameDir() ?? 'not found');
}
