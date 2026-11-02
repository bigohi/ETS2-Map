// Loads the baked map (see tools/map/bake.ts for the format) and turns tiles
// into Path2D buckets ready to stroke/fill. Coordinates stay in quantized game
// units (Q per meter); the renderer folds 1/Q into its transform.

// Road classes, same order as meta.roadClasses.
export const FREEWAY = 0, DIVIDED = 1, LOCAL = 2, NO_VEHICLES = 3, TRAIN = 4, TRAM = 5, UNKNOWN = 6;
// Drawing order: rails and minor first, highways last (on top).
const CLASS_ORDER = [TRAM, TRAIN, UNKNOWN, NO_VEHICLES, LOCAL, DIVIDED, FREEWAY];

const MAX_DETAIL_TILES = 72;
const MAX_PARALLEL = 4;

export class MapStore {
  constructor(base = 'map/') {
    this.base = base;
    this.meta = null;
    this.overview = null;
    this.mid = new Map();
    this.detail = new Map();
    this.pending = new Set();
    this.queue = [];
    this.active = 0;
    this.onTileLoaded = () => {};
    this.version = 0; // bumps whenever map geometry is added
    this.icons = new Map();
  }

  async init() {
    const res = await fetch(this.base + 'meta.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error('meta.json missing');
    this.meta = await res.json();
    this.q = this.meta.q;
    // Tiles are cached hard by the browser; a new bake changes the version.
    this.v = '?v=' + encodeURIComponent(this.meta.bakedAt);
    this.cities = this.meta.cities.map(([name, x, y, rank, capital]) => ({ name, x, y, rank, capital }));
    this.countries = this.meta.countries.map(([name, x, y]) => ({ name, x, y }));
    const ov = await (await fetch(this.base + 'overview.json' + this.v)).json();
    this.overview = decodeTile(ov, this.q, this.meta);
    return this.meta;
  }

  /** Tiles of `level` ('mid' | 'detail') intersecting bbox [minX, minY, maxX, maxY] (meters). */
  tiles(level, bbox) {
    const size = level === 'mid' ? this.meta.midTile : this.meta.tile;
    const index = level === 'mid' ? this.meta.midTiles : this.meta.tiles;
    const cache = level === 'mid' ? this.mid : this.detail;
    const out = [];
    const x0 = Math.floor(bbox[0] / size), x1 = Math.floor(bbox[2] / size);
    const y0 = Math.floor(bbox[1] / size), y1 = Math.floor(bbox[3] / size);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 400) return out; // view far too wide for this level
    const now = performance.now();
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        const key = `${tx}_${ty}`;
        if (!(key in index)) continue;
        const t = cache.get(key);
        if (t) { t.used = now; out.push(t); }
        else this.request(level, key);
      }
    }
    return out;
  }

  /** True when every tile of the level inside bbox is loaded. */
  ready(level, bbox) {
    const size = level === 'mid' ? this.meta.midTile : this.meta.tile;
    const index = level === 'mid' ? this.meta.midTiles : this.meta.tiles;
    const cache = level === 'mid' ? this.mid : this.detail;
    for (let ty = Math.floor(bbox[1] / size); ty <= Math.floor(bbox[3] / size); ty++)
      for (let tx = Math.floor(bbox[0] / size); tx <= Math.floor(bbox[2] / size); tx++) {
        const key = `${tx}_${ty}`;
        if (key in index && !cache.has(key)) return false;
      }
    return true;
  }

  request(level, key) {
    const id = `${level}:${key}`;
    if (this.pending.has(id)) return;
    this.pending.add(id);
    this.queue.push({ level, key, id });
    this.pump();
  }

  pump() {
    while (this.active < MAX_PARALLEL && this.queue.length) {
      const job = this.queue.pop(); // newest first: that's where the view is now
      this.active++;
      const dir = job.level === 'mid' ? 'mid/' : 'tiles/';
      fetch(`${this.base}${dir}${job.key}.json${this.v}`)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status))))
        .then((json) => {
          const tile = decodeTile(json, this.q, this.meta);
          tile.used = performance.now();
          (job.level === 'mid' ? this.mid : this.detail).set(job.key, tile);
          this.version++;
          this.evict();
          this.onTileLoaded();
        })
        .catch(() => {})
        .finally(() => {
          this.active--;
          // Allow a retry later if it failed.
          setTimeout(() => this.pending.delete(job.id), this.detail.has(job.key) || this.mid.has(job.key) ? 0 : 3000);
          this.pump();
        });
    }
  }

  evict() {
    if (this.detail.size <= MAX_DETAIL_TILES) return;
    const sorted = [...this.detail.entries()].sort((a, b) => a[1].used - b[1].used);
    for (let i = 0; i < sorted.length - MAX_DETAIL_TILES; i++) this.detail.delete(sorted[i][0]);
  }

  icon(name) {
    let img = this.icons.get(name);
    if (!img) {
      img = new Image();
      img.decoding = 'async';
      img.src = `${this.base}icons/${encodeURIComponent(name)}.png${this.v}`;
      img.onload = () => this.onTileLoaded();
      this.icons.set(name, img);
    }
    return img.complete && img.naturalWidth ? img : null;
  }

  /** Where a job's company is: [x, y] meters or null. Falls back to the city center. */
  companyPos(cityToken, companyToken, near) {
    const list = this.meta?.companies?.[cityToken]?.[companyToken];
    if (list && list.length) {
      if (list.length === 1 || !near) return list[0];
      let best = list[0], bd = Infinity;
      for (const p of list) {
        const d = (p[0] - near[0]) ** 2 + (p[1] - near[1]) ** 2;
        if (d < bd) { bd = d; best = p; }
      }
      return best;
    }
    return this.meta?.cityPos?.[cityToken] ?? null;
  }
}

