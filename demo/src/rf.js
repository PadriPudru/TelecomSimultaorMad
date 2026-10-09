// Motor de propagación SIMPLIFICADO para la demo (no es física rigurosa):
// pérdidas log-distancia + diagrama sectorial + penalización por edificios atravesados.
import { N, CELL, HALF, raycast } from './city.js';

export const COVER_THRESHOLD = -105; // dBm
const NOISE_RE = -125; // dBm por subportadora (15 kHz, NF 7 dB)
const RX_H = 1.5;

export const BANDS = {
  low: { key: 'low', label: '700 MHz', short: '700M', f: 700e6, n: 2.55, wall: 7, cap: 20, eirp: 64, color: 0xa78bfa, css: '#a78bfa', range: 620, refl: 0.62 },
  mid: { key: 'mid', label: '3,5 GHz', short: '3.5G', f: 3.5e9, n: 2.8, wall: 12, cap: 25, eirp: 70, color: 0x22d3ee, css: '#22d3ee', range: 420, refl: 0.55 },
  mmw: { key: 'mmw', label: '26 GHz', short: '26G', f: 26e9, n: 3.0, wall: 30, cap: 45, eirp: 76, color: 0xfbbf24, css: '#fbbf24', range: 200, refl: 0.42 },
};

// Mapa de RSRP (dBm) de una antena. k = submuestreo de la rejilla (1 = completa).
export function antennaMap(city, ant, band, k = 1) {
  const n = Math.floor(N / k);
  const out = new Float32Array(n * n);
  const H = city.H;
  const base = band.eirp - 35 - 20 * Math.log10((4 * Math.PI * band.f) / 3e8);
  const step = CELL * 2.2;
  for (let j = 0; j < n; j++) {
    const gj = Math.min(N - 1, j * k + (k >> 1));
    const z = -HALF + (gj + 0.5) * CELL;
    for (let i = 0; i < n; i++) {
      const gi = Math.min(N - 1, i * k + (k >> 1));
      const x = -HALF + (gi + 0.5) * CELL;
      const dx = x - ant.x, dz = z - ant.z, dy = ant.y - RX_H;
      const d2 = Math.hypot(dx, dz);
      const d3 = Math.max(Math.hypot(d2, dy), 3);
      let rs = base - 10 * band.n * Math.log10(d3);

      // Diagrama horizontal: 3 sectores a az, az+120, az+240.
      const bearing = (Math.atan2(dx, -dz) * 180) / Math.PI;
      let diff = 180;
      for (let s = 0; s < 3; s++) {
        const dd = Math.abs((((bearing - ant.az - 120 * s) % 360) + 540) % 360 - 180);
        if (dd < diff) diff = dd;
      }
      rs -= Math.min(12 * (diff / 65) ** 2, 22);
      // Diagrama vertical con 6º de downtilt.
      const el = (Math.atan2(dy, d2) * 180) / Math.PI;
      rs -= Math.min(12 * ((el - 6) / 12) ** 2, 16);

      if (rs < -145) { out[j * n + i] = -160; continue; }

      // Obstrucción: cuántos edificios corta la línea antena → receptor.
      const steps = Math.max(1, Math.ceil(d2 / step));
      let entries = 0, inside = false;
      for (let s = 1; s < steps; s++) {
        const t = s / steps;
        const ci = Math.floor((ant.x + dx * t + HALF) / CELL);
        const cj = Math.floor((ant.z + dz * t + HALF) / CELL);
        const h = H[cj * N + ci];
        if (h > ant.y - dy * t) { if (!inside) { entries++; inside = true; } }
        else inside = false;
      }
      if (H[gj * N + gi] > 0 && !inside) entries++; // receptor en interior
      rs -= Math.min(entries * band.wall, band.cap) + (entries ? 4 : 0);
      out[j * n + i] = rs + city.noise[gj * N + gi];
    }
  }
  return out;
}

// Combina los mapas: mejor servidor, RSRP y SINR por celda.
export function combine(maps, n = N, load = 0.6) {
  const rsrp = new Float32Array(n * n).fill(-160);
  const sinr = new Float32Array(n * n).fill(-20);
  const best = new Int16Array(n * n).fill(-1);
  const noise = 10 ** (NOISE_RE / 10);
  for (let c = 0; c < n * n; c++) {
    let S = -160, b = -1, sum = 0;
    for (let m = 0; m < maps.length; m++) {
      const v = maps[m][c];
      sum += 10 ** (v / 10);
      if (v > S) { S = v; b = m; }
    }
    rsrp[c] = S; best[c] = b;
    if (b >= 0) {
      const I = (sum - 10 ** (S / 10)) * load;
      sinr[c] = Math.max(-20, Math.min(40, S - 10 * Math.log10(I + noise)));
    }
  }
  return { rsrp, sinr, best };
}

