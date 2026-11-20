import * as THREE from "three";
export const KX = 89.5, KZ = 111.19, LON_C = 137, LAT_C = 36.5;
export const lonlat2xz = (lon, lat) => [(lon - LON_C) * KX, -(lat - LAT_C) * KZ];
const VS = `
attribute float aV; attribute float aL; uniform float uTone, uMinPx, uScale, uSize, uGain, uHmax, uMaxPx, uFogN, uFogF, uFogS; uniform vec3 uS; varying vec3 vC; varying float vI;
vec3 ramp(float d){
  vec3 c0=vec3(.04,.10,.50), c1=vec3(.08,.38,.90), c2=vec3(.38,.86,1.0), c3=vec3(.66,.79,.93), c4=vec3(1.0,.72,.18);
  vec3 c=mix(c0,c1,smoothstep(15.,24.,d)); c=mix(c,c2,smoothstep(24.,uS.x,d)); c=mix(c,c3,smoothstep(uS.x,uS.y,d)); c=mix(c,c4,smoothstep(uS.y,uS.z,d)); return c; }
void main(){
  float d=15.+40.*aV; vC=ramp(d);
  float hn=clamp(position.y/uHmax,0.,1.); vI=uGain*mix(.14,1.,smoothstep(18.,42.,d))*mix(1.,1.25,smoothstep(48.,56.,d))*aL*mix(.38,1.35,pow(hn,.85));
  vec4 mv=modelViewMatrix*vec4(position,1.); gl_Position=projectionMatrix*mv;
  float s0=uSize*mix(.45,1.,smoothstep(16.,38.,d))*uScale/(-mv.z); float s1=s0/(1.+s0/uMaxPx); vI*=pow(s0/s1,1.0)*(1.-uFogS*smoothstep(uFogN,uFogF,-mv.z));
  vI=vI/(1.+uTone*vI); gl_PointSize=max(s1,uMinPx); }`;
const FS = `varying vec3 vC; varying float vI; uniform vec2 uRes; uniform float uDpr; void main(){ float d=length(gl_PointCoord-.5)*2.; if(d>1.) discard; float a=exp(-d*d*3.2);
  float dx=(uRes.x-gl_FragCoord.x)/uDpr, dy=(uRes.y-gl_FragCoord.y)/uDpr; float f=(1.-smoothstep(380.,500.,dx))*(1.-smoothstep(240.,320.,dy));
  gl_FragColor=vec4(vC*vI*(1.-.8*f), a); }`;