function decodeTile(json, q, meta) {
  const tile = { roads: [], areas: [], ferries: [], pois: [] };

  if (json.roads) {
    const buckets = new Map();
    for (const r of json.roads) {
      const cls = r[0], w = r[1];
      const key = cls * 10000 + w;
      let b = buckets.get(key);
      if (!b) buckets.set(key, (b = { cls, w, path: new Path2D() }));
      addLine(b.path, r, 2, false);
    }
    tile.roads = [...buckets.values()].sort((a, b) => CLASS_ORDER.indexOf(a.cls) - CLASS_ORDER.indexOf(b.cls) || a.w - b.w);
  }

  if (json.areas) {
    // Already sorted by (zIndex, prefab) at bake time; group consecutive runs by color.
    let cur = null;
    for (const a of json.areas) {
      const layer = a[1] * 2 + a[2];
      if (!cur || cur.layer !== layer || cur.color !== a[0]) {
        // Merge with an existing bucket of the same layer+color if it is the latest of that layer.
        const existing = tile.areas.find((b) => b.layer === layer && b.color === a[0]);
        cur = existing ?? { layer, color: a[0], path: new Path2D() };
        if (!existing) tile.areas.push(cur);
      }
      addLine(cur.path, a, 3, true);
    }
    tile.areas.sort((a, b) => a.layer - b.layer);
  }

  if (json.ferries) {
    const paths = [new Path2D(), new Path2D()];
    for (const f of json.ferries) addLine(paths[f[0]] ?? paths[0], f, 1, false);
    tile.ferries = paths;
  }

  if (json.pois && meta) {
    for (const p of json.pois) {
      tile.pois.push({ icon: meta.poiIcons[p[0]], type: meta.poiTypes[p[1]], x: p[2] / q, y: p[3] / q, label: p[4] });
    }
  }
  return tile;
}

function addLine(path, arr, start, close) {
  let x = arr[start], y = arr[start + 1];
  path.moveTo(x, y);
  for (let i = start + 2; i < arr.length; i += 2) {
    x += arr[i];
    y += arr[i + 1];
    path.lineTo(x, y);
  }
  if (close) path.closePath();
}