// Rayos con rebotes especulares sobre edificios y suelo (solo para visualizar).
export function traceRays(city, ant, band, count, rnd) {
  const pos = [], dist = [], pw = [];
  const maxLen = band.range * 1.8;
  for (let r = 0; r < count; r++) {
    const az = (r / count) * Math.PI * 2 + rnd() * 0.1;
    const el = -(0.03 + rnd() * 0.42);
    let dx = Math.sin(az) * Math.cos(el), dz = -Math.cos(az) * Math.cos(el), dy = Math.sin(el);
    let ox = ant.x, oy = ant.y, oz = ant.z, travelled = 0, p = 1;
    for (let b = 0; b <= 4; b++) {
      const remain = maxLen - travelled;
      if (remain <= 1) break;
      const h = raycast(city, ox, oy, oz, dx, dy, dz, remain);
      // Los rayos que escapan hacia el cielo se recortan para no ensuciar la vista.
      const t = h ? h.t : Math.min(remain, dy > 0 ? Math.min(60, (220 - oy) / dy) : remain);
      const ex = ox + dx * t, ey = oy + dy * t, ez = oz + dz * t;
      pos.push(ox, oy, oz, ex, ey, ez);
      dist.push(travelled, travelled + t);
      pw.push(p, p);
      travelled += t;
      if (!h) break;
      const dn = dx * h.nx + dy * h.ny + dz * h.nz;
      dx -= 2 * dn * h.nx; dy -= 2 * dn * h.ny; dz -= 2 * dn * h.nz;
      ox = ex + h.nx * 0.05; oy = ey + h.ny * 0.05; oz = ez + h.nz * 0.05;
      p *= band.refl;
    }
  }
  return { pos, dist, pw, maxLen };
}

// Búsqueda voraz de la azotea que más cobertura añade (rejilla gruesa).
export function optimizePlacement(city, antennas, band, rnd) {
  const k = 4, n = Math.floor(N / k);
  const best = new Float32Array(n * n).fill(-160);
  for (const a of antennas) {
    const m = antennaMap(city, a, band, k);
    for (let c = 0; c < n * n; c++) if (m[c] > best[c]) best[c] = m[c];
  }
  const outdoor = [];
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const gj = Math.min(N - 1, j * k + (k >> 1)), gi = Math.min(N - 1, i * k + (k >> 1));
    if (city.H[gj * N + gi] === 0) outdoor.push(j * n + i);
  }
  const covered = (arr) => outdoor.reduce((s, c) => s + (arr(c) >= COVER_THRESHOLD ? 1 : 0), 0);
  const before = covered((c) => best[c]);

  const pool = city.B.filter((b) => {
    const cx = (b.x0 + b.x1) / 2, cz = (b.z0 + b.z1) / 2;
    return b.h > 16 && Math.abs(cx) < HALF - 60 && Math.abs(cz) < HALF - 60 &&
      antennas.every((a) => Math.hypot(a.x - cx, a.z - cz) > 150);
  });
  let winner = null;
  for (let t = 0; t < 70 && pool.length; t++) {
    const b = pool.splice(Math.floor(rnd() * pool.length), 1)[0];
    const cand = { x: (b.x0 + b.x1) / 2, z: (b.z0 + b.z1) / 2, roofH: b.h, y: b.h + 7, az: Math.round(rnd() * 119) };
    const m = antennaMap(city, cand, band, k);
    const score = covered((c) => Math.max(best[c], m[c]));
    if (!winner || score > winner.score) winner = { ...cand, score };
  }
  if (!winner) return null;
  return { ...winner, before: (before / outdoor.length) * 100, after: (winner.score / outdoor.length) * 100 };
}

// Paletas de color de los mapas.
const STOPS = {
  rsrp: [
    [-125, [40, 10, 60, 0]], [-115, [150, 30, 80, 140]], [-105, [235, 95, 50, 175]],
    [-95, [245, 205, 60, 190]], [-85, [90, 220, 120, 200]], [-75, [40, 200, 235, 210]],
    [-65, [120, 170, 255, 215]], [-55, [225, 235, 255, 225]],
  ],
  sinr: [
    [-10, [40, 10, 60, 0]], [-5, [150, 30, 80, 140]], [0, [235, 95, 50, 175]],
    [5, [245, 205, 60, 190]], [10, [90, 220, 120, 200]], [15, [40, 200, 235, 210]],
    [22, [120, 170, 255, 215]], [30, [225, 235, 255, 225]],
  ],
};

export function metricColor(metric, v, out, o) {
  const s = STOPS[metric];
  if (v <= s[0][0]) { out.set(s[0][1], o); return; }
  for (let i = 1; i < s.length; i++) {
    if (v <= s[i][0]) {
      const [v0, c0] = s[i - 1], [v1, c1] = s[i];
      const t = (v - v0) / (v1 - v0);
      for (let k = 0; k < 4; k++) out[o + k] = c0[k] + (c1[k] - c0[k]) * t;
      return;
    }
  }
  out.set(s[s.length - 1][1], o);
}

export function legendStops(metric) {
  return STOPS[metric];
}
