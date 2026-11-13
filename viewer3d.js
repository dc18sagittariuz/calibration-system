/*
 * แสดงโมเดล 3D ของเครื่องมือในหน้ารายละเอียด
 * - โหลด three.js เฉพาะตอนเปิดดูครั้งแรก (ไม่ทำให้หน้าแรกช้า)
 * - ถ้าเครื่องมีไฟล์ .glb ของตัวเอง จะแสดงไฟล์นั้น ไม่เช่นนั้นสร้างแบบจำลองตามประเภทเครื่อง
 * - หน้าจอบนโมเดลแสดงรหัสเครื่องและวันครบกำหนดจริง สติกเกอร์สอบเทียบแสดงวันที่ล่าสุด/ครบกำหนด
 *
 * ใช้งาน: Instrument3D.mount(element, info) / Instrument3D.unmount()
 */
(function () {
  'use strict';
  const CFG = window.APP_CONFIG || {};
  const BASE = (CFG.THREE_BASE || 'https://cdn.jsdelivr.net/npm/three@0.147.0/').replace(/\/?$/, '/');
  const LIBS = ['build/three.min.js', 'examples/js/controls/OrbitControls.js',
    'examples/js/loaders/GLTFLoader.js', 'examples/js/environments/RoomEnvironment.js'];
  const FONT = '"IBM Plex Sans Thai","Noto Sans Thai","Leelawadee UI",Tahoma,sans-serif';
  const MONO = '"IBM Plex Mono",ui-monospace,Menlo,Consolas,monospace';
  const STATUS = { over: '#C0392B', soon: '#B7791F', ok: '#2F855A', off: '#5F6B6A', none: '#5F6B6A', norec: '#5F6B6A' };
  const reduceMotion = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- loading ---------- */
  let loading = null;
  function script(src) {
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src; s.async = false; s.onload = res; s.onerror = () => rej(new Error('โหลด ' + src + ' ไม่ได้'));
      document.head.appendChild(s);
    });
  }
  function loadThree() {
    if (window.THREE && THREE.OrbitControls && THREE.GLTFLoader && THREE.RoomEnvironment) return Promise.resolve();
    if (!loading) loading = LIBS.reduce((p, f) => p.then(() => script(BASE + f)), Promise.resolve()).catch(e => { loading = null; throw e; });
    return loading;
  }
  function webglOK() {
    try { const c = document.createElement('canvas'); return !!(window.WebGLRenderingContext && (c.getContext('webgl2') || c.getContext('webgl'))); }
    catch (e) { return false; }
  }
  function fontsReady() {
    if (!document.fonts || !document.fonts.load) return Promise.resolve();
    const t = new Promise(r => setTimeout(r, 1200));
    return Promise.race([Promise.all([document.fonts.load('600 40px "IBM Plex Sans Thai"'), document.fonts.load('500 40px "IBM Plex Mono"')]), t]).catch(() => {});
  }

  /* ---------- viewer state ---------- */
  const V = { renderer: null, scene: null, camera: null, controls: null, env: null, raf: 0, model: null, host: null, ro: null, token: 0, home: null };
  let bag = []; // disposables of the current model
  const keep = o => { bag.push(o); return o; };

  function ensureRenderer() {
    if (V.renderer) return;
    if (THREE.ColorManagement) THREE.ColorManagement.legacyMode = false; // hex colours are sRGB
    const r = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    r.outputEncoding = THREE.sRGBEncoding;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 0.95;
    r.setClearColor(0x000000, 0);
    V.renderer = r;
    V.scene = new THREE.Scene();
    const pm = new THREE.PMREMGenerator(r);
    V.env = pm.fromScene(new THREE.RoomEnvironment(), 0.04).texture;
    pm.dispose();
    V.scene.environment = V.env;
    V.scene.add(new THREE.HemisphereLight(0xffffff, 0x8a99a8, 0.35));
    const key = new THREE.DirectionalLight(0xffffff, 0.9); key.position.set(6, 12, 8); V.scene.add(key);
    const rim = new THREE.DirectionalLight(0xdfefff, 0.45); rim.position.set(-6, 6, -10); V.scene.add(rim);
    V.camera = new THREE.PerspectiveCamera(30, 1.6, 0.1, 500);
    V.controls = new THREE.OrbitControls(V.camera, r.domElement);
    Object.assign(V.controls, { enableDamping: true, dampingFactor: 0.08, enablePan: false, rotateSpeed: 0.8, autoRotate: !reduceMotion, autoRotateSpeed: 1.6 });
    V.controls.addEventListener('start', () => { V.controls.autoRotate = false; });
    r.domElement.addEventListener('dblclick', resetView);
  }

  /* ---------- geometry helpers ---------- */
  function mat(color, rough, metal, extra) {
    return keep(new THREE.MeshStandardMaterial(Object.assign({ color, roughness: rough == null ? 0.55 : rough, metalness: metal || 0, envMapIntensity: 0.7 }, extra || {})));
  }
  function rrShape(w, h, r) {
    const s = new THREE.Shape(), x = -w / 2, y = -h / 2;
    r = Math.max(0.001, Math.min(r, w / 2, h / 2));
    s.moveTo(x + r, y); s.lineTo(x + w - r, y); s.quadraticCurveTo(x + w, y, x + w, y + r);
    s.lineTo(x + w, y + h - r); s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    s.lineTo(x + r, y + h); s.quadraticCurveTo(x, y + h, x, y + h - r);
    s.lineTo(x, y + r); s.quadraticCurveTo(x, y, x + r, y);
    return s;
  }
  /** rounded slab: footprint w (x) × d (z), height h (y) from y=0 */
  function slab(w, d, h, r, b, material) {
    b = Math.min(b, h / 2 - 0.001, w / 2 - 0.01, d / 2 - 0.01);
    const g = keep(new THREE.ExtrudeGeometry(rrShape(w - 2 * b, d - 2 * b, Math.max(0.01, r - b)),
      { depth: Math.max(0.001, h - 2 * b), bevelEnabled: b > 0, bevelThickness: b, bevelSize: b, bevelSegments: 5, curveSegments: 20 }));
    g.rotateX(-Math.PI / 2); g.translate(0, b, 0);
    return new THREE.Mesh(g, material);
  }
  function cyl(r, h, material, seg) {
    const g = keep(new THREE.CylinderGeometry(r, r, h, seg || 40));
    g.translate(0, h / 2, 0);
    return new THREE.Mesh(g, material);
  }
  function at(m, x, y, z) { m.position.set(x, y, z); return m; }
  function decal(w, d, tex) { // flat plane facing up, texture top toward -z
    const g = keep(new THREE.PlaneGeometry(w, d)); g.rotateX(-Math.PI / 2);
    return new THREE.Mesh(g, keep(new THREE.MeshStandardMaterial({ map: tex, roughness: 0.35, metalness: 0, envMapIntensity: 0.4 })));
  }

  /* ---------- canvas textures ---------- */
  function canvasTex(w, h, draw) {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    draw(c.getContext('2d'), w, h);
    const t = keep(new THREE.CanvasTexture(c));
    t.encoding = THREE.sRGBEncoding; t.anisotropy = 8;
    return t;
  }
  function fit(g, text, maxW, size, weight, family) {
    let s = size;
    do { g.font = `${weight} ${s}px ${family}`; s -= 2; } while (g.measureText(text).width > maxW && s > 10);
  }
  function screenTex(info, style, w, h) {
    return canvasTex(w, h, (g) => {
      const pal = {
        lcd: { bg: '#E4ECF2', bar: '#23303D', barInk: '#FFFFFF', ink: '#1C2731', mute: '#5B6B78' },
        seg: { bg: '#B9C590', bar: '#A3B07A', barInk: '#28301A', ink: '#1F2614', mute: '#4A5530' },
        color: { bg: '#FFFFFF', bar: '#1F6FB2', barInk: '#FFFFFF', ink: '#14202B', mute: '#5B6B78' }
      }[style];
      const col = style === 'seg' ? pal.ink : (STATUS[info.st] || pal.ink);
      g.fillStyle = pal.bg; g.fillRect(0, 0, w, h);
      if (style === 'seg') { // subtle LCD pixel grid
        g.fillStyle = 'rgba(0,0,0,.035)'; for (let x = 0; x < w; x += 4) g.fillRect(x, 0, 1, h);
      }
      const pad = Math.round(w * 0.045), barH = Math.round(h * 0.17);
      g.fillStyle = pal.bar; g.fillRect(0, 0, w, barH);
      g.fillStyle = pal.barInk; g.textBaseline = 'middle';
      fit(g, info.label, w * 0.55, Math.round(barH * 0.56), 600, FONT); g.textAlign = 'left'; g.fillText(info.label, pad, barH / 2);
      fit(g, info.unit, w * 0.4, Math.round(barH * 0.5), 500, MONO); g.textAlign = 'right'; g.fillText(info.unit, w - pad, barH / 2);
      g.textAlign = 'left'; g.fillStyle = pal.mute;
      fit(g, info.code, w - 2 * pad, Math.round(h * 0.11), 500, MONO); g.fillText(info.code, pad, barH + h * 0.12);
      // status dot + big text
      const bigY = barH + (h - barH) * 0.52;
      g.fillStyle = col; g.beginPath(); g.arc(pad + h * 0.045, bigY, h * 0.045, 0, Math.PI * 2); g.fill();
      fit(g, info.big, w - 2 * pad - h * 0.13, Math.round(h * 0.27), 700, FONT);
      g.fillText(info.big, pad + h * 0.13, bigY + h * 0.01);
      g.fillStyle = pal.mute; fit(g, info.sub || '', w - 2 * pad, Math.round(h * 0.1), 500, FONT);
      g.fillText(info.sub || '', pad, h - h * 0.11);
    });
  }
  function stickerTex(info) {
    return canvasTex(360, 200, (g, w, h) => {
      g.fillStyle = '#FFFDF4'; g.fillRect(0, 0, w, h);
      g.fillStyle = STATUS[info.st] || '#5F6B6A'; g.fillRect(0, 0, w, 46);
      g.fillStyle = '#FFFFFF'; g.textBaseline = 'middle'; g.textAlign = 'center';
      g.font = `700 26px ${FONT}`; g.fillText('ทวนสอบ / สอบเทียบ', w / 2, 24);
      g.fillStyle = '#1C2731'; g.textAlign = 'left';
      const rows = [['รหัส', info.code], ['ล่าสุด', info.last || '—'], ['ครบกำหนด', info.due || '—']];
      rows.forEach((r, n) => {
        const y = 78 + n * 42;
        g.font = `500 22px ${FONT}`; g.fillStyle = '#5B6B78'; g.fillText(r[0], 16, y);
        fit(g, r[1], w - 140, 26, 600, n === 0 ? MONO : FONT); g.fillStyle = '#1C2731'; g.fillText(r[1], 128, y);
        g.fillStyle = '#D9DDD3'; g.fillRect(16, y + 20, w - 32, 1);
      });
      g.strokeStyle = '#B9BFB2'; g.setLineDash([8, 6]); g.lineWidth = 3; g.strokeRect(2, 2, w - 4, h - 4);
    });
  }
  function shadowTex() {
    return canvasTex(256, 256, (g, w, h) => {
      const gr = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
      gr.addColorStop(0, 'rgba(0,0,0,.34)'); gr.addColorStop(0.55, 'rgba(0,0,0,.12)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = gr; g.fillRect(0, 0, w, h);
    });
  }

  /* ---------- procedural instruments (generic shapes per instrument type) ---------- */
  function turbidimeter(info) {
    const G = new THREE.Group();
    const shell = mat(0x3B4756, 0.5), deck = mat(0xC9D0D8, 0.42), dark = mat(0x222A34, 0.45), key = mat(0x2D3541, 0.5);
    G.add(slab(9.6, 22, 3.2, 2.6, 0.7, shell));
    G.add(at(slab(9.0, 20.4, 0.7, 2.2, 0.25, deck), 0, 3.0, 0.2));
    G.add(at(slab(7.2, 5.8, 0.14, 0.5, 0.05, dark), 0, 3.7, -0.8));
    G.add(at(decal(6.6, 5.2, screenTex(info, 'lcd', 660, 520)), 0, 3.86, -0.8));
    [-2.3, 0, 2.3].forEach(x => G.add(at(slab(1.7, 0.75, 0.28, 0.3, 0.1, key), x, 3.68, 2.75)));
    [-0.7, 0.7].forEach(x => G.add(at(slab(1.1, 0.8, 0.28, 0.3, 0.1, key), x, 3.68, 3.95)));
    [-2.8, 0, 2.8].forEach(x => G.add(at(slab(2.3, 1.7, 0.34, 0.6, 0.14, key), x, 3.66, 6.0)));
    G.add(at(cyl(0.55, 0.3, mat(0x2F7FD8, 0.35, 0, { emissive: 0x1d5fa8, emissiveIntensity: 0.35 })), 2.9, 3.66, 8.4));
    // sample-cell compartment with light-shield cap
    G.add(at(slab(6.4, 5.2, 1.8, 1.4, 0.35, dark), 0, 3.6, -7.4));
    G.add(at(cyl(2.0, 1.7, mat(0x353E4A, 0.38)), 0, 5.3, -7.4));
    G.add(at(cyl(2.12, 0.28, mat(0x2A323C, 0.4)), 0, 6.95, -7.4));
    // calibration sticker on the right side
    const st = decal(3.1, 1.72, stickerTex(info));
    st.geometry.rotateX(Math.PI / 2); st.geometry.rotateY(Math.PI / 2);
    G.add(at(st, 4.815, 1.6, 3.4));
    return { group: G, tilt: 0, view: new THREE.Vector3(0.5, 0.62, 1) };
  }

  function colorimeter(info) {
    const G = new THREE.Group();
    const body = mat(0x2E3237, 0.62), gloss = mat(0x111316, 0.18, 0.1), bez = mat(0xC5CAD0, 0.4);
    G.add(slab(6.4, 15, 2.8, 2.5, 0.75, body));
    G.add(at(slab(5.4, 4.8, 0.14, 1.7, 0.05, gloss), 0, 2.78, -4.7));
    G.add(at(slab(4.8, 2.1, 0.1, 0.3, 0.03, bez), 0, 2.78, -0.9));
    G.add(at(decal(4.3, 1.6, screenTex(info, 'seg', 640, 240)), 0, 2.9, -0.9));
    [[-1.65, 0x3F8FD6], [0, 0x23272B], [1.65, 0x8DBB3F]].forEach(([x, c]) => G.add(at(cyl(0.62, 0.32, mat(c, 0.35)), x, 2.7, 1.6)));
    G.add(at(cyl(0.48, 0.3, mat(0x23272B, 0.4)), 0, 2.7, 3.4));
    // sample cell holder at the top end
    const cell = cyl(1.25, 1.6, mat(0x1A1D20, 0.4)); cell.geometry.rotateX(-Math.PI / 2);
    G.add(at(cell, 0, 1.4, -7.3));
    const cap = cyl(1.38, 0.7, mat(0x2A2E33, 0.45)); cap.geometry.rotateX(-Math.PI / 2);
    G.add(at(cap, 0, 1.4, -8.85));
    G.add(at(decal(3.9, 2.15, stickerTex(info)), 0, 2.82, 5.5));
    return { group: G, tilt: 1.22, view: new THREE.Vector3(0.45, 0.28, 1) };
  }

  function meter(info) {
    const G = new THREE.Group();
    const boot = mat(0x2A2F34, 0.85), face = mat(0x9AA7B4, 0.42), dark = mat(0x121417, 0.25), key = mat(0x2C333A, 0.5);
    G.add(slab(8.4, 17, 3.3, 2.7, 0.9, boot));
    G.add(at(slab(7.0, 15.2, 0.24, 2.0, 0.08, face), 0, 3.12, 0));
    G.add(at(slab(6.2, 5.4, 0.12, 0.45, 0.03, dark), 0, 3.34, -3.9));
    G.add(at(decal(5.6, 4.8, screenTex(info, 'color', 600, 514)), 0, 3.47, -3.9));
    [-2.1, 2.1].forEach(x => G.add(at(slab(1.5, 0.85, 0.26, 0.3, 0.1, key), x, 3.32, 0.4)));
    G.add(at(cyl(1.65, 0.24, key), 0, 3.32, 2.6));
    G.add(at(cyl(0.55, 0.34, mat(0xBAC4CE, 0.4)), 0, 3.32, 2.6));
    G.add(at(cyl(0.6, 0.3, mat(0x2F7FD8, 0.35, 0, { emissive: 0x1d5fa8, emissiveIntensity: 0.35 })), 0, 3.32, 4.9));
    G.add(at(decal(3.6, 2.0, stickerTex(info)), 0, 3.38, 6.35));
    return { group: G, tilt: 1.22, view: new THREE.Vector3(0.5, 0.3, 1), probe: info.probe };
  }

  function probe(kind, from) {
    const G = new THREE.Group();
    const body = mat(0x24292E, 0.55);
    const len = 9, r = 0.62;
    const p = cyl(r, len, body); p.geometry.rotateZ(-Math.PI / 2); // along +x from 0..len
    G.add(p);
    const tipX = len;
    if (kind === 'ph') {
      const guard = cyl(r * 0.85, 1.2, mat(0x2E3640, 0.4)); guard.geometry.rotateZ(-Math.PI / 2);
      G.add(at(guard, tipX, 0, 0));
      const bulb = new THREE.Mesh(keep(new THREE.SphereGeometry(0.42, 24, 16)), mat(0xE8F4F8, 0.05, 0, { transparent: true, opacity: 0.55 }));
      G.add(at(bulb, tipX + 1.35, 0, 0));
    } else if (kind === 'ec') {
      for (let n = 0; n < 4; n++) {
        const ring = cyl(r * 1.02, 0.22, mat(0xB8C0C8, 0.25, 0.8)); ring.geometry.rotateZ(-Math.PI / 2);
        G.add(at(ring, tipX - 1.9 + n * 0.5, 0, 0));
      }
    } else {
      const cap = cyl(r * 1.08, 1.3, mat(0x3F7FBF, 0.45)); cap.geometry.rotateZ(-Math.PI / 2);
      G.add(at(cap, tipX, 0, 0));
    }
    const lab = cyl(r * 1.01, 1.6, mat(0xE7ECEF, 0.5)); lab.geometry.rotateZ(-Math.PI / 2);
    G.add(at(lab, 1.4, 0, 0));
    G.rotation.y = 0.3;
    G.position.set(from.x + 4.2, r, from.z - 1.2);
    // cable from the meter to the probe
    G.updateMatrixWorld(true);
    const end = new THREE.Vector3(0, 0, 0).applyMatrix4(G.matrixWorld);
    const curve = new THREE.CatmullRomCurve3([
      from.clone(), from.clone().add(new THREE.Vector3(0.3, -1.0, 1.3)),
      new THREE.Vector3(from.x + 1.6, 0.25, from.z + 2.4), new THREE.Vector3(end.x - 1.4, 0.25, end.z + 1.2),
      end.clone().add(new THREE.Vector3(-0.3, 0, 0.1))
    ]);
    const cable = new THREE.Mesh(keep(new THREE.TubeGeometry(curve, 80, 0.17, 10, false)), mat(0x15181B, 0.6));
    return [G, cable];
  }

  function generic(info) {
    const r = meter(Object.assign({}, info)); r.probe = null; return r;
  }

  function build(info) {
    const spec = ({ turbidimeter, colorimeter, meter })[info.kind] || generic;
    const s = spec(info);
    const root = new THREE.Group();
    s.group.rotation.x = s.tilt;
    root.add(s.group);
    s.group.updateMatrixWorld(true);
    let box = new THREE.Box3().setFromObject(s.group);
    s.group.position.y -= box.min.y;
    s.group.updateMatrixWorld(true);
    if (s.probe) {
      const from = s.group.localToWorld(new THREE.Vector3(0, 1.6, 8.4));
      probe(s.probe, from).forEach(o => root.add(o));
    }
    return { root, view: s.view };
  }

  /* ---------- scene framing ---------- */
  function frame(root, view) {
    const box = new THREE.Box3().setFromObject(root);
    const size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3());
    const c0 = center.clone();
    root.position.x -= c0.x; root.position.z -= c0.z;
    center.x = 0; center.z = 0;
    const shadow = new THREE.Mesh(keep(new THREE.PlaneGeometry(1, 1)), keep(new THREE.MeshBasicMaterial({ map: shadowTex(), transparent: true, depthWrite: false })));
    shadow.rotation.x = -Math.PI / 2; shadow.position.set(c0.x, 0.02, c0.z);
    shadow.scale.set(Math.max(size.x, size.z) * 1.5, Math.max(size.x, size.z) * 1.5, 1);
    root.add(shadow);
    const radius = size.length() / 2;
    center.y *= 0.82; // keep the model clear of the caption bar
    V.home = { target: center.clone(), dir: view.clone().normalize(), radius };
    V.controls.minDistance = radius * 1.3; V.controls.maxDistance = radius * 5;
    V.controls.maxPolarAngle = Math.PI * 0.49;
    resetView();
  }
  function placeCamera() {
    if (!V.home) return;
    const vf = THREE.MathUtils.degToRad(V.camera.fov);
    const hf = 2 * Math.atan(Math.tan(vf / 2) * V.camera.aspect);
    const dist = V.home.radius / Math.sin(Math.min(vf, hf) / 2) * 0.74;
    V.camera.position.copy(V.home.target).addScaledVector(V.home.dir, dist);
    V.controls.target.copy(V.home.target);
    V.controls.update();
  }
  function resetView() { if (!V.home) return; V.controls.autoRotate = !reduceMotion; placeCamera(); }

  function resize() {
    if (!V.host || !V.renderer) return;
    const w = V.host.clientWidth, h = V.host.clientHeight; if (!w || !h) return;
    V.renderer.setSize(w, h, false);
    V.camera.aspect = w / h; V.camera.updateProjectionMatrix();
  }
  function loop() {
    V.raf = requestAnimationFrame(loop);
    if (document.hidden) return;
    V.controls.update();
    V.renderer.render(V.scene, V.camera);
  }

  function clearModel() {
    if (V.model) V.scene.remove(V.model);
    bag.forEach(o => { try { o.dispose(); } catch (e) {} });
    bag = []; V.model = null;
  }
  function fitGltf(obj) { // scale an arbitrary GLB to ~17 units and stand it on the ground
    const box = new THREE.Box3().setFromObject(obj), size = box.getSize(new THREE.Vector3());
    const k = 17 / Math.max(size.x, size.y, size.z, 0.001);
    obj.scale.setScalar(k); obj.updateMatrixWorld(true);
    const b2 = new THREE.Box3().setFromObject(obj), c = b2.getCenter(new THREE.Vector3());
    obj.position.x -= c.x; obj.position.z -= c.z; obj.position.y -= b2.min.y;
    const root = new THREE.Group(); root.add(obj); return root;
  }

  /* ---------- public API ---------- */
  async function mount(host, info) {
    const token = ++V.token;
    if (!webglOK()) return { ok: false, error: 'อุปกรณ์นี้แสดงภาพ 3D ไม่ได้' };
    try { await Promise.all([loadThree(), fontsReady()]); }
    catch (e) { return { ok: false, error: 'โหลดตัวแสดงผล 3D ไม่ได้ ตรวจสอบอินเทอร์เน็ต' }; }
    if (token !== V.token) return { ok: false, cancelled: true };
    ensureRenderer();
    clearModel();
    V.host = host;
    host.appendChild(V.renderer.domElement);
    if (V.ro) V.ro.disconnect();
    V.ro = new ResizeObserver(() => { resize(); placeCamera(); });
    V.ro.observe(host);
    resize();

    let note = '';
    if (info.model3d) {
      try {
        const gltf = await new Promise((res, rej) => new THREE.GLTFLoader().load(info.model3d, res, undefined, rej));
        if (token !== V.token) return { ok: false, cancelled: true };
        gltf.scene.traverse(o => { if (o.isMesh) { keep(o.geometry); [].concat(o.material).forEach(m => keep(m)); } });
        V.model = fitGltf(gltf.scene);
        V.scene.add(V.model); frame(V.model, new THREE.Vector3(0.5, 0.35, 1));
        note = 'gltf';
      } catch (e) { console.warn(e); note = 'gltf-failed'; }
    }
    if (!V.model) {
      const b = build(info);
      V.model = b.root; V.scene.add(V.model); frame(V.model, b.view);
    }
    cancelAnimationFrame(V.raf); loop();
    return { ok: true, source: note === 'gltf' ? 'file' : 'generic', gltfFailed: note === 'gltf-failed' };
  }
  function unmount() {
    V.token++;
    cancelAnimationFrame(V.raf); V.raf = 0;
    if (V.ro) { V.ro.disconnect(); V.ro = null; }
    if (V.renderer && V.renderer.domElement.parentNode) V.renderer.domElement.parentNode.removeChild(V.renderer.domElement);
    if (V.scene) clearModel();
    V.host = null;
  }
  window.Instrument3D = { supported: webglOK(), mount, unmount, reset: resetView };
})();