export function makeRain(maxPts) {
  const pos = new Float32Array(maxPts * 3), val = new Float32Array(maxPts), lit = new Float32Array(maxPts);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
  g.setAttribute("aV", new THREE.BufferAttribute(val, 1).setUsage(THREE.DynamicDrawUsage));
  g.setAttribute("aL", new THREE.BufferAttribute(lit, 1).setUsage(THREE.DynamicDrawUsage));
  const mat = new THREE.ShaderMaterial({ vertexShader: VS, fragmentShader: FS, transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, uniforms: { uScale: { value: 1000 }, uSize: { value: 2.0 }, uGain: { value: 0.9 }, uHmax: { value: 100 }, uMaxPx: { value: 1e6 }, uTone: { value: 0 }, uMinPx: { value: 1.2 }, uFogN: { value: 1e5 }, uFogF: { value: 2e5 }, uFogS: { value: 0 }, uS: { value: new THREE.Vector3(36, 46, 52) }, uRes: { value: new THREE.Vector2(1920, 1080) }, uDpr: { value: 1 } } });
  const pts = new THREE.Points(g, mat); pts.frustumCulled = false; g.setDrawRange(0, 0);
  return { pts, pos, val, lit, g, mat, max: maxPts };
}
export const gridCache = new Map(); export const cfg = { dir: "grids", q8: false, limit: 40 };
export async function loadGrid(i, tags) {
  if (gridCache.has(i)) return gridCache.get(i);
  const r = await fetch(`${cfg.dir}/${tags[i]}.${cfg.q8 ? "q8" : "u16"}.gz`); if (!r.ok) throw new Error("grid");
  const ab = await new Response(r.body.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
  const a = cfg.q8 ? new Uint8Array(ab) : new Uint16Array(ab); gridCache.set(i, a);
  if (gridCache.size > cfg.limit) gridCache.delete(gridCache.keys().next().value);
  return a;
}
export async function loadHaze(i, tags) {
  const k = "hz" + i; if (gridCache.has(k)) return gridCache.get(k);
  const r = await fetch(`${cfg.dir}/${tags[i]}.hz.gz`); if (!r.ok) throw new Error("hz");
  const a = new Uint8Array(await new Response(r.body.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer()); gridCache.set(k, a);
  if (gridCache.size > cfg.limit) gridCache.delete(gridCache.keys().next().value);
  return a;
}
const hh2 = (x, y) => { let h = Math.imul(x * 374761393 + y * 668265263, 1274126177); h ^= h >>> 13; h = Math.imul(h, 1103515245); return ((h ^ (h >>> 16)) & 65535) / 65536; };
const vnoise = (x, y) => { const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi, u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy); return (hh2(xi, yi) * (1 - u) + hh2(xi + 1, yi) * u) * (1 - v) + (hh2(xi, yi + 1) * (1 - u) + hh2(xi + 1, yi + 1) * u) * v; };
// Fill rain points for time between grids A,B (weight w). keep<1 thins only weak points (for the 300k interactive cap).
const ss = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
export function fillRain(rain, A, B, w, idx, HS, keep = 1, HT = 0.03, haze = null) {
  const { rows, cols, lon0, lat0, dx, dy } = idx, pos = rain.pos, val = rain.val, lit = rain.lit, max = rain.max;
  const kn = rain.knee ?? 1, sl = rain.slope ?? 1, cmp = z => z < kn ? z : kn + (z - kn) * sl, LS = rain.shade ?? 4.5;
  const F = new Float32Array(rows * cols), s = 1 / (rain.qmax || 65535);
  for (let k = 0; k < F.length; k++) F[k] = ((1 - w) * A[k] + w * B[k]) * s;
  // distance (in cells, chamfer) from the outer edge of the rain mask, clipped at 12
  const DD = new Uint8Array(rows * cols), HTm = HT;
  for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) { const k = i * cols + j; if (F[k] < HTm) DD[k] = 0; else { const a = i > 0 ? DD[k - cols] : 0, b = j > 0 ? DD[k - 1] : 0, d = i > 0 && j > 0 ? DD[k - cols - 1] : 0; DD[k] = Math.min(12, Math.min(a, b, d) + 1); } }
  for (let i = rows - 1; i >= 0; i--) for (let j = cols - 1; j >= 0; j--) { const k = i * cols + j; if (DD[k] === 0) continue; const a = i < rows - 1 ? DD[k + cols] : 0, b = j < cols - 1 ? DD[k + 1] : 0, d = i < rows - 1 && j < cols - 1 ? DD[k + cols + 1] : 0; DD[k] = Math.min(DD[k], Math.min(a, b, d) + 1); }
  if (rain.focus && rain.smooth !== false) {
    const FC = rain.focus, cx = (FC.x / KX + LON_C - lon0) / dx, cy = (lat0 - (LAT_C - FC.z / KZ)) / dy, rc = FC.r / KX / dx, rr = FC.r / KZ / dy;
    const j0 = Math.max(2, Math.floor(cx - rc)), j1 = Math.min(cols - 3, Math.ceil(cx + rc)), i0 = Math.max(2, Math.floor(cy - rr)), i1 = Math.min(rows - 3, Math.ceil(cy + rr));
    if (j1 > j0 && i1 > i0) {
      const bw = j1 - j0 + 1, bh = i1 - i0 + 1, T = new Float32Array(bw * bh), nb = new Float32Array(9);
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
        let m = 0, c = 0, avg = 0;
        for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) { const v = F[(i + di) * cols + j + dj]; avg += v; let p = c++; while (p > 0 && nb[p - 1] > v) { nb[p] = nb[p - 1]; p--; } nb[p] = v; }
        m = nb[4]; avg /= 9; T[(i - i0) * bw + (j - j0)] = Math.min(m, avg + 0.10);
      }
      const K0 = 0.21, K1 = 0.58, U = new Float32Array(bw * bh);
      for (let i = 0; i < bh; i++) for (let j = 0; j < bw; j++) { const a = T[i * bw + Math.max(j - 1, 0)], b = T[i * bw + j], c = T[i * bw + Math.min(j + 1, bw - 1)]; U[i * bw + j] = K0 * a + K1 * b + K0 * c; }
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) { const ii = i - i0, a = U[Math.max(ii - 1, 0) * bw + j - j0], b = U[ii * bw + j - j0], c = U[Math.min(ii + 1, bh - 1) * bw + j - j0]; F[i * cols + j] = K0 * a + K1 * b + K0 * c; }
    }
  }
  let n = 0;
  for (let i = 0; i < rows - 1; i++) for (let j = 0; j < cols - 1; j++) {
    const k = i * cols + j, v00 = F[k], v01 = F[k + 1], v10 = F[k + cols], v11 = F[k + cols + 1];
    if (v00 < HT && v01 < HT && v10 < HT && v11 < HT) continue;
    const c00 = cmp(v00), c01 = cmp(v01), c10 = cmp(v10), c11 = cmp(v11), gx = ((c01 + c11) - (c00 + c10)) / 2, gy = ((c10 + c11) - (c00 + c01)) / 2;
    const shade = Math.min(1.5, Math.max(0.18, 0.62 + (-gy + 0.4 * gx) * LS));
    const ccx = (lon0 + (j + 1) * dx - LON_C) * KX, ccz = -(lat0 - (i + 1) * dy - LAT_C) * KZ, FC = rain.focus; let fw = 0;
    if (FC) { const dd = Math.hypot(ccx - FC.x, ccz - FC.z); fw = 1 - ss(FC.r * 0.6, FC.r, dd); }
    const NQ = fw > 0 ? 16 : 4, fl = 1 / Math.pow(1 + 3 * fw, 0.8), TH = rain.thin ?? 1;
    for (let q = 0; q < NQ; q++) {
      let h = Math.imul(k * 16 + q + 1, 2654435761); h ^= h >>> 15; h = Math.imul(h, 2246822519); h ^= h >>> 13;
      const r1 = (h & 1023) / 1024, r2 = ((h >>> 10) & 1023) / 1024, r3 = ((h >>> 20) & 1023) / 1024;
      let fu, fv;
      if (q < 4) { if (fw > 0) { fu = r1; fv = r2; } else { fu = (q & 1) * 0.5 + r1 * 0.5; fv = (q >> 1) * 0.5 + r2 * 0.5; } }
      else { const r4 = ((h >>> 5) & 1023) / 1024, r5 = ((h >>> 15) & 1023) / 1024; if (r4 > fw) continue; fu = r1; fv = r5; }
      let v = (v00 * (1 - fu) + v01 * fu) * (1 - fv) + (v10 * (1 - fu) + v11 * fu) * fv;
      const lon = lon0 + (j + fu + 0.5) * dx, lat = lat0 - (i + fv + 0.5) * dy;
      const efr = Math.min(1, Math.max(0, ((idx.lon1 ?? 146) - lon) / 1.6), Math.max(0, ((idx.latN ?? 45) - lat) / 1.0), Math.max(0, (lat - (idx.latS ?? 28)) / 1.0)), ef = efr * efr * (3 - 2 * efr);
      v *= ef;
      if (v < HT) continue;
      const edgeF = 1 - (1 - ss(0, 8, DD[k])) * (1 - ss(0.45, 0.65, v)) * (rain.edge ?? 0.75);
      { let p = 0.12 + 0.88 * (() => { const t = Math.min(1, Math.max(0, (v - 0.04) / 0.46)); return t * t * (3 - 2 * t); })();
        if (rain.noise) p *= Math.max(0.05, 1 + rain.noise * (2 * vnoise(lon * 9, lat * 9) - 1) * (1 - ss(0.3, 0.6, v)));
        if (FC) p = Math.min(1, p * (1 + 0.7 * fw)); if (r3 > p * edgeF * TH) continue; }
      if (keep < 1 && v < 0.35 && r3 > keep * p) continue;
      if (n >= max) break;
      pos[3 * n] = (lon - LON_C) * KX; { const kn = rain.knee ?? 1, sl = rain.slope ?? 1, vc = v < kn ? v : kn + (v - kn) * sl, bump = ss(0.30, 0.45, v) * (1 - ss(0.70, 0.85, v)); pos[3 * n + 1] = Math.pow(vc, rain.gamma || 1) * HS * (1 - (rain.mid ?? 0.35) * bump); } pos[3 * n + 2] = -(lat - LAT_C) * KZ; val[n] = v; lit[n] = shade * (0.35 + 0.65 * ef) * (0.45 + 0.55 * edgeF) * fl / Math.sqrt(TH); n++;
    }
  }
  if (haze) {
    const hr = haze.rows, hc = haze.cols, ds = haze.ds || 4, HA = haze.A, HB = haze.B, hg = rain.hazeGain ?? 6, hdx = dx * ds, hdy = dy * ds;
    for (let i = 0; i < hr; i++) for (let j = 0; j < hc; j++) {
      const k = i * hc + j, d = ((1 - w) * HA[k] + w * HB[k]) / 255; if (d < 0.03) continue;
      for (let q = 0; q < (rain.hazeN || 5); q++) {
        let h = Math.imul(k * 16 + q + 7, 2654435761); h ^= h >>> 15; h = Math.imul(h, 2246822519); h ^= h >>> 13;
        const r1 = (h & 1023) / 1024, r2 = ((h >>> 10) & 1023) / 1024, r3 = ((h >>> 20) & 1023) / 1024;
        const lon = lon0 + (j + r1) * hdx, lat = lat0 - (i + r2) * hdy;
        const efr = Math.min(1, Math.max(0, ((idx.lon1 ?? 146) - lon) / 1.6), Math.max(0, ((idx.latN ?? 45) - lat) / 1.0), Math.max(0, (lat - (idx.latS ?? 28)) / 1.0)), ef = efr * efr * (3 - 2 * efr);
        let pr = Math.min(1, d * 1.4) * ef * (rain.hazeDens ?? 1); pr *= Math.max(0.05, 1 + 0.8 * (2 * vnoise(lon * 7 + 31, lat * 7 + 17) - 1));
        if (r3 > pr * (rain.thin ?? 1)) continue; if (n >= max) break;
        const R = 0.1 + 1.9 * Math.min(1, d * 1.3), dbz = 10 * Math.log10(200 * Math.pow(R, 1.6));
        pos[3 * n] = (lon - LON_C) * KX; pos[3 * n + 1] = 0.3 + 4 * d; pos[3 * n + 2] = -(lat - LAT_C) * KZ; val[n] = (dbz - 15) / 40; lit[n] = hg * (0.4 + d) * ef / Math.sqrt(rain.thin ?? 1); n++;
      }
    }
  }
  rain.g.setDrawRange(0, n); rain.g.attributes.position.needsUpdate = true; rain.g.attributes.aV.needsUpdate = true; rain.g.attributes.aL.needsUpdate = true; return n;
}
export async function addTerrain(scene, relief = 6, dir = "terrain", extra = false) {
  const g = new THREE.Group();
  let b = new Float32Array(await (await fetch(dir + "/land.bin")).arrayBuffer());
  if (extra) { const e = new Float32Array(await (await fetch(dir + "/ne_land.bin")).arrayBuffer()), m = new Float32Array(b.length + e.length); m.set(b); m.set(e, b.length); b = m; }
  const n = b.length / 3, p = new Float32Array(n * 3), v = new Float32Array(n);
  for (let i = 0; i < n; i++) { p[3 * i] = (b[3 * i] - LON_C) * KX; p[3 * i + 2] = -(b[3 * i + 1] - LAT_C) * KZ; p[3 * i + 1] = b[3 * i + 2] / 1000 * relief; v[i] = Math.min(1, b[3 * i + 2] / 2500); }
  const geo = new THREE.BufferGeometry(); geo.setAttribute("position", new THREE.BufferAttribute(p, 3)); geo.setAttribute("aE", new THREE.BufferAttribute(v, 1));
  const m = new THREE.ShaderMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, uniforms: { uScale: { value: 1000 }, uSz: { value: 1.7 }, uMaxT: { value: 1e6 } },
    vertexShader: `attribute float aE; uniform float uScale, uSz, uMaxT; varying float vE; void main(){ vE=aE; vec4 mv=modelViewMatrix*vec4(position,1.); gl_Position=projectionMatrix*mv; float s0=uSz*uScale/(-mv.z); gl_PointSize=max(s0/(1.+s0/uMaxT),1.);}`,
    fragmentShader: `varying float vE; void main(){ float d=length(gl_PointCoord-.5)*2.; if(d>1.)discard; float a=exp(-d*d*3.); gl_FragColor=vec4(vec3(.30,.42,.56)*(.50+vE*1.1)*.15, a);}` });
  const pts = new THREE.Points(geo, m); pts.frustumCulled = false; g.add(pts);
  const coast = await (await fetch(dir + "/coast.json")).json(), seg = [];
  if (extra) coast.push(...await (await fetch(dir + "/ne_coast.json")).json());
  for (const l of coast) for (let i = 0; i + 1 < l.length; i++) { const a = lonlat2xz(l[i][0], l[i][1]), c = lonlat2xz(l[i + 1][0], l[i + 1][1]); seg.push(a[0], 0, a[1], c[0], 0, c[1]); }
  const lg = new THREE.BufferGeometry(); lg.setAttribute("position", new THREE.BufferAttribute(new Float32Array(seg), 3));
  const lm = new THREE.ShaderMaterial({ transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, uniforms: { uFadeN: { value: 1e6 }, uFadeF: { value: 2e6 }, uOp: { value: 0.55 } },
    vertexShader: "varying float vZ; void main(){ vec4 mv=modelViewMatrix*vec4(position,1.); vZ=-mv.z; gl_Position=projectionMatrix*mv; }",
    fragmentShader: "varying float vZ; uniform float uFadeN,uFadeF,uOp; void main(){ gl_FragColor=vec4(vec3(.663,.804,.949)*uOp*(1.-smoothstep(uFadeN,uFadeF,vZ)),1.); }" });
  g.add(new THREE.LineSegments(lg, lm)); scene.add(g); return { group: g, mat: m, lineMat: lm };
}
export function setScale(mats, H, fov) { const s = H / (2 * Math.tan(THREE.MathUtils.degToRad(fov) / 2)); mats.forEach(m => m.uniforms.uScale.value = s); }
