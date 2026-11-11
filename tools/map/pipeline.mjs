// Map pipeline: setup | parse | bake | route | all
//   setup  clone TruckSim Maps (pinned), apply our fixes, npm install, build its native addon
//   parse  read the game's .scs files -> data/parsed/*.json (+ icons)
//   bake   data/parsed -> data/map (tiles for the phone)
//   base   Natural Earth land, lakes, borders -> data/map/base.json (fitted to the game map)
//   route  data/parsed -> data/map/route.* (road graph for GPS routes)
// Re-run "all" after a game update.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findGameDir } from '../game-dir.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const VENDOR = path.join(ROOT, 'vendor', 'trucksim-maps');
const REPO = 'https://github.com/truckermudgeon/maps.git';
const COMMIT = 'd56d0e3fb319230e84284f3029f8bda2c4b572a2';
const TSX = path.join(VENDOR, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const HEAP = '--max-old-space-size=16384';

function run(cmd, args, opts = {}) {
  console.log(`> ${cmd} ${args.join(' ')}`);
  // tsx runs the script in a child process: the heap limit has to travel in the environment.
  const env = { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} ${HEAP}`.trim() };
  const r = spawnSync(cmd, args, { stdio: 'inherit', env, shell: process.platform === 'win32' && !cmd.endsWith('.exe') && cmd !== process.execPath, ...opts });
  if (r.status !== 0) {
    console.error(`failed: ${cmd} (${r.status})`);
    process.exit(r.status ?? 1);
  }
}

function setup() {
  if (!fs.existsSync(path.join(VENDOR, '.git'))) {
    run('git', ['clone', '--recurse-submodules', REPO, VENDOR]);
  }
  run('git', ['-C', VENDOR, 'fetch', '--depth', '1', 'origin', COMMIT], { stdio: 'ignore' });
  run('git', ['-C', VENDOR, 'checkout', '-f', COMMIT]);
  run('git', ['-C', VENDOR, 'submodule', 'update', '--init', '--recursive']);
  run('git', ['-C', VENDOR, 'apply', '--ignore-whitespace', path.join(ROOT, 'tools', 'map', 'trucksim-maps.patch')]);
  run('npm', ['install', '--no-audit', '--no-fund'], { cwd: VENDOR });
  run('npx', ['--yes', 'node-gyp', 'configure'], { cwd: path.join(VENDOR, 'packages', 'clis', 'parser') });
  run('npx', ['--yes', 'node-gyp', 'build'], { cwd: path.join(VENDOR, 'packages', 'clis', 'parser') });
}

function gameDir() {
  const dir = findGameDir();
  if (!dir) {
    console.error('ETS2 folder not found. Pass --game "<folder with base.scs>" or set ETS2_DIR.');
    process.exit(1);
  }
  return dir;
}

function parse() {
  const out = path.join(ROOT, 'data', 'parsed');
  fs.mkdirSync(out, { recursive: true });
  run(process.execPath, [HEAP, TSX, path.join(VENDOR, 'packages', 'clis', 'parser', 'index.ts'), '-i', gameDir(), '-o', out], { cwd: VENDOR });
}

function bake() {
  run(process.execPath, [HEAP, TSX, path.join(ROOT, 'tools', 'map', 'bake.ts'), '--game', gameDir()], { cwd: ROOT });
}

function base() {
  run(process.execPath, [HEAP, TSX, path.join(ROOT, 'tools', 'map', 'bake-base.ts')], { cwd: ROOT });
}

function route() {
  run(process.execPath, [HEAP, TSX, path.join(ROOT, 'tools', 'map', 'bake-route.ts'), '--game', gameDir()], { cwd: ROOT });
}

const step = process.argv[2] ?? 'all';
if (!fs.existsSync(TSX) && step !== 'setup') setup();
if (step === 'setup') setup();
else if (step === 'parse') parse();
else if (step === 'bake') bake();
else if (step === 'route') route();
else if (step === 'base') base();
else if (step === 'all') { parse(); bake(); base(); route(); }
else { console.error('usage: node tools/map/pipeline.mjs setup|parse|bake|base|route|all'); process.exit(1); }
