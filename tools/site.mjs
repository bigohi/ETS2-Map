// Builds the online version of the phone app (static: app + map tiles) into
// dist/site and, with --deploy, publishes it on Vercel (project "ets2-map",
// domain ets.enorme.bid). Live data does not go through Vercel: phones join
// the convoy room directly over MQTT/WebSocket.
//   npm run site            build only
//   npm run site:deploy     build + vercel deploy --prod
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'dist', 'site');
const MAP = path.join(ROOT, 'data', 'map');
const PROJECT = 'ets2-map';

if (!fs.existsSync(path.join(MAP, 'meta.json'))) {
  console.error('No map data: run "npm run map" first.');
  process.exit(1);
}

// Fresh build, but keep the Vercel project link.
fs.mkdirSync(OUT, { recursive: true });
for (const f of fs.readdirSync(OUT)) if (f !== '.vercel') fs.rmSync(path.join(OUT, f), { recursive: true, force: true });

fs.cpSync(path.join(ROOT, 'web'), OUT, { recursive: true });
// Plain JSON only: Vercel compresses on the fly. No road graph (it stays on the PCs).
fs.cpSync(MAP, path.join(OUT, 'map'), {
  recursive: true,
  filter: (s) => fs.statSync(s).isDirectory() || (!s.endsWith('.gz') && !/route\.(bin|json)$/.test(s)),
});
fs.writeFileSync(path.join(OUT, 'vercel.json'), JSON.stringify({
  headers: [
    { source: '/map/meta.json', headers: [{ key: 'Cache-Control', value: 'no-cache' }] },
    // Tile URLs carry ?v=<bake date>: a new bake gets new URLs.
    { source: '/map/(tiles|mid|icons)/(.*)', headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }] },
    { source: '/map/overview.json', headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }] },
    { source: '/(.*)', headers: [{ key: 'X-Robots-Tag', value: 'noindex' }] },
  ],
}, null, 2));

let files = 0, bytes = 0;
const walk = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) { if (f.name !== '.vercel') walk(p); } else { files++; bytes += fs.statSync(p).size; } } };
walk(OUT);
console.log(`Site built: ${files} files, ${(bytes / 1048576).toFixed(1)} MB -> ${OUT}`);

if (process.argv.includes('--deploy')) {
  const vercel = (args) => {
    const r = spawnSync('vercel', args, { cwd: OUT, stdio: 'inherit', shell: true });
    if (r.status !== 0) { console.error(`vercel ${args.join(' ')} failed`); process.exit(r.status ?? 1); }
  };
  if (!fs.existsSync(path.join(OUT, '.vercel', 'project.json'))) {
    spawnSync('vercel', ['project', 'add', PROJECT], { cwd: OUT, stdio: 'inherit', shell: true }); // ok if it exists
    vercel(['link', '--yes', '--project', PROJECT]);
  }
  vercel(['deploy', '--prod', '--yes']);
}
