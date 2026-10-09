// Generación procedural de una ciudad "estilo Madrid centro".
// Coordenadas en metros: x hacia el este, z hacia el sur, y hacia arriba.

export const SIZE = 1200;
export const HALF = SIZE / 2;
export const CELL = 5;
export const N = SIZE / CELL;

export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const FEATURES = {
  granVia: { ax: -HALF, az: -250, bx: HALF, bz: 130, w: 34 },
  castellana: { x: 330, w: 46 },
  retiro: { x0: -545, z0: 140, x1: -250, z1: 545 },
  pond: { x0: -470, z0: 250, x1: -380, z1: 330 },
  sol: { x: -70, z: -60, r: 48 },
};

function distSeg(px, pz, ax, az, bx, bz) {
  const vx = bx - ax, vz = bz - az;
  const t = Math.max(0, Math.min(1, ((px - ax) * vx + (pz - az) * vz) / (vx * vx + vz * vz)));
  return Math.hypot(ax + vx * t - px, az + vz * t - pz);
}

function excluded(x0, z0, x1, z1) {
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  const r = Math.max(x1 - x0, z1 - z0) / 2;
  if (x0 < -HALF + 4 || x1 > HALF - 4 || z0 < -HALF + 4 || z1 > HALF - 4) return true;
  const g = FEATURES.granVia;
  if (distSeg(cx, cz, g.ax, g.az, g.bx, g.bz) < g.w / 2 + r * 0.75) return true;
  const c = FEATURES.castellana;
  if (x1 > c.x - c.w / 2 && x0 < c.x + c.w / 2) return true;
  const p = FEATURES.retiro;
  if (x1 > p.x0 && x0 < p.x1 && z1 > p.z0 && z0 < p.z1) return true;
  const s = FEATURES.sol;
  if (Math.hypot(cx - s.x, cz - s.z) < s.r + r) return true;
  return false;
}

export function generateCity(seed = 11) {
  const rnd = mulberry32(seed);
  const B = [];
  const block = 88, street = 18, depth = 20;
  const pitch = block + street;

  for (let bx = -HALF; bx < HALF; bx += pitch) {
    for (let bz = -HALF; bz < HALF; bz += pitch) {
      const x0 = bx + street / 2, z0 = bz + street / 2;
      const x1 = x0 + block, z1 = z0 + block;
      // Manzana con patio interior: cuatro franjas perimetrales divididas en parcelas.
      const strips = [
        [x0, z0, x1, z0 + depth, 'x'],
        [x0, z1 - depth, x1, z1, 'x'],
        [x0, z0 + depth, x0 + depth, z1 - depth, 'z'],
        [x1 - depth, z0 + depth, x1, z1 - depth, 'z'],
      ];
      const blockBase = 16 + rnd() * 14;
      for (const [sx0, sz0, sx1, sz1, axis] of strips) {
        let a = axis === 'x' ? sx0 : sz0;
        const end = axis === 'x' ? sx1 : sz1;
        while (a < end - 4) {
          let b = Math.min(end, a + 12 + rnd() * 20);
          if (end - b < 10) b = end;
          const lx0 = axis === 'x' ? a : sx0, lx1 = axis === 'x' ? b : sx1;
          const lz0 = axis === 'x' ? sz0 : a, lz1 = axis === 'x' ? sz1 : b;
          a = b;
          if (excluded(lx0, lz0, lx1, lz1)) continue;
          const cx = (lx0 + lx1) / 2, cz = (lz0 + lz1) / 2;
          let h = blockBase + (rnd() - 0.5) * 8;
          if (cx > 360 && cz < -230 && rnd() < 0.22) h = 70 + rnd() * 100; // zona de torres tipo AZCA
          else if (rnd() < 0.03) h += 15 + rnd() * 20;
          B.push({ x0: lx0, z0: lz0, x1: lx1, z1: lz1, h: Math.max(9, h), seed: rnd() });
        }
      }
    }
  }

  // Rejilla de alturas para el cálculo de obstrucción.
  const H = new Float32Array(N * N);
  for (const b of B) {
    const i0 = Math.max(0, Math.ceil((b.x0 + HALF) / CELL - 0.5));
    const i1 = Math.min(N - 1, Math.floor((b.x1 + HALF) / CELL - 0.5));
    const j0 = Math.max(0, Math.ceil((b.z0 + HALF) / CELL - 0.5));
    const j1 = Math.min(N - 1, Math.floor((b.z1 + HALF) / CELL - 0.5));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const k = j * N + i;
      if (b.h > H[k]) H[k] = b.h;
    }
  }

  // Desvanecimiento lento sintético (±3 dB) para dar textura al mapa.
  const noise = new Float32Array(N * N);
  const waves = Array.from({ length: 6 }, () => ({
    kx: (rnd() - 0.5) * 0.12, kz: (rnd() - 0.5) * 0.12, ph: rnd() * 6.28,
  }));
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    let v = 0;
    for (const w of waves) v += Math.sin(i * w.kx + j * w.kz + w.ph);
    noise[j * N + i] = v * 0.8;
  }

  // Árboles del parque.
  const trees = [];
  const p = FEATURES.retiro, pond = FEATURES.pond;
  while (trees.length < 420) {
    const x = p.x0 + 8 + rnd() * (p.x1 - p.x0 - 16);
    const z = p.z0 + 8 + rnd() * (p.z1 - p.z0 - 16);
    if (x > pond.x0 - 6 && x < pond.x1 + 6 && z > pond.z0 - 6 && z < pond.z1 + 6) continue;
    trees.push({ x, z, s: 3 + rnd() * 3 });
  }

  return { B, H, noise, trees };
}

