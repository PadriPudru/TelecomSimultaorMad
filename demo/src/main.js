import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { generateCity, raycast, heightAt, mulberry32, HALF, SIZE, N, CELL, FEATURES } from './city.js';
import { BANDS, antennaMap, combine, traceRays, metricColor, legendStops, optimizePlacement, COVER_THRESHOLD } from './rf.js';

const $ = (s) => document.querySelector(s);
const fmt = (v, d = 1) => v.toFixed(d).replace('.', ',');
const ease = (k) => (k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2);

const city = generateCity(11);
const rnd = mulberry32(99);

const state = {
  band: BANDS.mid,
  metric: 'rsrp',
  layers: { coverage: true, waves: true, rays: true, ghost: false },
  antennas: [],
  selected: null,
  placing: false,
  playing: true,
  simMin: 14 * 60,
  alerts: [],
  result: null,
  kpi: null,
  traffic: [],
};

// ---------------------------------------------------------------- Escena
const canvas = $('#scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;

const scene = new THREE.Scene();
const BG = new THREE.Color('#05080f');
scene.background = BG;
scene.fog = new THREE.Fog(BG, 1300, 3200);

const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 1, 9000);
const HOME = { pos: new THREE.Vector3(860, 760, 1020), target: new THREE.Vector3(0, 0, 30) };
camera.position.copy(HOME.pos);
const controls = new OrbitControls(camera, canvas);
controls.target.copy(HOME.target);
controls.enableDamping = true;
controls.maxPolarAngle = 1.42;
controls.minDistance = 60;
controls.maxDistance = 2800;
controls.autoRotate = true;
controls.autoRotateSpeed = 0.22;
controls.addEventListener('start', () => { controls.autoRotate = false; fly = null; });

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.6, 0.5, 0.78);
composer.addPass(bloom);
composer.addPass(new OutputPass());

scene.add(new THREE.HemisphereLight(0x9fb6ff, 0x0a0d14, 0.9));
const sun = new THREE.DirectionalLight(0xffffff, 1.0);
sun.position.set(400, 800, 300);
scene.add(sun);

// Suelo, retícula, parque y estanque
const ground = new THREE.Mesh(new THREE.PlaneGeometry(6000, 6000), new THREE.MeshStandardMaterial({ color: 0x0a0f19, roughness: 1 }));
ground.rotation.x = -Math.PI / 2;
scene.add(ground);
const grid = new THREE.GridHelper(SIZE, 48, 0x1c2c48, 0x101a2c);
grid.position.y = 0.05;
scene.add(grid);

function flatRect(r, color, y) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(r.x1 - r.x0, r.z1 - r.z0), new THREE.MeshStandardMaterial({ color, roughness: 0.9 }));
  m.rotation.x = -Math.PI / 2;
  m.position.set((r.x0 + r.x1) / 2, y, (r.z0 + r.z1) / 2);
  scene.add(m);
  return m;
}
flatRect(FEATURES.retiro, 0x0c2016, 0.1);
flatRect(FEATURES.pond, 0x0b2442, 0.15).material.metalness = 0.6;

const treeMesh = new THREE.InstancedMesh(
  new THREE.SphereGeometry(1, 8, 6),
  new THREE.MeshStandardMaterial({ color: 0x14402a, emissive: 0x06180e, roughness: 0.8 }),
  city.trees.length,
);
{
  const m = new THREE.Matrix4();
  city.trees.forEach((t, i) => {
    m.compose(new THREE.Vector3(t.x, t.s * 1.3, t.z), new THREE.Quaternion(), new THREE.Vector3(t.s, t.s * 1.2, t.s));
    treeMesh.setMatrixAt(i, m);
  });
}
scene.add(treeMesh);

// Límite del área modelada
{
  const pts = [[-HALF, -HALF], [HALF, -HALF], [HALF, HALF], [-HALF, HALF], [-HALF, -HALF]].map(([x, z]) => new THREE.Vector3(x, 0.4, z));
  scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0x22d3ee, transparent: true, opacity: 0.35 })));
}

