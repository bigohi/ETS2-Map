// Rasterizes the app icon (same drawing as web/icon.svg) to PNG without deps.
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');

function render(size) {
  const SS = 4, N = size * SS, k = N / 512;
  const px = new Float32Array(N * N * 4);
  const put = (i, r, g, b, a) => { const o = i * 4; px[o] = px[o] * (1 - a) + r * a; px[o + 1] = px[o + 1] * (1 - a) + g * a; px[o + 2] = px[o + 2] * (1 - a) + b * a; px[o + 3] = Math.max(px[o + 3], a); };
  const inRound = (x, y) => { const r = 112, cx = Math.min(Math.max(x, r), 512 - r), cy = Math.min(Math.max(y, r), 512 - r); return (x - cx) ** 2 + (y - cy) ** 2 <= r * r; };
  const segD = (x, y, a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1]; const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy))); return Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy); };
  const road = [[60, 400], [200, 250], [300, 300], [452, 120]];
  const arrow = [[256, 96], [352, 392], [256, 340], [160, 392]];
  const inPoly = (x, y, p) => { let c = false; for (let i = 0, j = p.length - 1; i < p.length; j = i++) { if ((p[i][1] > y) !== (p[j][1] > y) && x < ((p[j][0] - p[i][0]) * (y - p[i][1])) / (p[j][1] - p[i][1]) + p[i][0]) c = !c; } return c; };
  const polyD = (x, y, p) => { let d = Infinity; for (let i = 0; i < p.length; i++) d = Math.min(d, segD(x, y, p[i], p[(i + 1) % p.length])); return d; };
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const x = (i + 0.5) / k, y = (j + 0.5) / k, idx = j * N + i;
    if (!inRound(x, y)) continue;
    put(idx, 27, 31, 36, 1);
    let d = Infinity; for (let s = 0; s < road.length - 1; s++) d = Math.min(d, segD(x, y, road[s], road[s + 1]));
    if (d <= 17) put(idx, 224, 166, 58, 1);
    const inside = inPoly(x, y, arrow), e = polyD(x, y, arrow);
    if (inside || e <= 11) put(idx, 255, 255, 255, 1);
    if (inside && e > 11) put(idx, 63, 169, 255, 1);
  }
  const out = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    out[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const acc = [0, 0, 0, 0];
      for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) { const o = ((y * SS + sy) * N + x * SS + sx) * 4; for (let c = 0; c < 4; c++) acc[c] += px[o + c] * (c === 3 ? 1 : px[o + 3]); }
      const a = acc[3] / (SS * SS);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      out[o] = a ? Math.round(acc[0] / acc[3]) : 0; out[o + 1] = a ? Math.round(acc[1] / acc[3]) : 0; out[o + 2] = a ? Math.round(acc[2] / acc[3]) : 0; out[o + 3] = Math.round(a * 255);
    }
  }
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td)); return Buffer.concat([len, td, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(out)), chunk('IEND', Buffer.alloc(0))]);
}
for (const s of [180, 192, 512]) fs.writeFileSync(path.join(WEB, `icon-${s}.png`), render(s));
console.log('icons written');