export function heightAt(city, x, z) {
  const i = Math.floor((x + HALF) / CELL), j = Math.floor((z + HALF) / CELL);
  if (i < 0 || j < 0 || i >= N || j >= N) return 0;
  return city.H[j * N + i];
}

// Intersección rayo / (suelo + cajas de edificios). Devuelve el impacto más cercano.
export function raycast(city, ox, oy, oz, dx, dy, dz, maxT = 1e9) {
  if (Math.abs(dx) < 1e-9) dx = 1e-9;
  if (Math.abs(dy) < 1e-9) dy = 1e-9;
  if (Math.abs(dz) < 1e-9) dz = 1e-9;
  let best = maxT, nx = 0, ny = 0, nz = 0, hit = -1;
  if (dy < 0) {
    const t = -oy / dy;
    if (t > 1e-4 && t < best) { best = t; ny = 1; hit = -2; }
  }
  const ix = 1 / dx, iy = 1 / dy, iz = 1 / dz;
  const B = city.B;
  for (let i = 0; i < B.length; i++) {
    const b = B[i];
    const tx1 = (b.x0 - ox) * ix, tx2 = (b.x1 - ox) * ix;
    const ty1 = -oy * iy, ty2 = (b.h - oy) * iy;
    const tz1 = (b.z0 - oz) * iz, tz2 = (b.z1 - oz) * iz;
    const txn = Math.min(tx1, tx2), tyn = Math.min(ty1, ty2), tzn = Math.min(tz1, tz2);
    const tmin = Math.max(txn, tyn, tzn);
    const tmax = Math.min(Math.max(tx1, tx2), Math.max(ty1, ty2), Math.max(tz1, tz2));
    if (tmin > 1e-4 && tmin <= tmax && tmin < best) {
      best = tmin; hit = i;
      nx = ny = nz = 0;
      if (tmin === txn) nx = dx > 0 ? -1 : 1;
      else if (tmin === tyn) ny = dy > 0 ? -1 : 1;
      else nz = dz > 0 ? -1 : 1;
    }
  }
  return hit === -1 ? null : { t: best, nx, ny, nz, index: hit };
}