// ---------------------------------------------------------------- Edificios
const boxGeo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
const bMat = new THREE.ShaderMaterial({
  uniforms: { uGrow: { value: 0 }, uOpacity: { value: 1 }, uFog: { value: BG } },
  vertexShader: /* glsl */ `
    attribute float aSeed; attribute float aH;
    uniform float uGrow;
    varying vec3 vW; varying vec3 vN; varying float vSeed; varying float vH; varying float vDist;
    void main() {
      vec3 p = position; p.y *= uGrow;
      vec4 wp = modelMatrix * instanceMatrix * vec4(p, 1.0);
      vW = wp.xyz; vN = normalize(mat3(modelMatrix * instanceMatrix) * normal);
      vSeed = aSeed; vH = aH * uGrow;
      vec4 mv = viewMatrix * wp; vDist = -mv.z;
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: /* glsl */ `
    uniform float uOpacity; uniform vec3 uFog;
    varying vec3 vW; varying vec3 vN; varying float vSeed; varying float vH; varying float vDist;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    void main() {
      vec3 n = normalize(vN);
      float light = 0.55 + 0.45 * max(dot(n, normalize(vec3(0.4, 0.8, 0.3))), 0.0);
      vec3 col = vec3(0.06, 0.075, 0.11) * light;
      if (n.y > 0.5) {
        col = vec3(0.07, 0.085, 0.12);
      } else {
        float along = abs(n.x) > 0.5 ? vW.z : vW.x;
        vec2 g = vec2(along / 3.6, vW.y / 3.3);
        vec2 c = floor(g), f = fract(g);
        float win = step(0.22, f.x) * step(f.x, 0.78) * step(0.28, f.y) * step(f.y, 0.82);
        float lit = step(0.64, hash(c + vSeed * 17.3));
        float above = step(4.0, vW.y) * step(vW.y, vH - 1.5);
        vec3 wc = mix(vec3(1.0, 0.72, 0.42), vec3(0.62, 0.8, 1.0), hash(c * 1.7 + vSeed));
        col += win * above * (lit * wc * 0.55 + (1.0 - lit) * vec3(0.02, 0.03, 0.05));
        col += smoothstep(vH - 0.8, vH, vW.y) * vec3(0.12, 0.3, 0.55);
      }
      col = mix(col, uFog, smoothstep(1300.0, 3200.0, vDist));
      gl_FragColor = vec4(col, uOpacity);
    }`,
});
const bMesh = new THREE.InstancedMesh(boxGeo, bMat, city.B.length);
{
  const m = new THREE.Matrix4();
  const seeds = new Float32Array(city.B.length), hs = new Float32Array(city.B.length);
  city.B.forEach((b, i) => {
    m.compose(new THREE.Vector3((b.x0 + b.x1) / 2, 0, (b.z0 + b.z1) / 2), new THREE.Quaternion(), new THREE.Vector3(b.x1 - b.x0, b.h, b.z1 - b.z0));
    bMesh.setMatrixAt(i, m);
    seeds[i] = b.seed; hs[i] = b.h;
  });
  boxGeo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 1));
  boxGeo.setAttribute('aH', new THREE.InstancedBufferAttribute(hs, 1));
}
bMesh.renderOrder = 1;
scene.add(bMesh);
let grow = 0;

function setGhost(on) {
  bMat.transparent = on;
  bMat.depthWrite = !on;
  bMat.uniforms.uOpacity.value = on ? 0.16 : 1;
  bMat.needsUpdate = true;
}

// ---------------------------------------------------------------- Mapa de calor
const heatData = new Uint8Array(N * N * 4);
const heatTex = new THREE.DataTexture(heatData, N, N);
heatTex.magFilter = THREE.LinearFilter;
heatTex.minFilter = THREE.LinearFilter;
heatTex.colorSpace = THREE.SRGBColorSpace;
const heat = new THREE.Mesh(
  new THREE.PlaneGeometry(SIZE, SIZE),
  new THREE.MeshBasicMaterial({ map: heatTex, transparent: true, depthWrite: false, opacity: 0.88 }),
);
heat.rotation.x = -Math.PI / 2;
heat.position.y = 0.3;
scene.add(heat);

function blur(src) {
  let a = src, b = new Float32Array(N * N);
  for (let pass = 0; pass < 2; pass++) {
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      let s = 0, c = 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const x = i + di, y = j + dj;
        if (x < 0 || y < 0 || x >= N || y >= N) continue;
        s += a[y * N + x]; c++;
      }
      b[j * N + i] = s / c;
    }
    [a, b] = [b, a === src ? new Float32Array(N * N) : a];
  }
  return a;
}

function paintHeat() {
  if (!state.result) return;
  const src = blur(state.metric === 'rsrp' ? state.result.rsrp : state.result.sinr);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    metricColor(state.metric, src[j * N + i], heatData, ((N - 1 - j) * N + i) * 4);
  }
  heatTex.needsUpdate = true;
  renderLegend();
}

// ---------------------------------------------------------------- Antenas
const shellGeo = new THREE.SphereGeometry(1, 48, 24);
const shellMat = new THREE.ShaderMaterial({
  uniforms: { uColor: { value: new THREE.Color() }, uAlpha: { value: 0 } },
  vertexShader: /* glsl */ `
    varying vec3 vN; varying vec3 vV;
    void main() {
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vN = normalize(mat3(modelMatrix) * normal);
      vV = normalize(cameraPosition - wp.xyz);
      gl_Position = projectionMatrix * viewMatrix * wp;
    }`,
  fragmentShader: /* glsl */ `
    uniform vec3 uColor; uniform float uAlpha;
    varying vec3 vN; varying vec3 vV;
    void main() {
      float f = pow(1.0 - abs(dot(vN, vV)), 2.2);
      gl_FragColor = vec4(uColor, (f * 0.9 + 0.04) * uAlpha);
    }`,
  transparent: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
});

const STATUS_COLOR = { ok: 0x34d399, warn: 0xfbbf24, down: 0xef4444 };
const haloTex = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)');
  gr.addColorStop(0.25, 'rgba(255,255,255,0.45)');
  gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
})();

function makeAntennaMesh() {
  const g = new THREE.Group();
  const metal = new THREE.MeshStandardMaterial({ color: 0x8a9ab5, metalness: 0.7, roughness: 0.35 });
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.7, 9, 8), metal);
  mast.position.y = 4.5;
  g.add(mast);
  for (let k = 0; k < 3; k++) {
    const b = (k * 2 * Math.PI) / 3;
    const p = new THREE.Mesh(new THREE.BoxGeometry(1.7, 3.2, 0.5), new THREE.MeshStandardMaterial({ color: 0xdfe6f2, roughness: 0.5 }));
    p.position.set(Math.sin(b) * 1.3, 7.2, -Math.cos(b) * 1.3);
    p.rotation.y = -b;
    g.add(p);
  }
  const tip = new THREE.Mesh(new THREE.SphereGeometry(1.1, 16, 12), new THREE.MeshBasicMaterial({ color: STATUS_COLOR.ok }));
  tip.position.y = 10;
  g.add(tip);
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: haloTex, color: STATUS_COLOR.ok, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  halo.position.y = 10;
  halo.scale.setScalar(16);
  g.add(halo);
  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(0.5, 0.5, 120, 8, 1, true),
    new THREE.MeshBasicMaterial({ color: STATUS_COLOR.ok, transparent: true, opacity: 0.1, depthWrite: false, blending: THREE.AdditiveBlending }),
  );
  beam.position.y = 70;
  g.add(beam);
  g.userData = { tip, halo, beam };
  return g;
}

let antSeq = 1;
function addAntenna({ x, z, roofH, az = Math.round(rnd() * 119), ai = false }, drop = true) {
  const id = antSeq++;
  const a = {
    id, ai, x, z, roofH, y: roofH + 7, az,
    name: `MAD-${String(id).padStart(3, '0')}`,
    status: 'ok',
    health: { temp: 36 + rnd() * 8, vswr: 1.12 + rnd() * 0.15, load: 30 + rnd() * 40, pwr: 39.5 + rnd() },
    drop: drop ? 1 : 0,
  };
  a.group = makeAntennaMesh();
  a.group.position.set(x, roofH, z);
  a.group.rotation.y = -THREE.MathUtils.degToRad(az);
  scene.add(a.group);
  a.shells = [0, 1, 2].map(() => {
    const m = new THREE.Mesh(shellGeo, shellMat.clone());
    m.position.set(x, a.y, z);
    m.renderOrder = 2;
    scene.add(m);
    return m;
  });
  a.label = document.createElement('div');
  a.label.className = 'label';
  a.label.onclick = () => select(a, true);
  $('#labels').append(a.label);
  state.antennas.push(a);
  setStatus(a, 'ok');
  return a;
}

function removeAntenna(a) {
  scene.remove(a.group);
  a.shells.forEach((s) => scene.remove(s));
  a.label.remove();
  state.antennas = state.antennas.filter((x) => x !== a);
  state.alerts = state.alerts.filter((al) => al.ant !== a);
  if (state.selected === a) select(null);
  renderAlerts();
}

function setStatus(a, s) {
  a.status = s;
  const c = STATUS_COLOR[s];
  const { tip, halo, beam } = a.group.userData;
  tip.material.color.setHex(c);
  halo.material.color.setHex(c);
  beam.material.color.setHex(c);
  beam.material.opacity = s === 'ok' ? 0.08 : 0.22;
  updateLabel(a);
}

function updateLabel(a) {
  const st = a.status === 'down' ? 'CAÍDA' : `${Math.round(a.health.load)}%`;
  a.label.className = `label ${a.status}${state.selected === a ? ' sel' : ''}`;
  a.label.innerHTML = `<span class="dot ${a.status}"></span>${a.name}${a.ai ? ' <span class="ai">IA</span>' : ''}<em>${state.band.short} · ${st}</em>`;
}

function roofAt(x, z) {
  for (const b of city.B) if (x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1) return b;
  return null;
}

// Antenas iniciales sobre las azoteas más cercanas a puntos de interés.
[[-70, -130], [230, -300], [-330, -330], [180, 220], [-130, 110], [460, -460], [450, 330], [-470, -60]].forEach(([tx, tz]) => {
  let best = null, bd = 1e9;
  for (const b of city.B) {
    if (b.h < 18) continue;
    const d = Math.hypot((b.x0 + b.x1) / 2 - tx, (b.z0 + b.z1) / 2 - tz);
    if (d < bd) { bd = d; best = b; }
  }
  const a = addAntenna({ x: (best.x0 + best.x1) / 2, z: (best.z0 + best.z1) / 2, roofH: best.h }, false);
  a.group.visible = false;
  a.drop = 1;
});

// ---------------------------------------------------------------- Rayos
const rayMat = new THREE.ShaderMaterial({
  uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color(state.band.color) }, uMax: { value: 600 } },
  vertexShader: /* glsl */ `
    attribute float aDist; attribute float aPow;
    varying float vDist; varying float vPow;
    void main() { vDist = aDist; vPow = aPow; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform float uTime; uniform vec3 uColor; uniform float uMax;
    varying float vDist; varying float vPow;
    void main() {
      float ph = fract(vDist / 90.0 - uTime * 0.6);
      float pulse = smoothstep(0.0, 0.04, ph) * (1.0 - smoothstep(0.04, 0.3, ph));
      float fade = 1.0 - clamp(vDist / uMax, 0.0, 1.0);
      gl_FragColor = vec4(mix(uColor, vec3(1.0), pulse * 0.5), (0.08 + pulse * 0.9) * vPow * fade);
    }`,
  transparent: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
});
const rays = new THREE.LineSegments(new THREE.BufferGeometry(), rayMat);
rays.renderOrder = 3;
scene.add(rays);

function rebuildRays() {
  const pos = [], dist = [], pw = [];
  let maxLen = 600;
  const rr = mulberry32(5);
  for (const a of state.antennas) {
    if (a.status === 'down') continue;
    const r = traceRays(city, a, state.band, a === state.selected ? 110 : 48, rr);
    pos.push(...r.pos); dist.push(...r.dist); pw.push(...r.pw);
    maxLen = r.maxLen;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aDist', new THREE.Float32BufferAttribute(dist, 1));
  g.setAttribute('aPow', new THREE.Float32BufferAttribute(pw, 1));
  rays.geometry.dispose();
  rays.geometry = g;
  rayMat.uniforms.uMax.value = maxLen;
  rayMat.uniforms.uColor.value.setHex(state.band.color);
}

// ---------------------------------------------------------------- Cálculo RF
const mapCache = new Map();
function mapFor(a) {
  const key = `${a.id}|${state.band.key}|${a.az}`;
  if (!mapCache.has(key)) mapCache.set(key, antennaMap(city, a, state.band));
  return mapCache.get(key);
}

// Agrupa peticiones seguidas en un único recálculo.
let busyTimer = null;
let waiting = [];
function refresh() {
  $('#busy').classList.add('on');
  clearTimeout(busyTimer);
  return new Promise((resolve) => {
    waiting.push(resolve);
    busyTimer = setTimeout(() => {
      const active = state.antennas.filter((a) => a.status !== 'down');
      state.activeList = active;
      state.result = combine(active.map(mapFor));
      paintHeat();
      updateKPIs();
      rebuildRays();
      $('#busy').classList.remove('on');
      waiting.forEach((r) => r());
      waiting = [];
    }, 40);
  });
}

function computeKPIs() {
  const r = state.result;
  let out = 0, cov = 0, s = 0, si = 0;
  for (let c = 0; c < N * N; c++) {
    if (city.H[c] > 0) continue;
    out++;
    s += Math.max(r.rsrp[c], -140);
    if (r.rsrp[c] >= COVER_THRESHOLD) { cov++; si += r.sinr[c]; }
  }
  return { cov: (cov / out) * 100, rsrp: s / out, sinr: cov ? si / cov : 0 };
}

function updateKPIs() {
  const k = computeKPIs();
  const prev = state.kpi;
  state.kpi = k;
  $('#kCov').textContent = `${fmt(k.cov)}%`;
  $('#kRsrp').textContent = `${Math.round(k.rsrp)}`;
  $('#kSinr').textContent = `${fmt(k.sinr)} dB`;
  const active = state.antennas.filter((a) => a.status !== 'down').length;
  $('#kAnt').textContent = `${active}/${state.antennas.length}`;
  const d = $('#kCovD');
  if (prev && Math.abs(k.cov - prev.cov) > 0.05) {
    d.textContent = `${k.cov > prev.cov ? '▲' : '▼'} ${fmt(Math.abs(k.cov - prev.cov))}`;
    d.className = k.cov > prev.cov ? 'up' : 'down';
  }
  return prev;
}

function renderLegend() {
  const st = legendStops(state.metric);
  const lo = st[0][0], hi = st[st.length - 1][0];
  const grad = st.map(([v, c]) => `rgba(${c[0]},${c[1]},${c[2]},${Math.max(0.25, c[3] / 255)}) ${((v - lo) / (hi - lo)) * 100}%`).join(',');
  const unit = state.metric === 'rsrp' ? 'dBm' : 'dB';
  const title = state.metric === 'rsrp' ? 'RSRP · potencia recibida' : 'SINR · calidad de señal';
  $('#legend').innerHTML = `
    <div class="lt"><b>${title}</b><span>${state.band.label} · umbral ${COVER_THRESHOLD} dBm</span></div>
    <div class="grad" style="background:linear-gradient(90deg,${grad})"></div>
    <div class="ticks">${st.filter((_, i) => i % 2 === 0 || i === st.length - 1).map(([v]) => `<span>${v}</span>`).join('')}<span>${unit}</span></div>`;
}

// ---------------------------------------------------------------- Inspector
const LAT0 = 40.4168, LON0 = -3.7038;
const toLatLon = (x, z) => [LAT0 - (z - FEATURES.sol.z) / 111320, LON0 + (x - FEATURES.sol.x) / (111320 * Math.cos((LAT0 * Math.PI) / 180))];

function risk(a) {
  if (a.status === 'down') return 100;
  if (a.status === 'warn') return a.risk;
  return Math.min(30, Math.max(1, (a.health.vswr - 1.1) * 40 + (a.health.temp - 35) * 0.6));
}

function select(a, flyTo = false) {
  state.selected = a;
  state.antennas.forEach(updateLabel);
  renderInspector();
  if (state.layers.rays) rebuildRays();
  if (a && flyTo) flyToPoint(a.x, a.roofH, a.z, 360);
}

function renderInspector() {
  const el = $('#inspector');
  const a = state.selected;
  if (!a) {
    el.innerHTML = `
      <div class="overview">
        <div class="insp-h"><div><small>ESCENARIO</small><h2 style="font-family:Inter">Madrid Centro</h2></div></div>
        <dl>
          <dt>Área modelada</dt><dd>1,44 km²</dd>
          <dt>Edificios</dt><dd>${city.B.length.toLocaleString('es')}</dd>
          <dt>Resolución</dt><dd>${CELL} m · ${N}×${N}</dd>
          <dt>Banda</dt><dd>${state.band.label}</dd>
          <dt>Motor</dt><dd>Ray tracing · 4 rebotes</dd>
          <dt>Antenas</dt><dd>${state.antennas.length}</dd>
        </dl>
        <p>Haz clic en una antena para inspeccionarla, o pasa el ratón por el mapa para leer la señal en cada punto.</p>
      </div>`;
    return;
  }
  const [lat, lon] = toLatLon(a.x, a.z);
  el.innerHTML = `
    <div class="insp-h">
      <div><small>ESTACIÓN BASE${a.ai ? ' · PROPUESTA IA' : ''}</small><h2>${a.name}</h2></div>
      <button class="close" id="iClose">×</button>
    </div>
    <span class="pill" id="iPill"></span>
    <div class="meta mono">${lat.toFixed(5)}° N · ${Math.abs(lon).toFixed(5)}° O · azotea ${Math.round(a.roofH)} m</div>
    <div class="gauge"><div class="gh"><span>Temperatura RRU</span><b id="gT"></b></div><div class="bar"><i id="bT"></i></div></div>
    <div class="gauge"><div class="gh"><span>VSWR</span><b id="gV"></b></div><div class="bar"><i id="bV"></i></div></div>
    <div class="gauge"><div class="gh"><span>Carga de tráfico</span><b id="gL"></b></div><div class="bar"><i id="bL"></i></div></div>
    <div class="gauge"><div class="gh"><span>Potencia TX</span><b id="gP"></b></div><div class="bar"><i id="bP"></i></div></div>
    <div class="row"><label>Azimut sector α <b id="iAz">${a.az}°</b></label><input type="range" id="azR" min="0" max="119" value="${a.az}" /></div>
    <div class="pred"><div class="gh"><span>Riesgo de fallo · 24 h</span><b id="iRisk"></b></div><div class="bar"><i id="bR"></i></div><p id="iReason"></p></div>
    <div class="btns">
      <button class="btn danger" id="iFail"></button>
      <button class="btn" id="iDel">Eliminar</button>
    </div>`;
  $('#iClose').onclick = () => select(null);
  $('#iDel').onclick = () => { mapCache.forEach((_, k) => k.startsWith(`${a.id}|`) && mapCache.delete(k)); removeAntenna(a); refresh(); };
  $('#iFail').onclick = () => (a.status === 'down' ? repair(a) : fail(a));
  let t = null;
  $('#azR').oninput = (e) => {
    a.az = +e.target.value;
    $('#iAz').textContent = `${a.az}°`;
    a.group.rotation.y = -THREE.MathUtils.degToRad(a.az);
    clearTimeout(t);
    t = setTimeout(() => refresh(), 120);
  };
  updateInspectorValues();
}

function setBar(id, frac, color) {
  const el = $(id);
  if (!el) return;
  el.style.width = `${Math.max(2, Math.min(100, frac * 100))}%`;
  el.style.background = color;
}
const lvl = (f) => (f > 0.8 ? 'var(--bad)' : f > 0.6 ? 'var(--warn)' : 'var(--accent)');

function updateInspectorValues() {
  const a = state.selected;
  if (!a || !$('#gT')) return;
  const h = a.health, down = a.status === 'down';
  const pill = $('#iPill');
  pill.className = `pill ${a.status}`;
  pill.textContent = { ok: '● Operativa', warn: '● Degradación detectada', down: '● Fuera de servicio' }[a.status];
  $('#gT').textContent = `${fmt(h.temp)} °C`; setBar('#bT', (h.temp - 20) / 55, lvl((h.temp - 20) / 55));
  $('#gV').textContent = fmt(h.vswr, 2); setBar('#bV', (h.vswr - 1) / 1.2, lvl((h.vswr - 1) / 1.2));
  $('#gL').textContent = down ? '—' : `${Math.round(h.load)}%`; setBar('#bL', down ? 0 : h.load / 100, lvl(h.load / 100));
  $('#gP').textContent = down ? '—' : `${fmt(h.pwr)} dBm`; setBar('#bP', down ? 0 : (h.pwr - 30) / 13, 'var(--accent)');
  const r = risk(a);
  $('#iRisk').textContent = `${Math.round(r)}%`;
  setBar('#bR', r / 100, lvl(r / 100));
  $('#iReason').textContent = down ? 'Estación caída: el gemelo recalcula la cobertura sin ella.'
    : a.status === 'warn' ? `${a.reason}. Fallo estimado en ${eta(a.eta)}.`
      : 'Sin anomalías: las medidas coinciden con lo que predice el gemelo.';
  $('#iFail').textContent = down ? 'Reparar' : 'Simular fallo';
}

// ---------------------------------------------------------------- Fallos y alertas
const REASONS = [
  'VSWR en aumento: posible degradación del conector',
  'Temperatura del RRU por encima de su patrón',
  'Caída progresiva de la potencia de salida',
  'Errores CRC crecientes en el enlace CPRI',
  'Consumo anómalo del ventilador',
];
const eta = (m) => (m >= 60 ? `${Math.floor(m / 60)} h ${String(Math.round(m % 60)).padStart(2, '0')} min` : `${Math.max(1, Math.round(m))} min`);
let alertSeq = 0;

function pushAlert(type, ant, extra = {}) {
  state.alerts = state.alerts.filter((x) => x.ant !== ant || x.type === 'info');
  state.alerts.unshift({ id: ++alertSeq, type, ant, born: performance.now(), ...extra });
  state.alerts = state.alerts.slice(0, 4);
  renderAlerts();
}

function predictFailure(a) {
  setStatus(a, 'warn');
  a.risk = 62 + rnd() * 30;
  a.eta = 70 + rnd() * 150;
  a.reason = REASONS[Math.floor(rnd() * REASONS.length)];
  pushAlert('warn', a);
  if (state.selected === a) updateInspectorValues();
}

async function fail(a) {
  const before = state.kpi ? state.kpi.cov : 0;
  setStatus(a, 'down');
  await refresh();
  pushAlert('down', a, { loss: before - state.kpi.cov });
  if (state.selected === a) updateInspectorValues();
}

async function repair(a, preventive = false) {
  setStatus(a, 'ok');
  a.health.vswr = 1.12 + rnd() * 0.1;
  a.health.temp = 36 + rnd() * 5;
  state.alerts = state.alerts.filter((x) => x.ant !== a);
  if (preventive) pushAlert('info', a);
  else renderAlerts();
  await refresh();
  if (state.selected === a) updateInspectorValues();
}

function renderAlerts() {
  $('#alerts').innerHTML = state.alerts.map((al) => {
    const a = al.ant;
    if (al.type === 'warn') return `
      <div class="alert warn" data-id="${al.id}"><div class="a-ico">⚠</div><div>
        <div class="a-t">${a.name} · riesgo de fallo <b>${Math.round(a.risk)}%</b></div>
        <div class="a-d">${a.reason}<br>VSWR ${fmt(a.health.vswr, 2)} · ${fmt(a.health.temp)} °C · fallo en <b>${eta(a.eta)}</b></div>
        <div class="a-b"><button data-act="view">Ver</button><button data-act="fix" class="prim">Mantenimiento preventivo</button><button data-act="fail">Simular fallo</button></div>
      </div></div>`;
    if (al.type === 'down') return `
      <div class="alert down" data-id="${al.id}"><div class="a-ico">●</div><div>
        <div class="a-t">${a.name} · FUERA DE SERVICIO</div>
        <div class="a-d">Cobertura ${al.loss > 0 ? '−' : ''}${fmt(Math.abs(al.loss || 0))} puntos · tráfico redirigido a celdas vecinas</div>
        <div class="a-b"><button data-act="view">Ver</button><button data-act="repair" class="prim">Reparar</button></div>
      </div></div>`;
    return `
      <div class="alert info" data-id="${al.id}"><div class="a-ico">✓</div><div>
        <div class="a-t">Fallo evitado en ${a.name}</div>
        <div class="a-d">Mantenimiento preventivo programado antes de la caída.</div>
      </div></div>`;
  }).join('');
}

$('#alerts').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const al = state.alerts.find((x) => x.id === +btn.closest('.alert').dataset.id);
  if (!al) return;
  const act = btn.dataset.act;
  if (act === 'view') select(al.ant, true);
  if (act === 'fail') fail(al.ant);
  if (act === 'fix') repair(al.ant, true);
  if (act === 'repair') repair(al.ant);
});

// ---------------------------------------------------------------- Simulación temporal
let simAcc = 0, secAcc = 0, nextAlert = 9;
function simStep(dt) {
  if (!state.playing) return;
  simAcc += dt; secAcc += dt; nextAlert -= dt;
  while (simAcc > 0.25) {
    simAcc -= 0.25;
    state.simMin = (state.simMin + 1) % 1440;
    for (const a of state.antennas) {
      if (a.status !== 'warn') continue;
      a.eta -= 1;
      a.health.vswr += 0.004;
      a.health.temp += 0.06;
      a.risk = Math.min(99, a.risk + 0.15);
      if (a.eta <= 0) fail(a);
    }
  }
  if (secAcc > 1) {
    secAcc = 0;
    const hour = state.simMin / 60;
    const base = 45 + 30 * Math.sin(((hour - 8) / 24) * Math.PI * 2) + (rnd() - 0.5) * 6;
    state.traffic.push(Math.max(5, Math.min(98, base)));
    if (state.traffic.length > 60) state.traffic.shift();
    for (const a of state.antennas) {
      const h = a.health;
      h.load = Math.max(3, Math.min(99, base + (a.id % 5) * 4 - 8 + (rnd() - 0.5) * 10));
      h.temp += (rnd() - 0.5) * 0.4 + (h.load - 50) * 0.004;
      h.temp = Math.max(30, Math.min(75, h.temp));
      if (a.status === 'ok') h.vswr = Math.max(1.08, Math.min(1.35, h.vswr + (rnd() - 0.5) * 0.01));
      h.pwr = a.status === 'warn' ? Math.max(33, h.pwr - 0.05) : 39.5 + (rnd() - 0.5) * 0.6;
      updateLabel(a);
    }
    drawSpark();
    updateInspectorValues();
    if (state.alerts.some((al) => al.type === 'warn')) renderAlerts();
    state.alerts = state.alerts.filter((al) => al.type !== 'info' || performance.now() - al.born < 8000);
  }
  if (nextAlert <= 0) {
    nextAlert = 16 + rnd() * 12;
    const pool = state.antennas.filter((a) => a.status === 'ok');
    if (pool.length > 2 && state.antennas.filter((a) => a.status !== 'ok').length < 2) predictFailure(pool[Math.floor(rnd() * pool.length)]);
  }
  const hh = Math.floor(state.simMin / 60), mm = state.simMin % 60;
  $('#clock').textContent = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function drawSpark() {
  const c = $('#spark'), g = c.getContext('2d');
  const w = c.width, h = c.height, d = state.traffic;
  g.clearRect(0, 0, w, h);
  if (d.length < 2) return;
  const x = (i) => (i / 59) * w, y = (v) => h - 6 - (v / 100) * (h - 12);
  g.beginPath();
  d.forEach((v, i) => (i ? g.lineTo(x(i), y(v)) : g.moveTo(x(i), y(v))));
  g.strokeStyle = '#22d3ee';
  g.lineWidth = 3;
  g.stroke();
  g.lineTo(x(d.length - 1), h);
  g.lineTo(0, h);
  const gr = g.createLinearGradient(0, 0, 0, h);
  gr.addColorStop(0, 'rgba(34,211,238,0.35)');
  gr.addColorStop(1, 'rgba(34,211,238,0)');
  g.fillStyle = gr;
  g.fill();
  $('#kLoad').textContent = `${fmt((d[d.length - 1] / 100) * 4.8)} Gbps`;
}

// ---------------------------------------------------------------- Interacción
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
function pick(ev) {
  ndc.set((ev.clientX / innerWidth) * 2 - 1, -(ev.clientY / innerHeight) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const { origin: o, direction: d } = raycaster.ray;
  const h = raycast(city, o.x, o.y, o.z, d.x, d.y, d.z, 8000);
  if (!h) return null;
  return { x: o.x + d.x * h.t, y: o.y + d.y * h.t, z: o.z + d.z * h.t, building: h.index >= 0 ? city.B[h.index] : null };
}

const tooltip = $('#tooltip');
let hoverEv = null;
canvas.addEventListener('pointermove', (e) => { hoverEv = e; });
canvas.addEventListener('pointerleave', () => { hoverEv = null; tooltip.style.display = 'none'; });

function updateHover() {
  if (!hoverEv || !state.result) return;
  const e = hoverEv;
  hoverEv = null;
  const p = pick(e);
  if (!p || Math.abs(p.x) > HALF || Math.abs(p.z) > HALF) { tooltip.style.display = 'none'; return; }
  const i = Math.floor((p.x + HALF) / CELL), j = Math.floor((p.z + HALF) / CELL);
  const c = j * N + i;
  const r = state.result;
  const srv = r.best[c] >= 0 ? state.activeList[r.best[c]] : null;
  const where = p.building ? `Edificio · ${Math.round(p.building.h)} m (interior)` : 'Calle · exterior a 1,5 m';
  const q = r.rsrp[c] >= -85 ? 'Excelente' : r.rsrp[c] >= -95 ? 'Buena' : r.rsrp[c] >= COVER_THRESHOLD ? 'Aceptable' : 'Sin servicio';
  tooltip.innerHTML = `
    <div class="tt">${state.placing ? '＋ Instalar antena aquí' : where}</div>
    <div class="tr">RSRP<b>${r.rsrp[c] <= -150 ? '—' : `${Math.round(r.rsrp[c])} dBm`}</b></div>
    <div class="tr">SINR<b>${fmt(r.sinr[c])} dB</b></div>
    <div class="tr">Servidora<b>${srv ? srv.name : '—'}</b></div>
    <div class="tr">Calidad<b>${q}</b></div>`;
  tooltip.style.display = 'block';
  tooltip.style.left = `${Math.min(e.clientX + 16, innerWidth - 200)}px`;
  tooltip.style.top = `${e.clientY + 16}px`;
}

let downAt = null;
canvas.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; });
canvas.addEventListener('pointerup', (e) => {
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 5) return;
  const p = pick(e);
  if (state.placing) {
    if (!p || Math.abs(p.x) > HALF - 5 || Math.abs(p.z) > HALF - 5) return;
    const b = p.building || roofAt(p.x, p.z);
    const a = addAntenna({ x: p.x, z: p.z, roofH: b ? b.h : heightAt(city, p.x, p.z) });
    setPlacing(false);
    select(a);
    refresh();
    return;
  }
  // Selección: antena más cercana en pantalla.
  let best = null, bd = 26;
  const v = new THREE.Vector3();
  for (const a of state.antennas) {
    v.set(a.x, a.roofH + 10, a.z).project(camera);
    const d = Math.hypot(((v.x + 1) / 2) * innerWidth - e.clientX, ((1 - v.y) / 2) * innerHeight - e.clientY);
    if (d < bd) { bd = d; best = a; }
  }
  select(best);
});

function setPlacing(on) {
  state.placing = on;
  $('#placeBtn').classList.toggle('on', on);
  $('#hint').classList.toggle('on', on);
  document.body.classList.toggle('placing', on);
}
$('#placeBtn').onclick = () => setPlacing(!state.placing);
addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { setPlacing(false); select(null); }
  if (e.key === 'Delete' && state.selected) $('#iDel')?.click();
});

$('#bandSeg').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  $('#bandSeg').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
  state.band = BANDS[b.dataset.band];
  state.kpi = null;
  $('#kCovD').textContent = '';
  state.antennas.forEach(updateLabel);
  renderInspector();
  refresh();
});

$('#metricSeg').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  $('#metricSeg').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
  state.metric = b.dataset.metric;
  paintHeat();
});

document.querySelectorAll('[data-layer]').forEach((inp) => {
  inp.addEventListener('change', () => {
    state.layers[inp.dataset.layer] = inp.checked;
    heat.visible = state.layers.coverage;
    rays.visible = state.layers.rays;
    setGhost(state.layers.ghost);
  });
});

$('#playBtn').onclick = () => {
  state.playing = !state.playing;
  $('#playBtn').textContent = state.playing ? '❚❚' : '▶';
  document.querySelector('.topbar').classList.toggle('paused', !state.playing);
};

$('#viewBtn').onclick = () => { select(null); flyToPoint(HOME.target.x, 0, HOME.target.z, null); };

$('#optBtn').onclick = () => {
  const btn = $('#optBtn');
  btn.disabled = true;
  btn.textContent = '✦ Evaluando 70 azoteas…';
  $('#busy').classList.add('on');
  setTimeout(async () => {
    const active = state.antennas.filter((a) => a.status !== 'down');
    const r = optimizePlacement(city, active, state.band, rnd);
    btn.disabled = false;
    btn.textContent = '✦ Optimizar ubicación (IA)';
    if (!r) return;
    const a = addAntenna({ x: r.x, z: r.z, roofH: r.roofH, az: r.az, ai: true });
    await refresh();
    select(a, true);
    toast(`✦ Nueva ubicación propuesta: <b>${a.name}</b> · cobertura +${fmt(r.after - r.before)} puntos`);
  }, 60);
};

let toastT = null;
function toast(html) {
  const t = $('#toast');
  t.innerHTML = html;
  t.classList.add('on');
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove('on'), 4500);
}

// ---------------------------------------------------------------- Cámara
let fly = null;
function flyToPoint(x, y, z, dist) {
  controls.autoRotate = false;
  const toT = new THREE.Vector3(x, y, z);
  let toP;
  if (dist == null) toP = HOME.pos.clone();
  else {
    const dir = camera.position.clone().sub(controls.target).setY(0).normalize();
    toP = toT.clone().add(dir.multiplyScalar(dist));
    toP.y = y + dist * 0.75;
  }
  fly = { p0: camera.position.clone(), t0: controls.target.clone(), toP, toT, k: 0 };
}

// ---------------------------------------------------------------- Etiquetas
const tmpV = new THREE.Vector3();
function placeLabels() {
  for (const a of state.antennas) {
    tmpV.set(a.x, a.group.position.y + 16, a.z).project(camera);
    const vis = tmpV.z < 1 && a.group.visible && a.drop < 0.05;
    a.label.style.display = vis ? 'flex' : 'none';
    if (vis) a.label.style.left = `${((tmpV.x + 1) / 2) * innerWidth}px`, a.label.style.top = `${((1 - tmpV.y) / 2) * innerHeight}px`;
  }
}

// ---------------------------------------------------------------- Bucle
const clock = new THREE.Clock();
let t = 0, introDone = false;
function tick() {
  const dt = Math.min(clock.getDelta(), 0.05);
  t += dt;

  if (grow < 1) {
    grow = Math.min(1, grow + dt * 0.55);
    bMat.uniforms.uGrow.value = 1 - (1 - grow) ** 3;
  } else if (!introDone) {
    introDone = true;
    state.antennas.forEach((a, i) => setTimeout(() => { a.group.visible = true; }, i * 140));
  }

  if (fly) {
    fly.k = Math.min(1, fly.k + dt / 1.4);
    const e = ease(fly.k);
    camera.position.lerpVectors(fly.p0, fly.toP, e);
    controls.target.lerpVectors(fly.t0, fly.toT, e);
    if (fly.k >= 1) fly = null;
  }
  controls.update();

  for (const a of state.antennas) {
    if (a.group.visible && a.drop > 0) {
      a.drop = Math.max(0, a.drop - dt * 1.6);
      a.group.position.y = a.roofH + a.drop ** 2 * 160;
    }
    const { halo, tip } = a.group.userData;
    const sel = state.selected === a;
    const blinkF = a.status === 'warn' ? 0.5 + 0.5 * Math.sin(t * 9) : a.status === 'down' ? 0.35 + 0.65 * (Math.sin(t * 5) > 0) : 1;
    halo.scale.setScalar((sel ? 26 : 16) * (0.85 + 0.15 * Math.sin(t * 3 + a.id)) * (0.6 + 0.4 * blinkF));
    tip.scale.setScalar(sel ? 1.5 : 1);
    const showWaves = state.layers.waves && a.status !== 'down' && a.group.visible && a.drop === 0;
    a.shells.forEach((m, k) => {
      m.visible = showWaves;
      if (!showWaves) return;
      const ph = (t * 0.3 + k / 3 + a.id * 0.13) % 1;
      m.scale.setScalar(6 + ph * state.band.range);
      m.material.uniforms.uAlpha.value = (1 - ph) ** 1.6 * (sel ? 0.75 : 0.45) * (a.status === 'warn' ? blinkF : 1);
      m.material.uniforms.uColor.value.setHex(a.status === 'warn' ? 0xfbbf24 : state.band.color);
    });
  }
  rayMat.uniforms.uTime.value = t;

  simStep(dt);
  updateHover();
  placeLabels();
  composer.render();
  requestAnimationFrame(tick);
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
});

renderInspector();
renderLegend();
heat.visible = true;
refresh();
tick();
