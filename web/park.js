// Paseo park: the Router's fleet as a Stardew-like farm town. The Router is the town hall on the square, every machine a
// fenced farm joined to it by a road, every session a cottage with its agent at the door, every task a crate on the belts.
// The sky follows the clock, season and weather of the place the Router is configured for (else this computer's clock).
// Pure presentation over the same data the console loads; it never changes routing.
import * as THREE from '/vendor/three-0.186.1/three.module.js';
import { createViews, loginState, providerName } from '/views.js';

const $ = (s, root = document) => root.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ACTIVE = new Set(['sending', 'accepted', 'running', 'waiting_permission', 'cancel_requested', 'delivery_unknown']);
const TERMINAL = new Set(['completed', 'failed', 'canceled']);
const ATTENTION = new Set(['waiting_permission', 'delivery_unknown']);
const CLIENT_COLORS = { muse: '#2f9e7e', grokbot: '#d9962b', dot: '#8467c9', cli: '#5f6f86', web: '#c4607f', planner: '#3f7fbf', router: '#7b8794' };
const CLIENT_NAMES = { muse: 'Muse', grokbot: 'Grokbot', dot: 'dot', cli: 'CLI', web: '網頁', planner: '規劃者', router: 'Router' };
const STATE_NAMES = { permission: '等審批', queued: '排隊', sending: '送出中', accepted: '已接收', running: '運行中', waiting_permission: '等審批', delivery_unknown: '送達未知', cancel_requested: '取消中', completed: '完成', failed: '失敗', canceled: '已取消', idle: '待命', error: '出錯', closed: '已關閉', initializing: '啟動中' };
const providerOf = s => (s.provider || '').split('/')[0].toLowerCase();
const PROVIDERS = {
    claude: { name: 'Claude Code', roof: '#cf6e45', body: '#e07a45', ring: '#f2a07a' },
    codex: { name: 'Codex', roof: '#5f58c9', body: '#8c84ff', ring: '#b3adff' },
    other: { name: 'Agent', roof: '#3f8f7f', body: '#5fb8a2', ring: '#9ad8c8' },
};
const provider = s => PROVIDERS[providerOf(s)] ?? PROVIDERS.other;
const nameOf = s => s.displayName || s.worker?.alias || s.title || s.nativeId;
const clientColor = k => CLIENT_COLORS[k] ?? '#7b8794';
const clientName = k => CLIENT_NAMES[k] ?? k;
function rng(seed) { let a = 0; for (const c of String(seed)) a = (a * 31 + c.charCodeAt(0)) | 0; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const HOME_AZIMUTH = -0.62, FRONT = Math.atan2(Math.cos(HOME_AZIMUTH), Math.sin(HOME_AZIMUTH));
const startOfDay = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };
/** A task's one-line name: a handoff's objective, a service turn's service and the call it answers (its first line is only
 * the Router's header), otherwise the first line of the prompt. */
function taskTitle(t) {
    const p = String(t.prompt ?? ''), objective = t.dependencyId ? /^Objective: (.+)$/m.exec(p)?.[1] : null;
    const svc = t.routerTurn === 'service' ? /^You are the ([a-z0-9-]+) service/m.exec(p)?.[1] : null, call = svc && /^\[Router\] 服務呼叫 (\S+?)(（續）)?$/m.exec(p);
    if (svc) return `服務 ${svc} · 回答 ${call?.[1] ?? t.askOf ?? ''}${call?.[2] ?? ''}`;
    return (objective ?? p.split('\n').find(l => l.trim()) ?? '(空白指令)').trim();
}
/** Signs and titles need a few words, not the whole instruction: the first clause, capped by display width (CJK counts double). */
function shortTitle(text, maxUnits = 28) {
    const line = String(text ?? '').split('\n').map(l => l.trim()).find(Boolean) ?? '';
    const clause = line.split(/[：:，,。；;（(！!？?]|—| - /)[0].trim(), base = clause.length >= 4 ? clause : line;
    let units = 0, out = '';
    for (const ch of base) { units += /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/.test(ch) ? 2 : 1; if (units > maxUnits) return out.trimEnd() + '…'; out += ch; }
    return out || '(空白指令)';
}
function relTime(ts) {
    const s = Math.max(0, (Date.now() - ts) / 1000);
    if (s < 45) return '剛剛'; if (s < 3600) return `${Math.round(s / 60)} 分鐘前`; if (s < 86400) return `${Math.round(s / 3600)} 小時前`;
    const d = new Date(ts); return `${d.getMonth() + 1}月${d.getDate()}日`;
}
const fmtTime = ts => new Date(ts).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
function fmtDur(ms) { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? `${s} 秒` : s < 3600 ? `${Math.floor(s / 60)} 分 ${s % 60} 秒` : `${Math.floor(s / 3600)} 小時 ${Math.round((s % 3600) / 60)} 分`; }
const taskCls = state => state === 'completed' ? 'done' : state === 'queued' ? 'queue' : ATTENTION.has(state) ? 'warn' : state === 'failed' ? 'err' : state === 'canceled' ? 'off' : 'run';

// ---------- the look: a Stardew-like farm drawn in pixels over a 3D world ----------
// Materials are cel-shaded in three light steps. Tiles are tiny pixel-art textures painted in greys, so one tile serves every
// colour and season: the material colour tints it, and snow is the same grass tinted white. The frame loop draws the scene
// small, outlines silhouettes and scales it up without smoothing.
const TOON_STEPS = (() => { const t = new THREE.DataTexture(new Uint8Array([110, 186, 255]), 3, 1, THREE.RedFormat); t.minFilter = t.magFilter = THREE.NearestFilter; t.generateMipmaps = false; t.needsUpdate = true; return t; })();
function toon({ roughness, metalness, flatShading, ...opts } = {}) { return new THREE.MeshToonMaterial({ gradientMap: TOON_STEPS, ...opts }); }
const matCache = new Map();
function mat(color, opts = {}) {
    const key = color + JSON.stringify(opts, (k, v) => v?.isTexture ? v.uuid : v);
    if (!matCache.has(key)) matCache.set(key, toon({ color, ...opts }));
    return matCache.get(key);
}
/** A pixel-art tile: painted texel by texel on a tiny canvas, repeated, magnified without smoothing. `dot` wraps at the edges. */
function pixelTexture(seed, w, h, paint, wrap = true) {
    const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d');
    const dot = (x, y, color, pw = 1, ph = 1) => { g.fillStyle = color; g.fillRect(x, y, pw, ph); if (wrap && x + pw > w) g.fillRect(x - w, y, pw, ph); if (wrap && y + ph > h) g.fillRect(x, y - h, pw, ph); };
    paint(dot, rng(seed), w, h);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.magFilter = THREE.NearestFilter;
    if (wrap) t.wrapS = t.wrapT = THREE.RepeatWrapping; else t.minFilter = THREE.NearestFilter;
    return t;
}
const rnd = (r, n) => Math.floor(r() * n);
const TEX = {
    grass: pixelTexture('grass', 32, 32, (dot, r, w) => {
        dot(0, 0, '#e9e9e9', w, w);
        for (let i = 0; i < 170; i++) dot(rnd(r, w), rnd(r, w), r() < 0.55 ? '#d4d4d4' : '#f7f7f7');
        for (let i = 0; i < 16; i++) { const x = rnd(r, w), y = rnd(r, w); dot(x, y, '#b9b9b9'); dot(x + 2, y, '#b9b9b9'); dot(x + 1, y + 1, '#c6c6c6'); }
    }),
    cobble: pixelTexture('cobble', 32, 32, (dot, r, w) => {
        dot(0, 0, '#8f8f8f', w, w);
        for (let row = 0; row < 4; row++) for (let col = 0; col < 4; col++) {
            const x = col * 8 + (row % 2) * 4, y = row * 8; dot(x + 1, y + 1, ['#cfcfcf', '#c1c1c1', '#dadada'][rnd(r, 3)], 6, 6); dot(x + 1, y + 6, '#a9a9a9', 6, 1); dot(x + 2, y + 2, '#eeeeee', 2, 1);
        }
    }),
    sand: pixelTexture('sand', 32, 32, (dot, r, w) => {
        dot(0, 0, '#e3e3e3', w, w);
        for (let i = 0; i < 130; i++) dot(rnd(r, w), rnd(r, w), r() < 0.6 ? '#cfcfcf' : '#f3f3f3');
        for (let i = 0; i < 9; i++) { const x = rnd(r, w), y = rnd(r, w); dot(x, y, '#a6a6a6', 2, 1); dot(x, y - 1, '#f5f5f5', 2, 1); }
    }),
    soil: pixelTexture('soil', 16, 16, (dot, r, w) => {
        dot(0, 0, '#d2d2d2', w, w);
        for (let y = 0; y < w; y += 4) { dot(0, y + 2, '#979797', w, 1); dot(0, y + 3, '#afafaf', w, 1); }
        for (let i = 0; i < 16; i++) dot(rnd(r, w), rnd(r, w), '#e8e8e8');
    }),
    planks: pixelTexture('planks', 16, 16, (dot, r, w) => {
        dot(0, 0, '#d9d9d9', w, w);
        for (let y = 0; y < w; y += 4) { dot(0, y, '#eeeeee', w, 1); dot(0, y + 3, '#9b9b9b', w, 1); dot((y * 5 + 3) % w, y, '#9b9b9b', 1, 3); }
        for (let i = 0; i < 10; i++) dot(rnd(r, w), rnd(r, w), '#c5c5c5');
    }),
    shingles: pixelTexture('shingles', 16, 16, (dot, r, w) => {
        dot(0, 0, '#d3d3d3', w, w);
        for (let y = 0; y < w; y += 4) { dot(0, y, '#ededed', w, 1); dot(0, y + 3, '#8a8a8a', w, 1); for (let x = y % 8 ? 2 : 6; x < w; x += 8) dot(x, y, '#9a9a9a', 1, 3); }
    }),
    // coloured, not tinted
    crate: pixelTexture('crate', 16, 16, (dot) => {
        dot(0, 0, '#c99355', 16, 16); for (let y = 4; y < 16; y += 5) dot(1, y, '#9b6a37', 14, 1);
        for (let i = 2; i < 14; i++) dot(i, i, '#8c5c2d');
        dot(0, 0, '#6b4221', 16, 1); dot(0, 15, '#6b4221', 16, 1); dot(0, 0, '#6b4221', 1, 16); dot(15, 0, '#6b4221', 1, 16); dot(1, 1, '#e2b071', 14, 1);
    }),
    water: pixelTexture('water', 32, 32, (dot, r, w) => {
        dot(0, 0, '#3e8ed4', w, w);
        for (let i = 0; i < 24; i++) dot(rnd(r, w), rnd(r, w), '#7cc2f2', 3, 1);
        for (let i = 0; i < 16; i++) dot(rnd(r, w), rnd(r, w), '#2f75b9', 2, 1);
    }),
    belt: pixelTexture('belt', 16, 32, (dot, r, w, h) => {
        dot(0, 0, '#8b5b33', w, h);
        for (let y = 0; y < h; y += 8) { dot(0, y, '#57381d', w, 1); dot(0, y + 1, '#a9753f', w, 1); }
        for (let i = 0; i < 12; i++) dot(rnd(r, w), rnd(r, h), '#764a26');
    }),
    // a speech bubble with "!", Stardew's sign that someone wants you
    alert: pixelTexture('alert', 12, 14, (dot) => {
        const ink = '#3b2412', paper = '#fff6dc', mark = '#e8742a';
        dot(2, 0, ink, 8, 1); dot(1, 1, ink); dot(10, 1, ink); dot(0, 2, ink, 1, 7); dot(11, 2, ink, 1, 7); dot(1, 9, ink); dot(10, 9, ink); dot(2, 10, ink, 2, 1); dot(7, 10, ink, 3, 1);
        dot(4, 10, ink); dot(4, 11, ink); dot(5, 12, ink); dot(6, 11, ink); dot(6, 10, paper); dot(5, 10, paper, 1, 2);
        dot(2, 1, paper, 8, 1); dot(1, 2, paper, 10, 7); dot(2, 9, paper, 8, 1);
        dot(5, 2, mark, 2, 4); dot(5, 7, mark, 2, 1); dot(5, 2, '#f7b25a', 1, 3);
    }, false),
    // the same bubble with three dots: this agent asked a service and waits for the answer
    wait: pixelTexture('wait', 12, 14, (dot) => {
        const ink = '#3b2412', paper = '#fff6dc', mark = '#3b6fb3';
        dot(2, 0, ink, 8, 1); dot(1, 1, ink); dot(10, 1, ink); dot(0, 2, ink, 1, 7); dot(11, 2, ink, 1, 7); dot(1, 9, ink); dot(10, 9, ink); dot(2, 10, ink, 2, 1); dot(7, 10, ink, 3, 1);
        dot(4, 10, ink); dot(4, 11, ink); dot(5, 12, ink); dot(6, 11, ink); dot(6, 10, paper); dot(5, 10, paper, 1, 2);
        dot(2, 1, paper, 8, 1); dot(1, 2, paper, 10, 7); dot(2, 9, paper, 8, 1);
        for (const x of [2, 5, 8]) dot(x, 5, mark, 2, 2);
    }, false),
    // light pooled under a lamp at night: three stepped rings, like painted light
    pool: (() => {
        const c = document.createElement('canvas'); c.width = c.height = 32; const g = c.getContext('2d');
        for (const [rad, a] of [[16, 0.16], [12, 0.26], [7, 0.4]]) { g.fillStyle = `rgba(255,255,255,${a})`; g.beginPath(); g.arc(16, 16, rad, 0, Math.PI * 2); g.fill(); }
        const t = new THREE.CanvasTexture(c); t.magFilter = t.minFilter = THREE.NearestFilter; return t;
    })(),
};
/** A box whose faces repeat a tile every `unit` world units, so planks and stones keep one size on every mesh. */
function box(w, h, d, unit = 0) {
    const geo = new THREE.BoxGeometry(w, h, d); if (!unit) return geo;
    const uv = geo.attributes.uv, dims = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
    for (let f = 0; f < 6; f++) for (let i = 0; i < 4; i++) { const k = f * 4 + i; uv.setXY(k, uv.getX(k) * dims[f][0] / unit, uv.getY(k) * dims[f][1] / unit); }
    return geo;
}
/** Cylinder caps and circles map 0–1 across their diameter; this repeats the tile every `unit` instead. */
function tiled(geo, size, unit) { const uv = geo.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * size / unit, uv.getY(i) * size / unit); return geo; }
/** Seasons by the place's calendar (turned six months south of the equator). Grass and crowns are the colours a texture is tinted with. */
const SEASONS = {
    spring: { name: '春', grass: '#93d461', isle: '#8acb58', crowns: ['#6cbc46', '#7ecb55', '#f7b9cf', '#f2a2c0', '#fbcfe0'], flowers: ['#f7a8c8', '#fff0a0', '#ffffff', '#c6a8f4'], drift: ['#fbd2e1', '#f7b9cf', '#ffffff'] },
    summer: { name: '夏', grass: '#6dc24f', isle: '#64b848', crowns: ['#3f9a3a', '#4fab43', '#398c34', '#62b94c'], flowers: ['#ffd23f', '#6aa8f0', '#ff8463', '#ffffff'], drift: [] },
    autumn: { name: '秋', grass: '#b9c062', isle: '#adb85a', crowns: ['#e8862f', '#d95c2c', '#f2b13f', '#c99c2c', '#e8862f'], flowers: ['#d95c2c', '#f2b13f', '#b6662a', '#f1e3c1'], drift: ['#e8862f', '#d95c2c', '#f2b13f', '#b6662a'] },
    winter: { name: '冬', grass: '#b4b996', isle: '#aab28c', crowns: [], bare: true, flowers: [], drift: [] },
};
const SNOW = new THREE.Color('#f4f8fb');
/** Crowns turn white when it snows; their materials remember the season's colour. */
const crownCache = new Map();
function crown(color) { if (!crownCache.has(color)) { const m = toon({ color }); m.userData.base = color; crownCache.set(color, m); } return crownCache.get(color); }
const WINDOW = toon({ color: '#41639b', emissive: '#ffc964', emissiveIntensity: 0 });
const LANTERN = toon({ color: '#fff0c4', emissive: '#ffbf55', emissiveIntensity: 0.2 });
const POOL = new THREE.MeshBasicMaterial({ map: TEX.pool, color: '#ffb35c', transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, fog: false });
const POOL_GEO = new THREE.PlaneGeometry(5, 5).rotateX(-Math.PI / 2);

/** Weather icons for the clock, drawn as 9×9 pixel art and rendered as crisp SVG squares. */
const ICON_INK = { o: '#f0a030', y: '#f5c542', Y: '#ffe68a', m: '#e3cf78', M: '#fff3b8', w: '#aebccb', W: '#ffffff', g: '#8b97a6', G: '#cbd3dc', b: '#4d97e6', s: '#8fc1f2', f: '#b8c3ce' };
const ICON_ART = {
    sun: ['....o....', '.o.....o.', '...yyy...', '..yYYYy..', 'o.yYYYy.o', '..yYYYy..', '...yyy...', '.o.....o.', '....o....'],
    moon: ['...mmm...', '..mMM....', '.mMM.....', '.mM......', '.mM......', '.mMM....m', '..mMMMMm.', '...mmmm..', '.........'],
    cloud: ['.........', '.........', '...www...', '..wWWWw..', '.wWWWWWww', 'wWWWWWWWw', 'wwwwwwwww', '.........', '.........'],
    partly: ['.....o...', '..o.yyy.o', '...yYYYy.', '...wwwYy.', '..wWWWwy.', '.wWWWWWww', 'wWWWWWWWw', 'wwwwwwwww', '.........'],
    rain: ['...ggg...', '..gGGGg..', '.gGGGGGgg', 'gGGGGGGGg', 'ggggggggg', '.b...b...', '...b...b.', '.b...b...', '.........'],
    snow: ['...ggg...', '..gGGGg..', '.gGGGGGgg', 'gGGGGGGGg', 'ggggggggg', '.s..s..s.', '.........', '...s..s..', '.........'],
    storm: ['...ggg...', '..gGGGg..', '.gGGGGGgg', 'gGGGGGGGg', 'gggyyyggg', '....yy...', '...yy....', '..yyyy...', '...y.....'],
    fog: ['.........', '.fffffff.', '.........', 'fffffff..', '.........', '..fffffff', '.........', '.fffffff.', '.........'],
};
function pixelIcon(name) {
    let rects = ''; (Object.hasOwn(ICON_ART, name) ? ICON_ART[name] : ICON_ART.sun).forEach((row, y) => [...row].forEach((ch, x) => { if (ICON_INK[ch]) rects += `<rect x="${x}" y="${y}" width="1" height="1" fill="${ICON_INK[ch]}"/>`; }));
    return `<svg class="px-icon" viewBox="0 0 9 9" shape-rendering="crispEdges" aria-hidden="true">${rects}</svg>`;
}

// ---------- geometry builders ----------
/** Round broadleaf crowns in the season's colours, or a pine; in winter the broadleaves stand bare. */
function tree(r, pos, season) {
    const g = new THREE.Group(), h = 1.2 + r() * 1.6, s = 0.9 + r() * 0.9, pine = r() < 0.33 || (season.bare && r() < 0.45);
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.14 * s, 0.22 * s, h, 6), mat('#7a5030')); trunk.position.y = h / 2; trunk.castShadow = true; g.add(trunk);
    if (pine) {
        const shade = crown(r() < 0.5 ? '#3d7a4a' : '#478959');
        for (let i = 0; i < 3; i++) { const cone = new THREE.Mesh(new THREE.ConeGeometry((1.35 - i * 0.32) * s, 1.3 * s, 8), shade); cone.position.y = h + 0.3 * s + i * 0.62 * s; cone.castShadow = true; g.add(cone); }
    } else if (season.bare) {
        for (let i = 0; i < 3; i++) { const b = new THREE.Mesh(new THREE.CylinderGeometry(0.04 * s, 0.08 * s, 0.9 * s, 4), mat('#7a5030')); const a = i * 2.1 + r(); b.position.set(Math.cos(a) * 0.25 * s, h + 0.25 * s, Math.sin(a) * 0.25 * s); b.rotation.set(Math.sin(a) * 0.7, 0, -Math.cos(a) * 0.7); g.add(b); }
    } else {
        const shade = crown(season.crowns[rnd(r, season.crowns.length)]);
        for (let i = 0; i < 3; i++) { const blob = new THREE.Mesh(new THREE.IcosahedronGeometry((0.85 + r() * 0.45) * s, 1), shade); blob.position.set((r() - 0.5) * 0.9 * s, h + 0.55 * s + r() * 0.6 * s, (r() - 0.5) * 0.9 * s); blob.castShadow = true; g.add(blob); }
    }
    g.position.copy(pos); g.rotation.y = r() * Math.PI * 2; return g;
}
/** A lantern on a post; at night it lights a stepped pool of warm light on the ground around it. An unlit one stays dark. */
function lamp(lit = true) {
    const g = new THREE.Group();
    const post = new THREE.Mesh(box(0.16, 1.7, 0.16), mat('#4a3a33')); post.position.y = 0.85; post.castShadow = true; g.add(post);
    const lantern = new THREE.Mesh(box(0.42, 0.46, 0.42), lit ? LANTERN : mat('#9a948a')); lantern.position.y = 1.9; g.add(lantern);
    const cap = new THREE.Mesh(new THREE.ConeGeometry(0.4, 0.3, 4), mat('#4a3a33')); cap.rotation.y = Math.PI / 4; cap.position.y = 2.28; g.add(cap);
    if (lit) { const pool = new THREE.Mesh(POOL_GEO, POOL); pool.position.y = 0.2; pool.renderOrder = 1; g.add(pool); }
    return g;
}
function bench(color = '#9a6b45') {
    const g = new THREE.Group(), wood = mat(color, { map: TEX.planks }), seat = new THREE.Mesh(box(1.1, 0.08, 0.35, 0.6), wood); seat.position.y = 0.32; g.add(seat);
    const back = new THREE.Mesh(box(1.1, 0.3, 0.06, 0.6), wood); back.position.set(0, 0.5, -0.15); g.add(back);
    for (const x of [-0.45, 0.45]) { const leg = new THREE.Mesh(box(0.06, 0.32, 0.3), mat('#4a3a33')); leg.position.set(x, 0.16, 0); g.add(leg); }
    g.traverse(o => { if (o.isMesh) o.castShadow = true; }); return g;
}
/** A wooden fence round a circle, posts and two rails, open where `gap` (an angle) lets the path in. Instanced: two draw calls. */
function fenceRing(radius, gap) {
    const n = Math.max(8, Math.round((2 * Math.PI * radius) / 1.35)), angle = i => (i / n) * Math.PI * 2;
    const open = i => gap !== null && Math.abs(Math.atan2(Math.sin(angle(i) - gap), Math.cos(angle(i) - gap))) < 1.5 / radius + 0.08;
    const posts = [...Array(n).keys()].filter(i => !open(i)), rails = posts.filter(i => !open((i + 1) % n)), wood = mat('#9a6638', { map: TEX.planks }), o = new THREE.Object3D(), g = new THREE.Group();
    const postMesh = new THREE.InstancedMesh(box(0.18, 0.95, 0.18, 0.5), wood, posts.length), railMesh = new THREE.InstancedMesh(box(1, 0.1, 0.08, 0.5), wood, rails.length * 2);
    posts.forEach((i, k) => { o.position.set(Math.cos(angle(i)) * radius, 0.47, Math.sin(angle(i)) * radius); o.rotation.set(0, -angle(i), 0); o.scale.set(1, 1, 1); o.updateMatrix(); postMesh.setMatrixAt(k, o.matrix); });
    rails.forEach((i, k) => {
        const a = angle(i), b = angle(i + 1), mid = (a + b) / 2, chord = 2 * radius * Math.sin((b - a) / 2);
        for (const [j, y] of [[0, 0.32], [1, 0.68]]) { o.position.set(Math.cos(mid) * radius * Math.cos((b - a) / 2), y, Math.sin(mid) * radius * Math.cos((b - a) / 2)); o.rotation.set(0, -mid - Math.PI / 2, 0); o.scale.set(chord, 1, 1); o.updateMatrix(); railMesh.setMatrixAt(k * 2 + j, o.matrix); }
    });
    for (const m of [postMesh, railMesh]) { m.castShadow = true; m.receiveShadow = true; g.add(m); }
    return g;
}
/** The same fence along a straight run from `a` to `b` (local x/z), for the farm field. */
function fenceLine(a, b) {
    const len = a.distanceTo(b), n = Math.max(1, Math.round(len / 1.35)), dir = b.clone().sub(a), yaw = -Math.atan2(dir.z, dir.x), wood = mat('#9a6638', { map: TEX.planks }), o = new THREE.Object3D(), g = new THREE.Group();
    const posts = new THREE.InstancedMesh(box(0.18, 0.95, 0.18, 0.5), wood, n + 1), rails = new THREE.InstancedMesh(box(len / n, 0.1, 0.08, 0.5), wood, n * 2);
    for (let i = 0; i <= n; i++) { o.position.copy(a).lerp(b, i / n).setY(0.47); o.rotation.set(0, yaw, 0); o.updateMatrix(); posts.setMatrixAt(i, o.matrix); }
    for (let i = 0; i < n; i++) for (const [j, y] of [[0, 0.32], [1, 0.68]]) { o.position.copy(a).lerp(b, (i + 0.5) / n).setY(y); o.rotation.set(0, yaw, 0); o.updateMatrix(); rails.setMatrixAt(i * 2 + j, o.matrix); }
    for (const m of [posts, rails]) { m.castShadow = true; g.add(m); }
    return g;
}
function claudeCritter(color) {
    const g = new THREE.Group(), body = new THREE.Mesh(new THREE.BoxGeometry(1.05, 0.78, 0.82), mat(color));
    body.position.y = 0.62; body.castShadow = true; g.add(body);
    for (const x of [-0.24, 0.24]) { const eye = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.16, 0.04), mat('#2d2522')); eye.position.set(x, 0.72, 0.42); g.add(eye); }
    for (const x of [-0.6, 0.6]) { const arm = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.18, 0.3), mat(color)); arm.position.set(x, 0.58, 0); g.add(arm); }
    for (const [x, z] of [[-0.3, -0.25], [0.3, -0.25], [-0.3, 0.25], [0.3, 0.25]]) { const leg = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.24, 0.16), mat(color)); leg.position.set(x, 0.12, z); g.add(leg); }
    return g;
}
function codexCloud(color) {
    const g = new THREE.Group(), m = toon({ color, emissive: color, emissiveIntensity: 0.12 });
    for (const [x, y, z, r] of [[0, 0.95, 0, 0.55], [-0.45, 0.82, 0.05, 0.4], [0.45, 0.85, 0, 0.42], [0.15, 1.25, -0.05, 0.38], [-0.2, 1.2, 0.1, 0.33]]) { const p = new THREE.Mesh(new THREE.SphereGeometry(r, 14, 10), m); p.position.set(x, y, z); p.castShadow = true; g.add(p); }
    const chevron = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.07, 0.04), mat('#f4f1ff')); chevron.position.set(-0.08, 0.98, 0.55); chevron.rotation.z = -0.6; g.add(chevron);
    const chevron2 = chevron.clone(); chevron2.position.y = 0.86; chevron2.rotation.z = 0.6; g.add(chevron2);
    return g;
}
/** A pitched roof along x: two shingled slopes and the gable walls under them. */
function gableRoof(w, d, h, color, wall) {
    const g = new THREE.Group(), half = d / 2 + 0.3, len = Math.hypot(half, h) + 0.12, ang = Math.atan2(h, half);
    for (const s of [-1, 1]) { const slope = new THREE.Mesh(box(w + 0.5, 0.16, len, 0.55), mat(color, { map: TEX.shingles })); slope.position.set(0, h / 2, s * half / 2); slope.rotation.x = s * ang; slope.castShadow = true; slope.receiveShadow = true; g.add(slope); }
    const geo = new THREE.ExtrudeGeometry(new THREE.Shape([new THREE.Vector2(-d / 2, 0), new THREE.Vector2(d / 2, 0), new THREE.Vector2(0, h)]), { depth: w, bevelEnabled: false });
    geo.rotateY(Math.PI / 2); geo.translate(-w / 2, 0, 0);
    const gable = new THREE.Mesh(geo, mat(wall, { map: TEX.planks })); gable.castShadow = true; g.add(gable);
    return g;
}
const add = (g, mesh, x, y, z) => { mesh.position.set(x, y, z); mesh.castShadow = true; mesh.receiveShadow = true; g.add(mesh); return mesh; };
/** A session is a cottage with its agent at the door: a Claude Code house has a terracotta roof, a Codex house a violet one.
 * The ring at its foot says how it is doing; smoke rises from the chimney while it works; a "!" bubble asks for you. */
function cottage(s) {
    const p = provider(s), g = new THREE.Group(), codex = providerOf(s) === 'codex', wall = codex ? '#eedfc4' : '#f7d9a0';
    add(g, new THREE.Mesh(box(2.9, 0.3, 2.4, 0.6), mat('#a49b8b', { map: TEX.cobble })), 0, 0.15, 0);
    add(g, new THREE.Mesh(box(2.5, 1.5, 2.0, 0.8), mat(wall, { map: TEX.planks })), 0, 1.05, 0);
    const roof = gableRoof(2.5, 2.0, 1.15, p.roof, wall); roof.position.y = 1.8; g.add(roof);
    add(g, new THREE.Mesh(box(0.56, 0.95, 0.08), mat('#7a4a26')), 0, 0.78, 1.02);
    add(g, new THREE.Mesh(box(0.08, 0.08, 0.05), mat('#f2c14e')), 0.17, 0.8, 1.07);
    for (const x of [-0.78, 0.78]) { add(g, new THREE.Mesh(box(0.5, 0.48, 0.06), WINDOW), x, 1.2, 1.02); add(g, new THREE.Mesh(box(0.64, 0.1, 0.16), mat('#7a4a26')), x, 0.92, 1.07); }
    add(g, new THREE.Mesh(box(0.06, 0.48, 0.5), WINDOW), codex ? -1.26 : 1.26, 1.2, 0);
    const cx = codex ? -0.72 : 0.72, chimney = add(g, new THREE.Mesh(box(0.36, 0.9, 0.36, 0.5), mat(codex ? '#8e8999' : '#a5533d', { map: TEX.cobble })), cx, 2.75, -0.45);
    const smoke = [0, 1, 2].map(() => { const puff = new THREE.Mesh(new THREE.IcosahedronGeometry(0.24, 0), mat('#efeae2')); puff.visible = false; g.add(puff); return puff; });
    add(g, new THREE.Mesh(box(0.95, 0.08, 0.6, 0.6), mat('#b8af9c', { map: TEX.cobble })), 0, 0.04, 1.55);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(1.95, 0.08, 6, 44), toon({ color: p.ring, emissive: p.ring, emissiveIntensity: 0.5 }));
    ring.rotation.x = Math.PI / 2; ring.position.y = 0.05; g.add(ring);
    const critter = codex ? codexCloud(p.body) : claudeCritter(p.body);
    critter.position.set(0, 0.24, 2.15); critter.scale.setScalar(1.25); g.add(critter);
    const alert = new THREE.Sprite(new THREE.SpriteMaterial({ map: TEX.alert, alphaTest: 0.5 })); alert.scale.set(1.1, 1.28, 1); alert.position.y = 4.1; alert.visible = false; g.add(alert);
    g.userData = { ring, critter, alert, smoke, chimney: chimney.position.clone().setY(3.25) };
    return g;
}
/** The Router is the town hall on the square: a clock tower over the door and a notice board where open goals are pinned. */
function townHall() {
    const g = new THREE.Group(), wall = '#ecd3a0', roofColor = '#9c4b2e';
    add(g, new THREE.Mesh(box(7.8, 0.5, 5.6, 1.6), mat('#a8a08e', { map: TEX.cobble })), 0, 0.75, 0);
    add(g, new THREE.Mesh(box(7.2, 3.0, 5.0, 0.8), mat(wall, { map: TEX.planks })), 0, 2.5, 0);
    const roof = gableRoof(7.2, 5.0, 2.3, roofColor, wall); roof.position.y = 4.0; g.add(roof);
    add(g, new THREE.Mesh(box(1.7, 2.1, 1.7, 0.8), mat(wall, { map: TEX.planks })), 0, 6.35, 0);
    const spire = add(g, new THREE.Mesh(new THREE.ConeGeometry(1.5, 1.5, 4), mat(roofColor)), 0, 8.15, 0); spire.rotation.y = Math.PI / 4;
    const face = add(g, new THREE.Mesh(new THREE.CylinderGeometry(0.58, 0.58, 0.08, 16), mat('#fbf3dc')), 0, 6.5, 0.88); face.rotation.x = Math.PI / 2;
    add(g, new THREE.Mesh(box(0.07, 0.42, 0.04), mat('#3b2412')), 0, 6.66, 0.94); add(g, new THREE.Mesh(box(0.3, 0.07, 0.04), mat('#3b2412')), 0.12, 6.5, 0.94);
    add(g, new THREE.Mesh(box(1.4, 1.95, 0.12), mat('#7a4a26', { map: TEX.planks })), 0, 1.97, 2.52);
    add(g, new THREE.Mesh(box(2.3, 0.5, 0.14), mat('#8e5a30')), 0, 3.3, 2.56);
    for (const x of [-2.9, -1.7, 1.7, 2.9]) { add(g, new THREE.Mesh(box(0.72, 0.85, 0.08), WINDOW), x, 2.6, 2.52); add(g, new THREE.Mesh(box(0.86, 0.14, 0.22), mat('#7a4a26')), x, 2.12, 2.6); }
    for (const s of [-1, 1]) for (const z of [-1.2, 1.2]) add(g, new THREE.Mesh(box(0.08, 0.85, 0.72), WINDOW), s * 3.62, 2.6, z);
    // the notice board, left of the door; syncLive pins the open goals on it
    const board = new THREE.Group(); board.position.set(-3.2, 0, 3.7); board.rotation.y = 0.25; g.add(board);
    for (const x of [-1, 1]) add(board, new THREE.Mesh(box(0.16, 2.3, 0.16), mat('#6e4526')), x, 1.65, 0);
    add(board, new THREE.Mesh(box(2.4, 1.4, 0.14, 0.6), mat('#a8743f', { map: TEX.planks })), 0, 2.0, 0.02);
    add(board, new THREE.Mesh(box(2.7, 0.2, 0.36), mat('#6e4526')), 0, 2.8, 0.05);
    const notes = new THREE.Group(); notes.position.set(0, 2.0, 0.11); board.add(notes);
    g.userData = { notes };
    return g;
}
/** The gate each front-end's work comes in by: a timber arch with a sign in that client's colour. */
function gate(color) {
    const g = new THREE.Group(), wood = mat('#8a5a32', { map: TEX.planks });
    for (const x of [-1.75, 1.75]) add(g, new THREE.Mesh(box(0.45, 3.6, 0.45, 0.8), wood), x, 1.8, 0);
    add(g, new THREE.Mesh(box(4.6, 0.42, 0.55, 0.8), wood), 0, 3.55, 0);
    add(g, new THREE.Mesh(box(5.0, 0.22, 0.78), mat('#6e4526')), 0, 3.87, 0);
    add(g, new THREE.Mesh(box(2.4, 0.95, 0.12, 0.6), mat(color, { map: TEX.planks })), 0, 2.72, 0.08);
    for (const x of [-0.9, 0.9]) add(g, new THREE.Mesh(box(0.05, 0.4, 0.05), mat('#4a3a33')), x, 3.22, 0.08);
    return g;
}
/** A wooden crate with a sticker in the colour of whoever sent it: one task riding the conveyors. */
function parcel(color) {
    const g = new THREE.Group(), crate = new THREE.Mesh(box(0.62, 0.48, 0.52), mat('#ffffff', { map: TEX.crate }));
    crate.position.y = 0.3; crate.castShadow = true; g.add(crate);
    const sticker = new THREE.Mesh(box(0.22, 0.14, 0.012), mat(color)); sticker.position.set(-0.14, 0.36, 0.266); g.add(sticker);
    g.scale.setScalar(2); return g;
}
/** The surface every conveyor shares: wooden slats, scrolled forward by the frame loop. */
const beltTexture = TEX.belt;
/** A conveyor along a path, the way crates ride in the farm and factory games: the belt, and a timber rail on each side. */
function conveyor(curve) {
    const g = new THREE.Group(), n = 72, pos = [], uv = [], idx = [], up = new THREE.Vector3(0, 1, 0), len = curve.getLength(), half = 0.55;
    const sideAt = (k, w) => new THREE.Vector3().crossVectors(up, curve.getTangentAt(k)).normalize().multiplyScalar(w);
    for (let i = 0; i <= n; i++) {
        const k = i / n, p = curve.getPointAt(k), side = sideAt(k, half), v = (k * len) / 1.2;
        pos.push(p.x + side.x, 0.1, p.z + side.z, p.x - side.x, 0.1, p.z - side.z); uv.push(0, v, 1, v);
        if (i < n) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    }
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); geo.setIndex(idx); geo.computeVertexNormals();
    const belt = new THREE.Mesh(geo, toon({ map: beltTexture })); belt.receiveShadow = true; g.add(belt);
    const rail = mat('#7a4c28');
    for (const s of [-1, 1]) {
        const pts = []; for (let i = 0; i <= 24; i++) pts.push(curve.getPointAt(i / 24).add(sideAt(i / 24, (half + 0.12) * s)).setY(0.55));
        g.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 48, 0.07, 4), rail));
        for (let d = 1.2; d < len; d += 2.6) { const post = new THREE.Mesh(box(0.12, 0.45, 0.12), rail); post.position.copy(curve.getPointAt(d / len).add(sideAt(d / len, (half + 0.12) * s))).setY(0.33); g.add(post); }
    }
    return g;
}
/** A comic-book burst for things that just happened: a jagged star drawn once, the words go on top. */
const BURST_PATH = (() => { const pts = [], n = 14; for (let i = 0; i < n * 2; i++) { const a = (i / (n * 2)) * Math.PI * 2 - Math.PI / 2, r = (i % 2 ? 0.74 : 1) * (1 + Math.sin(i * 7.3) * 0.07); pts.push(`${(100 + Math.cos(a) * 96 * r).toFixed(1)},${(60 + Math.sin(a) * 56 * r).toFixed(1)}`); } return `M${pts.join('L')}Z`; })();
const STEP_GLYPH = { shell: '›_', read: '¶', edit: '✎', write: '+', search: '⌕', fetch: '↗', agent: '◎', plan: '☰', note: '•', tool: '⚙' };
function envelope(color) {
    const g = new THREE.Group(), body = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.06, 0.46), mat('#fffaf0'));
    g.add(body); const flap = new THREE.Mesh(new THREE.ConeGeometry(0.34, 0.24, 3), mat(color)); flap.rotation.set(Math.PI / 2, 0, Math.PI); flap.position.set(0, 0.04, -0.06); flap.scale.set(1, 0.3, 1); g.add(flap); g.scale.setScalar(2.4); return g;
}
// ---------- agent as a service (psr_ask): seats wear an awning, open calls are sealed letters ----------
const WAIT_BLUE = '#5b7fb8', OWNER_AMBER = '#e49a2c', ASK_LIVE = new Set(['queued', 'running']);
const SERVICE_COLORS = ['#4f8fa8', '#b5652b', '#6f9a5a', '#9c3b4b', '#c49a2a', '#5b78b0'];
/** A service's colour, stable across reloads and viewers: its awning and the seal on its letters. */
const serviceColor = name => { let h = 0; for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) | 0; return SERVICE_COLORS[Math.abs(h) % SERVICE_COLORS.length]; };
/** A service seat is a shop: a striped awning over the door, a signboard in the service's colour and a tray by the door; a
 * sign on the ridge says the same from the side the door faces away from. */
function awning(color) {
    const g = new THREE.Group(), board = '#' + new THREE.Color(color).multiplyScalar(0.6).getHexString();
    for (let i = 0; i < 6; i++) { const s = new THREE.Mesh(box(0.42, 0.06, 0.72), mat(i % 2 ? '#f3ecd8' : color)); s.position.set(-1.05 + i * 0.42, 1.95, 1.3); s.rotation.x = 0.35; s.castShadow = true; g.add(s); }
    add(g, new THREE.Mesh(box(1.1, 0.34, 0.06), mat(board)), 0, 2.42, 1.07);
    add(g, new THREE.Mesh(box(0.7, 0.18, 0.5, 0.6), mat('#a8743f', { map: TEX.planks })), 1.0, 0.45, 1.7);
    add(g, new THREE.Mesh(box(1.3, 0.44, 0.08), mat(color)), 0, 3.27, 0); add(g, new THREE.Mesh(box(1.4, 0.07, 0.12), mat('#f3ecd8')), 0, 3.5, 0);
    return g;
}
/** An open call rests where it is being answered: a sealed letter on a post beside the seat, readable from any side. */
function letterPost(color, seal) {
    const g = new THREE.Group(); add(g, new THREE.Mesh(box(0.14, 3.0, 0.14), mat('#6e4526')), 0, 1.5, 0);
    const e = envelope(color); e.position.set(0, 3.25, 0); e.rotation.set(-0.9, 0.4, 0); g.add(e);
    const wax = new THREE.Mesh(box(0.13, 0.04, 0.13), mat(seal)); wax.position.set(0, 0.05, 0.06); e.add(wax);
    return g;
}
function pathRibbon(curve, width, color) {
    const n = 64, pos = [], idx = [], up = new THREE.Vector3(0, 1, 0);
    for (let i = 0; i <= n; i++) {
        const p = curve.getPointAt(i / n), t = curve.getTangentAt(i / n), side = new THREE.Vector3().crossVectors(up, t).normalize().multiplyScalar(width / 2);
        pos.push(p.x + side.x, 0.04, p.z + side.z, p.x - side.x, 0.04, p.z - side.z);
        if (i < n) idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
    }
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); geo.setIndex(idx); geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, toon({ color, side: THREE.DoubleSide })); m.receiveShadow = true; return m;
}
/** Stardew's scarecrow, keeping watch over the task field. */
function scarecrow() {
    const g = new THREE.Group();
    add(g, new THREE.Mesh(box(0.18, 2.6, 0.18), mat('#7a5030')), 0, 1.3, 0);
    add(g, new THREE.Mesh(box(1.9, 0.14, 0.14), mat('#7a5030')), 0, 1.95, 0);
    add(g, new THREE.Mesh(box(0.75, 0.9, 0.42), mat('#6f8f4a')), 0, 1.75, 0);
    add(g, new THREE.Mesh(new THREE.IcosahedronGeometry(0.4, 1), mat('#e6cf96')), 0, 2.6, 0);
    add(g, new THREE.Mesh(new THREE.CylinderGeometry(0.72, 0.72, 0.07, 10), mat('#d2a94c')), 0, 2.9, 0);
    add(g, new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.38, 0.42, 10), mat('#d2a94c')), 0, 3.12, 0);
    for (const x of [-0.13, 0.13]) add(g, new THREE.Mesh(box(0.08, 0.08, 0.04), mat('#3b2412')), x, 2.66, 0.38);
    return g;
}

// ---------- the task garden: one plant per mission, one branch per part ----------
const stepKind = s => s === 'completed' ? 'done' : s === 'queued' ? 'queue' : ATTENTION.has(s) ? 'need' : s === 'failed' ? 'fail' : s === 'canceled' ? 'cancel' : 'run';
const GARDEN_W = 66, GARDEN_D = 46;
/** Rows run left to right; the front row (closest to the camera) holds what needs you. Local z points at the camera. */
const GARDEN_ROWS = { front: GARDEN_D / 2 - 8, middle: 0, back: -GARDEN_D / 2 + 9 };
/** The task field: tilled beds in a fenced plot. The bed borders are painted by row: amber needs you, green is working. */
function gardenTerrace(grass) {
    const g = new THREE.Group();
    const base = new THREE.Mesh(box(GARDEN_W, 0.6, GARDEN_D, 8), grass); base.position.y = 0.3; base.receiveShadow = true; g.add(base);
    const rim = new THREE.Mesh(box(GARDEN_W + 0.8, 0.35, GARDEN_D + 0.8, 1.6), mat('#b3a994', { map: TEX.cobble })); rim.position.y = 0.17; g.add(rim);
    for (const [row, edge] of [['front', '#e3a53c'], ['middle', '#6fb04a'], ['back', '#c9b48e']]) {
        const bed = new THREE.Mesh(box(GARDEN_W - 22, 0.28, 6.2, 1.6), mat('#8a5a36', { map: TEX.soil })); bed.position.set(-8, 0.72, GARDEN_ROWS[row]); bed.receiveShadow = true; g.add(bed);
        const border = new THREE.Mesh(box(GARDEN_W - 21, 0.2, 6.9, 0.8), mat(edge, { map: TEX.planks })); border.position.set(-8, 0.62, GARDEN_ROWS[row]); g.add(border);
    }
    const x0 = -GARDEN_W / 2 + 0.4, x1 = GARDEN_W / 2 - 0.4, z0 = -GARDEN_D / 2 + 0.4, z1 = GARDEN_D / 2 - 0.4, at = (x, z) => new THREE.Vector3(x, 0.6, z);
    for (const [a, b] of [[at(x0, z0), at(x1, z0)], [at(x1, z0), at(x1, z1)], [at(x1, z1), at(x0 + 10, z1)], [at(x0 + 4, z1), at(x0, z1)], [at(x0, z1), at(x0, z0)]]) { const f = fenceLine(a, b); f.position.y = 0.6; g.add(f); }
    const crow = scarecrow(); crow.position.set(16.5, 0.6, 8.5); crow.rotation.y = -0.4; g.add(crow);
    return g;
}
/** Finished work older than a day moves in here; clicking it opens the full history. */
function greenhouse() {
    const g = new THREE.Group(), glass = toon({ color: '#cdeaf3', transparent: true, opacity: 0.45 }), frame = mat('#8a5a32');
    const body = new THREE.Mesh(new THREE.BoxGeometry(9, 4.2, 12), glass); body.position.y = 2.7; g.add(body);
    const roof = new THREE.Mesh(new THREE.CylinderGeometry(5.6, 5.6, 12, 3, 1, false), glass); roof.rotation.set(Math.PI / 2, 0, Math.PI / 2); roof.scale.set(1, 1, 0.5); roof.position.y = 4.8 + 1.4; g.add(roof);
    for (const [x, z] of [[-4.5, -6], [4.5, -6], [-4.5, 6], [4.5, 6], [-4.5, 0], [4.5, 0]]) { const post = new THREE.Mesh(box(0.26, 4.4, 0.26), frame); post.position.set(x, 2.8, z); g.add(post); }
    for (const y of [2.0, 4.8]) for (const x of [-4.5, 4.5]) { const beam = new THREE.Mesh(box(0.2, 0.2, 12.2), frame); beam.position.set(x, y, 0); g.add(beam); }
    const ridge = new THREE.Mesh(box(0.24, 0.24, 12.4), frame); ridge.position.y = 7.6; g.add(ridge);
    const floor = new THREE.Mesh(box(9.4, 0.3, 12.4, 1.6), mat('#b9b09d', { map: TEX.cobble })); floor.position.y = 0.75; g.add(floor);
    for (let i = 0; i < 6; i++) { const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.35, 0.6, 7), mat('#c9805a')); pot.position.set(-2.5 + (i % 2) * 5, 1.2, -4 + Math.floor(i / 2) * 4); g.add(pot); const bush = new THREE.Mesh(new THREE.IcosahedronGeometry(0.6, 1), mat(i % 3 ? '#6faa4a' : '#e88fb4')); bush.position.set(pot.position.x, 1.85, pot.position.z); g.add(bush); }
    return g;
}
/** A mission's tree. A step that continues another step of the mission (a reply or handoff) hangs under it; the others start
 * chains. Chains with the same named part form one branch, a chain without a part is a branch of its own, and branches keep
 * the order in which they started. */
function missionShape(ts) {
    const ids = new Set(ts.map(t => t.id)), kids = new Map(), parentOf = t => { const p = t.dependencyId ?? t.replyToTaskId; return p && ids.has(p) ? p : null; };
    for (const t of ts) { const p = parentOf(t); if (p) kids.set(p, [...(kids.get(p) ?? []), t]); }
    const branches = [], byPart = new Map(), walk = t => [t, ...(kids.get(t.id) ?? []).flatMap(walk)];
    for (const t of ts.filter(t => !parentOf(t))) {
        const part = t.missionPart ?? null; let b = part ? byPart.get(part) : null;
        if (!b) { b = { part, roots: [], steps: [] }; branches.push(b); if (part) byPart.set(part, b); }
        b.roots.push(t);
    }
    for (const b of branches) b.steps = b.roots.flatMap(walk).sort((x, y) => x.createdAt - y.createdAt);
    return { kids, branches, parts: branches.filter(b => b.part) };
}
/** What a step's tip looks like: a glowing bud while it runs, an amber lantern when it waits for you, a grey bud in the
 * queue, a flower in the colour of whoever asked when done, a drooping brown tip when it failed. */
function stepHead(kind, color) {
    if (kind === 'run') return new THREE.Mesh(new THREE.IcosahedronGeometry(0.4, 1), toon({ color: '#5fd07e', emissive: '#2fbf5a', emissiveIntensity: 0.6 }));
    if (kind === 'need') {
        const head = new THREE.Group();
        const hanger = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.5, 4), mat('#4b4a52')); hanger.position.y = 0.05; head.add(hanger);
        const lantern = new THREE.Mesh(new THREE.OctahedronGeometry(0.46, 0), toon({ color: '#ffc04a', emissive: '#ff9a1a', emissiveIntensity: 0.9 })); lantern.position.y = -0.45; head.add(lantern); head.userData.glow = lantern;
        return head;
    }
    if (kind === 'queue') return new THREE.Mesh(new THREE.IcosahedronGeometry(0.27, 0), mat('#c4bdb0'));
    if (kind === 'done') {
        const head = new THREE.Group(), petal = mat(color);
        for (let k = 0; k < 5; k++) { const p = new THREE.Mesh(new THREE.SphereGeometry(0.24, 8, 6), petal); p.scale.set(1, 0.38, 0.62); const a = (k / 5) * Math.PI * 2; p.position.set(Math.cos(a) * 0.26, 0, Math.sin(a) * 0.26); p.rotation.y = -a; head.add(p); }
        const heart = new THREE.Mesh(new THREE.SphereGeometry(0.15, 8, 6), mat('#f6cf4a')); heart.position.y = 0.06; head.add(heart);
        return head;
    }
    if (kind === 'fail') return new THREE.Mesh(new THREE.IcosahedronGeometry(0.3, 0), mat('#a14b3a'));
    return new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.22, 0.22), mat('#a8a39a'));
}
/** One plant = one mission; one branch per part, or per chain of steps without a part. A branch of one step is a twig with
 * the step at its tip; a longer branch carries a twig per step in the order they ran, the latest at its tip. */
function taskPlant(m, colorOf) {
    const g = new THREE.Group(), L = m.branches.length, trunkH = 1.8 + Math.min(L, 6) * 0.55, tips = [], up = new THREE.Vector3(0, 1, 0);
    const mound = new THREE.Mesh(new THREE.IcosahedronGeometry(1.1, 0), mat('#5e4330')); mound.scale.set(1, 0.32, 1); mound.position.y = 0.86; g.add(mound);
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.26, trunkH, 6), mat('#8a6a4a')); trunk.position.y = 0.86 + trunkH / 2; trunk.castShadow = true; g.add(trunk);
    for (let i = 0; i < 2; i++) { const leaf = new THREE.Mesh(new THREE.IcosahedronGeometry(0.34, 0), mat('#5d9a45')); leaf.scale.set(1, 0.45, 0.7); leaf.position.set(i ? 0.32 : -0.3, 1.3 + i * 0.45, i ? -0.1 : 0.12); g.add(leaf); }
    let top = 0.86 + trunkH;
    const wood = kind => mat(kind === 'fail' ? '#8c6b4f' : '#8a6a4a');
    const stick = (from, dir, len, r0, r1, material) => { const b = new THREE.Mesh(new THREE.CylinderGeometry(r0, r1, len, 5), material); b.position.copy(from).addScaledVector(dir, len / 2); b.quaternion.setFromUnitVectors(up, dir); g.add(b); return from.clone().addScaledVector(dir, len); };
    const bloom = (t, at, size) => { const kind = stepKind(t.state), head = stepHead(kind, colorOf(t.originKind)); head.position.copy(at); head.scale.setScalar(size); g.add(head); tips.push({ head, kind, size }); top = Math.max(top, at.y); };
    m.branches.forEach((b, i) => {
        const k = b.steps.length, base = new THREE.Vector3(0, 0.86 + 0.9 + (L === 1 ? trunkH - 0.9 : (i / (L - 1)) * (trunkH - 0.9)), 0), ang = i * 2.39996 + 0.6;
        if (k === 1) {
            const kind = stepKind(b.steps[0].state), dir = new THREE.Vector3(Math.cos(ang), kind === 'fail' ? -0.6 : 0.62, Math.sin(ang)).normalize();
            return bloom(b.steps[0], stick(base, dir, kind === 'cancel' ? 0.45 : 1.15, 0.05, 0.08, wood(kind)), 1);
        }
        // a limb long enough that its steps read one by one, climbing so a big mission grows up more than out
        const dir = new THREE.Vector3(Math.cos(ang), 0.62, Math.sin(ang)).normalize(), len = 1.1 + 0.34 * Math.min(k, 6), side = new THREE.Vector3(-dir.z, 0, dir.x).normalize();
        const tip = stick(base, dir, len, 0.07, 0.12, wood('done'));
        b.steps.forEach((t, j) => {
            if (j === k - 1) return bloom(t, tip, 1);
            const kind = stepKind(t.state), at = base.clone().addScaledVector(dir, len * (j + 1) / k), twig = side.clone().multiplyScalar(j % 2 ? 1 : -1).addScaledVector(up, kind === 'fail' ? -0.6 : 0.7).normalize();
            bloom(t, stick(at, twig, kind === 'cancel' ? 0.25 : 0.55, 0.035, 0.05, wood(kind)), 0.8);
        });
    });
    g.traverse(o => { if (o.isMesh) { o.castShadow = true; o.userData.pick = { kind: 'mission', id: m.key }; } });
    g.userData = { tips, height: top + 0.8 };
    return g;
}

// ---------- the park ----------
export function createPark(root, api) {
    const canvas = $('#park-canvas', root), labelLayer = $('#park-labels', root);
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
    const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(30, 1, 1, 900);
    const hemi = new THREE.HemisphereLight('#e9f4ff', '#6d8f4f', 1.1), sun = new THREE.DirectionalLight('#fff0d4', 2.4);
    sun.position.set(60, 90, 40); sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -90, right: 90, top: 90, bottom: -90, near: 10, far: 260 }); sun.shadow.bias = -0.0004; sun.shadow.radius = 3;
    scene.add(hemi, sun, sun.target);
    const world = new THREE.Group(), dynamic = new THREE.Group(); scene.add(world, dynamic);

    const view = { azimuth: HOME_AZIMUTH, polar: 0.98, distance: 150, target: new THREE.Vector3(0, 0, 0), goal: null };
    const state = { data: null, layout: null, labels: true, selected: null, seenMessages: new Set(), seenDone: new Set(), flights: [], parcels: new Map(), objects: new Map(), firstMessageLoad: true , plants: new Map(), gardenGroup: null, plantGroup: null, gardenSig: null };
    const pick = [], gardenPick = [], parcelPick = [];
    Object.assign(state, { follow: null, cards: new Map(), bursts: [], prevTasks: null, prevGoals: null, showcase: null });
    Object.assign(state, { snowables: [], season: null, weather: null, sky: null, notes: null, notesSig: null, fogScale: [1, 1] });
    Object.assign(state, { letters: new Map(), seenAsks: null, askFlights: [] });

    // ---------- the pixel look: draw the scene small, outline what stands out, scale it up without smoothing ----------
    const PIXEL = 3, low = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthTexture: new THREE.DepthTexture(1, 1) });
    const post = new THREE.ShaderMaterial({
        uniforms: { tColor: { value: low.texture }, tDepth: { value: low.depthTexture }, texel: { value: new THREE.Vector2(1, 1) }, near: { value: camera.near }, far: { value: camera.far }, grade: { value: new THREE.Vector3(1, 1, 1) }, flash: { value: 0 } },
        vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
        fragmentShader: `uniform sampler2D tColor, tDepth; uniform vec2 texel; uniform float near, far, flash; uniform vec3 grade; varying vec2 vUv;
            float dist(vec2 uv) { float z = texture2D(tDepth, uv).x * 2.0 - 1.0; return 2.0 * near * far / (far + near - z * (far - near)); }
            void main() {
                vec4 c = texture2D(tColor, vUv); float d = dist(vUv);
                // a pixel clearly nearer than a neighbour sits on a silhouette: darken it, like the outline of a sprite
                float edge = max(max(dist(vUv + vec2(texel.x, 0.0)), dist(vUv - vec2(texel.x, 0.0))), max(dist(vUv + vec2(0.0, texel.y)), dist(vUv - vec2(0.0, texel.y))));
                c.rgb *= 1.0 - 0.42 * smoothstep(0.025, 0.07, (edge - d) / d);
                gl_FragColor = vec4(c.rgb * grade + flash * vec3(0.92, 0.95, 1.0), max(c.a, flash));
                #include <tonemapping_fragment>
                #include <colorspace_fragment>
            }`,
        depthTest: false, depthWrite: false,
    });
    const postScene = new THREE.Scene(), postCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1); postScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), post));
    state.pixel = (() => { try { return localStorage.getItem('psr-pixel') !== 'off'; } catch { return true; } })();
    function draw() {
        if (!state.pixel) { renderer.render(scene, camera); return; }
        renderer.setRenderTarget(low); renderer.render(scene, camera); renderer.setRenderTarget(null); renderer.render(postScene, postCamera);
    }

    function setCamera() {
        const { azimuth, polar, distance, target } = view;
        camera.position.set(target.x + distance * Math.sin(polar) * Math.sin(azimuth), target.y + distance * Math.cos(polar), target.z + distance * Math.sin(polar) * Math.cos(azimuth));
        camera.lookAt(target);
    }
    /** On wide screens the roster covers the left edge, so the picture is centred in the space to its right. */
    function resize() { const w = root.clientWidth, h = root.clientHeight; root.classList.toggle('is-compact', w < 560); renderer.setSize(w, h, false); low.setSize(Math.max(1, Math.ceil(w / PIXEL)), Math.max(1, Math.ceil(h / PIXEL))); post.uniforms.texel.value.set(1 / low.width, 1 / low.height); camera.aspect = w / Math.max(h, 1); frameView(); }
    // Keep the focus point in the open part of the screen: right of the roster on wide screens, above a bottom sheet on narrow ones.
    function frameView() {
        const w = root.clientWidth, h = root.clientHeight, sheet = !$('#park-inspector', root).hidden || root.classList.contains('show-roster');
        if (w > 820) camera.setViewOffset(w, h, -Math.min(170, w * 0.12), 0, w, h); else if (sheet) camera.setViewOffset(w, h, 0, h * 0.2, w, h); else camera.clearViewOffset();
        camera.updateProjectionMatrix();
    }
    const panelWatch = new MutationObserver(frameView);
    for (const el of [root, $('#park-inspector', root)]) panelWatch.observe(el, { attributes: true, attributeFilter: ['hidden', 'class'] });
    new ResizeObserver(() => { resize(); fitFog(); }).observe(root);

    // Stable layout: islands in configured host order around the plaza; sessions on a sunflower spiral.
    function computeLayout(d) {
        const hosts = d.hosts.hosts, n = Math.max(hosts.length, 1), islands = new Map();
        const sessionsBy = new Map(hosts.map(h => [h.id, d.sessions.filter(s => s.hostId === h.id)]));
        const radiusFor = count => 7.5 + Math.sqrt(Math.max(count, 1)) * 3.6;
        const ringR = 13 + Math.max(...hosts.map(h => radiusFor(sessionsBy.get(h.id).length)), 8) + n * 2.2;
        hosts.forEach((h, i) => {
            const a = n === 1 ? FRONT + Math.PI : FRONT + Math.PI / 3 + (i / (n - 1)) * (Math.PI * 4 / 3), r = radiusFor(sessionsBy.get(h.id).length);
            islands.set(h.id, { host: h, center: new THREE.Vector3(Math.cos(a) * ringR, 0, Math.sin(a) * ringR), radius: r, sessions: sessionsBy.get(h.id) });
        });
        const spots = new Map();
        for (const isl of islands.values()) {
            const list = [...isl.sessions].sort((a, b) => a.id.localeCompare(b.id)), N = list.length;
            list.forEach((s, i) => { const rr = N === 1 ? 0 : Math.sqrt((i + 0.5) / N) * (isl.radius - 4.4), a = i * 2.39996; spots.set(s.id, isl.center.clone().add(new THREE.Vector3(Math.cos(a) * rr, 0, Math.sin(a) * rr))); });
        }
        // a service turn comes from the square, not through a gate: its letter is what travels
        const clients = [...new Set([...d.tasks.filter(t => t.routerTurn !== 'service').map(t => t.originKind), ...d.messages.map(m => m.toClientId).filter(Boolean)].filter(Boolean))].sort();
        if (!clients.length) clients.push(d.identity.entryKind);
        const gates = new Map(); const gateR = ringR * 0.95;
        clients.forEach((k, i) => { const a = FRONT + (i - (clients.length - 1) / 2) * 0.32; gates.set(k, new THREE.Vector3(Math.cos(a) * gateR, 0, Math.sin(a) * gateR)); });
        return { islands, spots, gates, ringR, signature: JSON.stringify([hosts.map(h => [h.id, sessionsBy.get(h.id).map(s => s.id + providerOf(s))]), clients]) };
    }

    function clearWorld() { world.clear(); pick.length = 0; parcelPick.length = 0; state.objects.clear(); state.snowables = []; state.letters.clear(); for (const el of labelLayer.querySelectorAll('[data-label]')) el.remove(); }
    function label(key, html, pos, kind, onClick) {
        const el = document.createElement('button'); el.className = `park-tag park-tag-${kind}`; el.dataset.label = key; el.innerHTML = html; el.type = 'button'; el.style.display = 'none'; // shown once placed
        const [kind_, ...rest] = key.split(':');
        el.onclick = onClick; labelLayer.appendChild(el); state.objects.set('label:' + key, { el, pos, kind: kind_, id: rest.join(':') }); return el;
    }

    function buildWorld() {
        clearWorld();
        const L = state.layout, r = rng('paseo-park'), d = state.data, season = SEASONS[state.season = skyNow().season];
        // grass is one grey tile tinted by the season; snow tints the same materials white
        const grass = color => { const m = toon({ color, map: TEX.grass }); m.userData.base = color; state.snowables.push(m); return m; };
        const span = sceneSpan() * 6, groundGeo = tiled(new THREE.CircleGeometry(span, 96), span * 2, 8);
        scene.fog = new THREE.Fog('#eef0e2', 1, 2); fitFog(); groundGeo.rotateX(-Math.PI / 2);
        const ground = new THREE.Mesh(groundGeo, grass(season.grass)); ground.receiveShadow = true; world.add(ground);
        // pond, ringed with stones
        const pondPos = new THREE.Vector3(Math.cos(Math.PI * 0.62) * L.ringR * 0.62, 0, Math.sin(Math.PI * 0.62) * L.ringR * 0.62);
        const pond = new THREE.Mesh(tiled(new THREE.CircleGeometry(5.5, 28), 11, 3), toon({ map: TEX.water })); pond.rotation.x = -Math.PI / 2; pond.position.copy(pondPos).setY(0.03); world.add(pond);
        for (let i = 0; i < 16; i++) { const a = (i / 16) * Math.PI * 2 + r() * 0.2, st = new THREE.Mesh(new THREE.IcosahedronGeometry(0.32 + r() * 0.26, 0), mat(r() < 0.5 ? '#a39d90' : '#b8b2a4')); st.position.set(pondPos.x + Math.cos(a) * 5.65, 0.1, pondPos.z + Math.sin(a) * 5.65); st.scale.y = 0.6; st.castShadow = true; world.add(st); }
        for (let i = 0; i < 7; i++) { const pad = new THREE.Mesh(new THREE.CircleGeometry(0.45, 7), mat('#5d9a45')); pad.rotation.x = -Math.PI / 2; pad.position.set(pondPos.x + (r() - 0.5) * 7, 0.06, pondPos.z + (r() - 0.5) * 7); if (pad.position.distanceTo(pondPos) < 5) world.add(pad); }
        // the town square: the Router's hall, facing the gates where the work comes in
        const plaza = new THREE.Mesh(tiled(new THREE.CylinderGeometry(9, 9.4, 0.5, 64), 18, 1.6), mat('#d8d0be', { map: TEX.cobble }));
        plaza.position.y = 0.25; plaza.receiveShadow = true; world.add(plaza);
        const hall = townHall(); hall.rotation.y = HOME_AZIMUTH; world.add(hall);
        hall.traverse(o => { if (o.isMesh) { o.userData.pick = { kind: 'router' }; pick.push(o); } });
        state.notes = hall.userData.notes; state.notesSig = null;
        for (let i = 0; i < 10; i++) { const a = (i / 10) * Math.PI * 2, l = lamp(); l.position.set(Math.cos(a) * 8.2, 0.5, Math.sin(a) * 8.2); world.add(l); }
        label('router', `<i style="--c:#9c4b2e"></i><b>Router</b>`, new THREE.Vector3(0, 9.8, 0), 'router', () => select({ kind: 'router' }));
        // farms: one fenced plot per machine, a dirt road and a conveyor from the square, a cottage per session
        for (const [hostId, isl] of L.islands) {
            const online = d.hosts.daemons.filter(x => x.hostId === hostId).some(x => x.connection === 'online');
            const toCenter = isl.center.clone().normalize(), start = toCenter.clone().multiplyScalar(9.2), end = isl.center.clone().sub(toCenter.clone().multiplyScalar(isl.radius - 0.4));
            const mid = start.clone().lerp(end, 0.5).add(new THREE.Vector3(-toCenter.z, 0, toCenter.x).multiplyScalar(3));
            const curve = new THREE.QuadraticBezierCurve3(start, mid, end); isl.path = curve; world.add(pathRibbon(curve, 2.2, '#cfa66c'), conveyor(curve));
            const islandBase = new THREE.Mesh(tiled(new THREE.CylinderGeometry(isl.radius, isl.radius + 0.3, 0.6, 56), isl.radius * 2, 8), online ? grass(season.isle) : mat('#a2a596', { map: TEX.grass })); islandBase.position.copy(isl.center).setY(0.3); islandBase.receiveShadow = true; world.add(islandBase);
            const paving = new THREE.Mesh(tiled(new THREE.CylinderGeometry(isl.radius - 1.1, isl.radius - 1.1, 0.12, 56), (isl.radius - 1.1) * 2, 4), mat(online ? '#ecd4a2' : '#cfcbc1', { map: TEX.sand }));
            paving.position.copy(isl.center).setY(0.66); paving.receiveShadow = true; world.add(paving);
            islandBase.userData.pick = paving.userData.pick = { kind: 'host', id: hostId }; pick.push(islandBase, paving);
            const gap = Math.atan2(-isl.center.z, -isl.center.x), fence = fenceRing(isl.radius - 0.5, gap); fence.position.copy(isl.center).setY(0.6); world.add(fence);
            // lanterns flank the gate and stand at the back; they stay dark on a machine that is offline
            for (const a of [gap - 0.42, gap + 0.42, gap + Math.PI - 0.9, gap + Math.PI + 0.9]) { const l = lamp(online); l.position.copy(isl.center).add(new THREE.Vector3(Math.cos(a) * (isl.radius - 1.5), 0.6, Math.sin(a) * (isl.radius - 1.5))); world.add(l); }
            for (let i = 0; i < 2; i++) { const b = bench(), a = r() * Math.PI * 2; b.position.copy(isl.center).add(new THREE.Vector3(Math.cos(a) * (isl.radius - 1.9), 0.72, Math.sin(a) * (isl.radius - 1.9))); b.lookAt(isl.center.clone().setY(0.72)); world.add(b); }
            hostTag(label('host:' + hostId, '', isl.center.clone().add(isl.center.clone().normalize().multiplyScalar(isl.radius * 0.85)).setY(9.5), 'host', () => select({ kind: 'host', id: hostId })), isl.host, online);
            for (const s of isl.sessions) {
                const pv = cottage(s), spot = L.spots.get(s.id); pv.position.copy(spot).setY(0.72); pv.scale.setScalar(1.5); pv.rotation.y = Math.atan2(-spot.x, -spot.z); world.add(pv);
                pv.traverse(o => { if (o.isMesh) { o.userData.pick = { kind: 'session', id: s.id }; pick.push(o); } });
                state.objects.set('session:' + s.id, { group: pv, session: s });
                label('session:' + s.id, '', spot.clone().setY(6.6), 'session', () => select({ kind: 'session', id: s.id }));
            }
        }
        // entry gates and their roads to the square
        for (const [kind, pos] of L.gates) {
            const color = clientColor(kind), g = gate(color);
            g.position.copy(pos); g.lookAt(0, 0, 0); world.add(g);
            g.traverse(o => { if (o.isMesh) { o.userData.pick = { kind: 'client', id: kind }; pick.push(o); } });
            const dir = pos.clone().normalize(), curve = new THREE.QuadraticBezierCurve3(pos.clone(), pos.clone().lerp(dir.clone().multiplyScalar(9.2), 0.5).add(new THREE.Vector3(dir.z, 0, -dir.x).multiplyScalar(4)), dir.clone().multiplyScalar(9.2));
            L.gates.get(kind).path = curve; world.add(pathRibbon(curve, 2.0, '#d4ad76'), conveyor(curve));
            label('client:' + kind, `<i style="--c:${color}"></i><b>${esc(clientName(kind))}</b>`, pos.clone().setY(5.6), 'client', () => select({ kind: 'client', id: kind }));
        }
        // the task field on the screen-right of the farm, with the greenhouse of finished work at its back
        const parkR = L.ringR + Math.max(8, ...[...L.islands.values()].map(i => i.radius)) + 6, right = new THREE.Vector3(Math.cos(HOME_AZIMUTH), 0, -Math.sin(HOME_AZIMUTH)), toward = new THREE.Vector3(Math.sin(HOME_AZIMUTH), 0, Math.cos(HOME_AZIMUTH));
        const gg = new THREE.Group(); gg.position.copy(right.clone().multiplyScalar(parkR + GARDEN_W / 2 + 12)); gg.rotation.y = HOME_AZIMUTH; gg.add(gardenTerrace(grass(season.isle)));
        const gh = greenhouse(); gh.position.set(GARDEN_W / 2 - 8, 0, -GARDEN_D / 2 + 10); gg.add(gh); gh.traverse(o => { if (o.isMesh) { o.userData.pick = { kind: 'greenhouse' }; pick.push(o); } });
        for (let i = 0; i < 10; i++) { const l = lamp(), edge = i < 5 ? 1 : -1, x = -GARDEN_W / 2 + 5 + (i % 5) * ((GARDEN_W - 10) / 4); l.position.set(x, 0.6, edge * (GARDEN_D / 2 - 1.4)); gg.add(l); }
        world.add(gg); gg.updateMatrixWorld(true); state.gardenGroup = gg; state.plantGroup = null; state.gardenSig = null; state.plants.clear(); gardenPick.length = 0;
        L.garden = { center: gg.position.clone(), parkR, right, toward, greenhouse: gg.localToWorld(gh.position.clone()) };
        label('area:garden', `<i style="--c:#5fae6a"></i><b>任務花園</b>`, gg.localToWorld(new THREE.Vector3(-GARDEN_W / 2 + 7, 0, GARDEN_D / 2 + 1)).setY(4.5), 'area', () => setView('tasks'));
        fitFog(); // the world just grew by the garden
        label('area:greenhouse', `<i style="--c:#7fb8c9"></i><b>溫室</b><span class="tag-state" id="park-greenhouse-count"></span>`, L.garden.greenhouse.clone().setY(9.5), 'area', () => select({ kind: 'greenhouse' }));
        const inGardenArea = p => { const v = p.clone().sub(L.garden.center); return Math.abs(v.dot(right)) < GARDEN_W / 2 + 4 && Math.abs(v.dot(toward)) < GARDEN_D / 2 + 4; };
        // trees, flowers and, in autumn, mushrooms, kept off the square, farms, roads and the field
        const blocked = p => p.length() < 12 || inGardenArea(p) || [...L.islands.values()].some(i => p.distanceTo(i.center) < i.radius + 1.8) || [...L.gates.values()].some(g => p.distanceTo(g) < 4) || p.distanceTo(pondPos) < 6.5
            || [...L.islands.values(), ...L.gates.values()].some(x => { const c = x.path; if (!c) return false; for (let t = 0; t <= 1; t += 0.05) if (c.getPointAt(t).distanceTo(p) < 2.6) return true; return false; });
        for (let i = 0; i < 320; i++) { const a = r() * Math.PI * 2, rad = 10 + Math.sqrt(r()) * (L.ringR + 60 + GARDEN_W), p = new THREE.Vector3(Math.cos(a) * rad, 0, Math.sin(a) * rad); if (!blocked(p)) world.add(tree(r, p, season)); }
        for (let i = 0; season.flowers.length && i < 380; i++) { const a = r() * Math.PI * 2, rad = 10 + r() * (L.ringR + 30), p = new THREE.Vector3(Math.cos(a) * rad, 0.12, Math.sin(a) * rad); if (blocked(p)) continue; const f = new THREE.Mesh(new THREE.IcosahedronGeometry(0.17, 0), mat(season.flowers[i % season.flowers.length])); f.position.copy(p); world.add(f); }
        for (let i = 0; state.season === 'autumn' && i < 40; i++) {
            const a = r() * Math.PI * 2, rad = 10 + r() * (L.ringR + 40), p = new THREE.Vector3(Math.cos(a) * rad, 0, Math.sin(a) * rad); if (blocked(p)) continue;
            const m = new THREE.Group(), stem = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 0.3, 5), mat('#efe3c4')), cap = new THREE.Mesh(new THREE.SphereGeometry(0.22, 8, 5, 0, Math.PI * 2, 0, Math.PI / 2), mat(r() < 0.6 ? '#c9452f' : '#b0703a'));
            stem.position.y = 0.15; cap.position.y = 0.28; m.add(stem, cap); m.position.copy(p); world.add(m);
        }
        applySky();
    }
    function hostTag(el, h, online) { el.innerHTML = `<i style="--c:${online ? '#3a9a5b' : '#9aa0a6'}"></i><b>${esc(h.label)}</b>${online ? '' : '<span class="tag-state state-off">離線</span>'}`; el.title = h.description ?? ''; }
    /** One state word per session for signs and the list: idle sessions say nothing, everything else is colour-coded. */
    function sessionState(s) {
        const d = state.data, tasks = d.tasks.filter(t => t.target === s.id), active = tasks.find(t => ACTIVE.has(t.state)), queued = tasks.filter(t => t.state === 'queued').length;
        const attention = tasks.some(t => ATTENTION.has(t.state)) || s.externalActivity, busy = !!s.activeTurnId || s.nativeStatus === 'running' || !!active;
        const [text, cls] = s.connection !== 'online' ? ['離線', 'off'] : attention ? [active?.state === 'waiting_permission' ? '等審批' : s.externalActivity && !tasks.some(t => ATTENTION.has(t.state)) ? '暫停派工' : '需留意', 'warn'] : s.nativeStatus === 'error' ? ['出錯', 'err'] : active ? [STATE_NAMES[active.state], 'run'] : busy ? ['運行中', 'run'] : queued ? [`排隊 ${queued}`, 'queue'] : ['待命', 'idle'];
        return { text, cls, full: `${text}${queued && cls !== 'queue' ? ` · 排隊 ${queued}` : ''}` };
    }

    // ---------- live state on top of the static world ----------
    function pointOnRoute(route, t) {
        // route: list of curves walked in order (reverse flags), t in [0,1] over the whole route
        const total = route.length, seg = Math.min(Math.floor(t * total), total - 1), local = t * total - seg, { curve, reverse } = route[seg];
        return curve.getPointAt(reverse ? 1 - local : local);
    }
    function routeFor(task) {
        const L = state.layout, isl = L.islands.get(task.hostId), gate = L.gates.get(task.originKind), spot = L.spots.get(task.target);
        if (!isl || !spot) return null;
        const route = [];
        if (gate?.path) route.push({ curve: gate.path, reverse: false });
        route.push({ curve: isl.path, reverse: false });
        const from = isl.path.getPointAt(1), back = from.clone().sub(spot), stop = back.length() > 2.6 ? spot.clone().add(back.setLength(2.4)) : spot.clone();
        route.push({ curve: new THREE.LineCurve3(from, stop), reverse: false });
        return route;
    }
    function syncLive() {
        const d = state.data, L = state.layout, now = Date.now();
        // pavilions: status rings, critters, alerts, labels
        for (const s of d.sessions) {
            const o = state.objects.get('session:' + s.id), tag = state.objects.get('label:session:' + s.id)?.el; if (!o) continue;
            const tasks = d.tasks.filter(t => t.target === s.id), active = tasks.find(t => ACTIVE.has(t.state)), queued = tasks.filter(t => t.state === 'queued').length;
            const offline = s.connection !== 'online', attention = tasks.some(t => ATTENTION.has(t.state)) || s.externalActivity, busy = !!s.activeTurnId || s.nativeStatus === 'running' || !!active;
            const ringColor = offline ? '#8b8f96' : attention ? '#ffae34' : busy ? '#4fcf73' : s.nativeStatus === 'error' ? '#e0574a' : provider(s).ring;
            o.group.userData.ring.material.color.set(ringColor); o.group.userData.ring.material.emissive.set(ringColor);
            o.group.userData.alert.visible = attention; o.busy = busy && !offline; o.offline = offline;
            const st = sessionState(s);
            if (tag) {
                tag.innerHTML = `<i style="--c:${provider(s).roof}"></i><b>${esc(nameOf(s))}</b>${st.cls === 'idle' ? '' : `<span class="tag-state state-${st.cls}">${esc(st.text)}</span>`}`;
                tag.title = `${provider(s).name} · ${st.full}`; tag.classList.toggle('is-busy', o.busy); tag.classList.toggle('is-attention', !!attention); tag.classList.toggle('is-selected', state.selected?.kind === 'session' && state.selected.id === s.id);
                Object.assign(state.objects.get('label:session:' + s.id), { hostId: s.hostId, important: st.cls !== 'idle' });
            }
        }
        // a box per active task: a new one rides gate → plaza → island on the conveyors and parks at the pavilion while the agent works
        const live = new Set();
        for (const t of d.tasks.filter(t => ACTIVE.has(t.state) && t.routerTurn !== 'service').slice(-40)) {
            const route = routeFor(t); if (!route) continue; live.add(t.id);
            let p = state.parcels.get(t.id);
            if (!p) {
                const mesh = parcel(clientColor(t.originKind)), fresh = !!state.prevTasks && (!state.prevTasks.has(t.id) || state.prevTasks.get(t.id) === 'queued');
                dynamic.add(mesh); mesh.traverse(o => { if (o.isMesh) { o.userData.pick = { kind: 'task', id: t.id }; parcelPick.push(o); } });
                p = { mesh, route, phase: fresh ? 0 : 1, pos: new THREE.Vector3() }; state.parcels.set(t.id, p);
                label('parcel:' + t.id, '', p.pos, 'parcel', () => select({ kind: 'task', id: t.id }, { follow: true }));
            } else p.route = route;
            const tag = state.objects.get('label:parcel:' + t.id);
            if (tag) tag.el.innerHTML = `<i style="--c:${clientColor(t.originKind)}"></i><b>${esc(shortTitle(taskTitle(t), 22))}</b><span class="tag-state state-${taskCls(t.state)}">${esc(STATE_NAMES[t.state] ?? t.state)}</span>`;
        }
        for (const [id, p] of state.parcels) if (!live.has(id)) {
            dynamic.remove(p.mesh); state.parcels.delete(id);
            for (let i = parcelPick.length - 1; i >= 0; i--) if (parcelPick[i].userData.pick.id === id) parcelPick.splice(i, 1);
            const tag = state.objects.get('label:parcel:' + id); if (tag) { tag.el.remove(); state.objects.delete('label:parcel:' + id); }
        }
        detectEvents(d); syncCards();
        state.prevTasks = new Map(d.tasks.map(t => [t.id, t.state])); state.prevGoals = new Map((d.goals ?? []).map(g => [g.id, g.state]));
        // queued parcels wait in a stack at the island's path entrance
        for (const [hostId, isl] of L.islands) {
            const q = d.tasks.filter(t => t.state === 'queued' && t.hostId === hostId).length, key = 'queue:' + hostId;
            let stack = state.objects.get(key); if (!stack) { stack = { group: new THREE.Group() }; dynamic.add(stack.group); state.objects.set(key, stack); }
            if (stack.count !== q) { stack.group.clear(); for (let i = 0; i < Math.min(q, 6); i++) { const p = parcel('#e7b75a'); p.position.set((i % 2) * 1.2 - 0.6, Math.floor(i / 2) * 0.96, 0); stack.group.add(p); } stack.count = q; const at = isl.path.getPointAt(0.12); stack.group.position.set(at.x, 0, at.z); }
        }
        // finished work and agent messages fly back to the client that asked
        const fresh = now - 90 * 1000;
        for (const t of d.tasks.filter(t => TERMINAL.has(t.state) && t.updatedAt > fresh)) {
            if (state.seenDone.has(t.id)) continue; state.seenDone.add(t.id); if (state.firstMessageLoad || t.routerTurn === 'service') continue;
            const route = routeFor(t); if (route) flight(route, parcel(t.state === 'completed' ? '#59b86a' : '#d9614e'), 4200);
        }
        for (const m of d.messages) {
            if (state.seenMessages.has(m.id)) continue; state.seenMessages.add(m.id); if (state.firstMessageLoad || now - m.createdAt > 120000) continue;
            const t = d.tasks.find(x => x.id === m.taskId); const route = t && routeFor(t); if (route) flight(route, envelope(clientColor(m.toClientId)), 3600, true);
        }
        state.firstMessageLoad = false;
        // HUD numbers
        const running = d.tasks.filter(t => ACTIVE.has(t.state)).length, queued = d.tasks.filter(t => t.state === 'queued').length;
        const attention = d.tasks.filter(t => ATTENTION.has(t.state)).length + d.sessions.filter(s => s.externalActivity).length + (d.peers?.held ?? 0) + (d.helpers?.pending ?? 0);
        const today = d.tasks.filter(t => t.state === 'completed' && t.updatedAt >= startOfDay()).length;
        const counter = $('#park-counter', root); if (counter) counter.innerHTML = `<b>${running}</b><span>個任務進行中</span><small>今日完成 ${today}${attention ? ` · 等你 ${attention}` : ''}</small>`;
        $('#park-stats', root).innerHTML = [['運行中', running, 'run'], ['排隊', queued, 'queue'], ['需留意', attention, 'warn'], ['今日完成', today, 'done']].map(([k, v, c]) => `<div class="park-stat park-stat-${c}${v ? ' has' : ''}"><b>${v}</b><span>${k}</span></div>`).join('');
        // 需留意 takes you to the first session that needs a look, waiting approvals first.
        const warn = $('.park-stat-warn', root), firstWarn = (d.permissions ?? [])[0]?.sessionRef ?? d.tasks.find(t => ATTENTION.has(t.state))?.target ?? d.sessions.find(s => s.externalActivity)?.id;
        if (warn && (firstWarn || d.peers?.held || d.helpers?.pending)) { warn.classList.add('is-link'); warn.title = firstWarn ? '查看需要留意的 session' : d.helpers?.pending ? '查看等你批准的幫手請求' : '查看等你放行的訊息'; warn.onclick = () => select(firstWarn ? { kind: 'session', id: firstWarn } : d.helpers?.pending ? { kind: 'helpers', id: 'all' } : { kind: 'peers', id: 'all' }); }
        syncAsks(d);
        // open goals hang on the town hall's notice board, a yellow note for a plan waiting for approval
        const open = (d.goals ?? []).filter(g => !['done', 'failed', 'canceled'].includes(g.state)).slice(0, 6), noteSig = open.map(g => g.originKind + g.state).join();
        if (state.notes && noteSig !== state.notesSig) {
            state.notesSig = noteSig; state.notes.clear();
            open.forEach((g, i) => { const note = new THREE.Mesh(box(0.58, 0.5, 0.03), mat(g.state === 'awaiting_approval' ? '#ffd76a' : '#fbf3dc')); note.position.set(-0.76 + (i % 3) * 0.76, 0.3 - Math.floor(i / 3) * 0.62, 0); note.rotation.z = (i % 2 ? 1 : -1) * 0.07; const pin = new THREE.Mesh(box(0.11, 0.11, 0.06), mat(clientColor(g.originKind))); pin.position.set(0, 0.17, 0.03); note.add(pin); state.notes.add(note); });
        }
        syncGarden(); renderRoster(); renderInspector(); views.update(d);
    }
    // ---------- bursts: what just happened, said loudly where it happened ----------
    function burst(pos, text, tone, sessionRef = null) {
        const el = document.createElement('div'); el.className = `park-burst burst-${tone}`; el.setAttribute('aria-hidden', 'true');
        el.innerHTML = `<div class="pb"><svg viewBox="0 0 200 120"><path d="${BURST_PATH}"/></svg><b>${esc(text)}</b></div>`;
        labelLayer.appendChild(el); state.bursts.push({ el, pos, born: performance.now() });
        while (state.bursts.length > 5) state.bursts.shift().el.remove();
        if (state.showcase) showcaseFocus(pos, sessionRef);
    }
    function detectEvents(d) {
        const L = state.layout; if (!state.prevTasks || !L) return;
        const hub = () => new THREE.Vector3(0, 12, 0);
        for (const t of d.tasks) {
            const before = state.prevTasks.get(t.id), spot = L.spots.get(t.target);
            if (before === undefined) { const gate = L.gates.get(t.originKind); if (gate) burst(gate.clone().setY(7.5), t.retryOf ? '再試一次' : t.originKind === 'planner' ? '規劃者派工！' : '叮！新任務', 'new', t.target); continue; }
            if (before === t.state || !spot) continue;
            if (t.state === 'waiting_permission') burst(spot.clone().setY(9.5), '等你批！', 'warn', t.target);
            else if (t.state === 'completed') burst(spot.clone().setY(9.5), '搞定 ✓', 'done', t.target);
            else if (t.state === 'failed') burst(spot.clone().setY(9.5), '卡住了！', 'err', t.target);
        }
        for (const g of d.goals ?? []) {
            const before = state.prevGoals?.get(g.id);
            if (before === undefined) burst(hub(), '新目標！', 'new');
            else if (before !== g.state && g.state === 'awaiting_approval') burst(hub(), '方案待批', 'warn');
            else if (before !== g.state && g.state === 'done') burst(hub(), '目標完成 ✓', 'done');
        }
    }
    function placeBursts(w, h) {
        const now = performance.now();
        state.bursts = state.bursts.filter(b => {
            if (now - b.born > 3400) { b.el.remove(); return false; }
            v.copy(b.pos).project(camera); const on = v.z < 1 && Math.abs(v.x) < 1.05 && Math.abs(v.y) < 1.05;
            b.el.style.display = on ? '' : 'none';
            if (on) b.el.style.transform = `translate(${((v.x + 1) / 2) * w}px, ${((1 - v.y) / 2) * h}px) translate(-50%, -100%)`;
            return true;
        });
    }
    // ---------- agent as a service (psr_ask): shops, letters and the waiting "…" ----------
    // Seats wear an awning, a caller that waits for an answer shows "…", each call being answered rests as a letter beside its
    // seat (amber while that turn waits for you), and fresh calls and answers fly through the square. With no service seats
    // and no asks nothing here draws.
    const unpick = g => { const ms = new Set(); g.traverse(m => ms.add(m)); for (let i = pick.length - 1; i >= 0; i--) if (ms.has(pick[i])) pick.splice(i, 1); };
    const pickAs = (g, p) => g.traverse(m => { if (m.isMesh) { m.userData.pick = p; pick.push(m); } });
    /** Beside a cottage, off its door side, so the letter reads from the default camera whichever way the house faces. */
    const doorstep = spot => { const out = spot.clone().setY(0).negate().normalize(); return spot.clone().add(new THREE.Vector3(-out.z, 0, out.x).multiplyScalar(3.0)).add(out.multiplyScalar(0.8)); };
    function syncAsks(d) {
        const L = state.layout, asks = d.asks ?? [], live = asks.filter(a => ASK_LIVE.has(a.state));
        const waiting = new Set(asks.filter(a => a.delivery === 'queued' || (a.delivery === 'held' && a.settledAt === null)).map(a => a.callerSession));
        for (const s of d.sessions) {
            const o = state.objects.get('session:' + s.id); if (!o) continue;
            const svc = s.seat?.role === 'service' ? s.seat.service || '?' : null;
            if (o.dress !== svc) {
                if (o.dressGroup) { o.group.remove(o.dressGroup); unpick(o.dressGroup); }
                o.dressGroup = svc ? awning(serviceColor(svc)) : null; o.dress = svc;
                if (o.dressGroup) { o.group.add(o.dressGroup); pickAs(o.dressGroup, { kind: 'session', id: s.id }); }
            }
            // the "!" wins when both apply: something there needs you
            const wait = waiting.has(s.id) && !o.group.userData.alert.visible;
            if (wait && !o.bubble) { o.bubble = new THREE.Sprite(new THREE.SpriteMaterial({ map: TEX.wait, alphaTest: 0.5 })); o.bubble.scale.set(1.1, 1.28, 1); o.bubble.position.y = 4.1; o.group.add(o.bubble); }
            if (o.bubble) o.bubble.visible = wait;
        }
        const want = new Map(live.filter(a => a.state === 'running' && a.seatRef && L.spots.has(a.seatRef)).map(a => [a.seatRef, a]));
        for (const [ref, l] of state.letters) if (!want.has(ref)) { world.remove(l.group); unpick(l.group); state.letters.delete(ref); }
        for (const [ref, a] of want) {
            const sig = `${a.id}:${a.waitingApproval ? 1 : 0}`, cur = state.letters.get(ref); if (cur?.sig === sig) continue;
            if (cur) { world.remove(cur.group); unpick(cur.group); }
            const g = letterPost(a.waitingApproval ? OWNER_AMBER : WAIT_BLUE, serviceColor(a.service)); g.position.copy(doorstep(L.spots.get(ref))).setY(0.7); world.add(g);
            pickAs(g, { kind: 'calls', id: a.id }); state.letters.set(ref, { group: g, sig });
        }
        flyAsks(d, asks);
        // one more line in the stats card while calls are open: how many, and how many wait for you
        const stats = $('#park-stats', root), owner = live.filter(a => a.waitingApproval);
        root.classList.toggle('has-ribbon', live.length > 0);
        if (!live.length) return;
        stats.insertAdjacentHTML('beforeend', `<div class="park-ribbon"><button type="button" data-ribbon="calls" title="進行中的服務呼叫（psr_ask）">服務呼叫 ${live.length}</button>${owner.length ? `<button type="button" class="is-warn" data-ribbon="owner" title="服務輪在等你批准：只有你能批">${owner.length} 等你批</button>` : ''}</div>`);
        $('[data-ribbon="calls"]', stats).onclick = () => select({ kind: 'calls' });
        const ow = $('[data-ribbon="owner"]', stats); if (ow) ow.onclick = () => select({ kind: 'session', id: owner[0].seatRef });
        const small = $('#park-counter small', root); if (small) small.textContent += ` · 呼叫 ${live.length}`;
    }
    /** A call's way: from the caller's door down its road to the square, round the square's edge, up the seat's road to its
     * door. Every call passes the Router; a missing end stops at the square. */
    function askRoute(from, to) {
        const L = state.layout, door = s => { const spot = L.spots.get(s.id); return spot.clone().add(spot.clone().setY(0).negate().normalize().multiplyScalar(2.6)).setY(0.6); };
        const road = s => s && L.spots.has(s.id) ? L.islands.get(s.hostId)?.path : null, rf = road(from), rt = road(to);
        if (!rf && !rt) return null;
        const a = rf ? rf.getPointAt(0) : rt.getPointAt(0).setLength(4), b = rt ? rt.getPointAt(0) : rf.getPointAt(0).setLength(4), mid = a.clone().add(b).multiplyScalar(0.5);
        mid.setLength(Math.max(9.6, mid.length()));
        return [...(rf ? [{ curve: new THREE.LineCurve3(door(from), rf.getPointAt(1)), reverse: false }, { curve: rf, reverse: true }] : []), { curve: new THREE.QuadraticBezierCurve3(a, mid, b), reverse: false },
            ...(rt ? [{ curve: rt, reverse: false }, { curve: new THREE.LineCurve3(rt.getPointAt(1), door(to)), reverse: false }] : [])];
    }
    /** A point along a route by distance, so a letter keeps one speed on short and long legs. */
    function routeAt(route, k) {
        route.len ??= route.reduce((n, x) => n + (x.len ??= x.curve.getLength()), 0);
        let rest = k * route.len;
        for (const x of route) { if (rest <= x.len || x === route.at(-1)) { const q = Math.min(1, rest / Math.max(x.len, 1e-6)); return x.curve.getPointAt(x.reverse ? 1 - q : q); } rest -= x.len; }
    }
    let askFlightSeq = 0;
    function askFlight(from, to, color, text, ms, delay = 0) {
        const route = askRoute(from, to); if (!route || state.askFlights.length >= 6) return; // more at once would only be noise: they keep their end state
        const mesh = envelope(color); mesh.scale.multiplyScalar(1.8);
        state.askFlights.push({ route, mesh, color, text, ms, start: performance.now() + delay, key: 'flight:' + (++askFlightSeq), pos: new THREE.Vector3(), el: null });
    }
    /** Only what happens while you watch flies: an ask first seen within two minutes of being made, an answer within two minutes
     * of settling. The first load and reduced motion draw the end state only. */
    function flyAsks(d, asks) {
        const first = !state.seenAsks, still = matchMedia('(prefers-reduced-motion: reduce)').matches, now = Date.now(), byId = id => d.sessions.find(s => s.id === id) ?? null;
        state.seenAsks ??= new Map();
        for (const a of asks) {
            const seen = state.seenAsks.get(a.id); state.seenAsks.set(a.id, { seat: a.seatRef, settled: a.settledAt !== null });
            if (first || still) continue;
            const caller = byId(a.callerSession), seat = a.seatRef ? byId(a.seatRef) : null, who = caller ? nameOf(caller) : a.callerName ?? '';
            let delay = 0;
            if (!seen && now - a.createdAt < 120000) { askFlight(caller, seat, WAIT_BLUE, `${who} → ${a.service}`, 5000); delay = 5000; }
            else if (seen && !seen.seat && seat && a.settledAt === null) askFlight(null, seat, WAIT_BLUE, `→ ${a.service}`, 3000);
            if (a.settledAt !== null && !seen?.settled && now - a.settledAt < 120000) {
                const ok = a.state === 'answered', color = ok ? '#59b86a' : a.state === 'canceled' ? '#b8b2a6' : '#d9614e';
                askFlight(seat, caller, color, `${a.service} 回覆 → ${who} ${ok ? '✓' : '✕'}`, 4200, delay);
            }
        }
    }
    function moveAskFlights(t) {
        const now = performance.now();
        state.askFlights = state.askFlights.filter(f => {
            if (now < f.start) return true;
            if (!f.el) { dynamic.add(f.mesh); f.el = label(f.key, `<i style="--c:${f.color}"></i><b>${esc(f.text)}</b>`, f.pos, 'flight', () => {}); }
            const k = (now - f.start) / f.ms;
            if (k >= 1) { dynamic.remove(f.mesh); f.el.remove(); state.objects.delete('label:' + f.key); return false; }
            f.mesh.position.copy(routeAt(f.route, k)); f.mesh.position.y += Math.sin(k * Math.PI) * 3 + 0.8; f.mesh.rotation.z = Math.sin(t * 8) * 0.2;
            f.pos.copy(f.mesh.position).setY(f.mesh.position.y + 3); return true;
        });
    }
    function dropAskFlights() { for (const f of state.askFlights) { dynamic.remove(f.mesh); f.el?.remove(); state.objects.delete('label:' + f.key); } state.askFlights = []; }

    // ---------- the chain ladder: caller → service → sub-service, each hop with where it stands ----------
    const asksNow = () => state.data.asks ?? [];
    /** Text another agent wrote is data: escaped, under a dotted rule, with a caption saying whose it is. Never a link. */
    const askQuote = (text, caption) => `<div class="ask-quote"><small>${esc(caption)}</small><span>${esc(text)}</span></div>`;
    const DROP_WORDS = [[/^superseded/, '同一主題有更新的回覆，舊的不送了'], [/^expired$/, '放太久，過了時限'], [/^queue full$/, '待送的回覆太多，最舊的先丟'], [/^client gone$/, '派那一輪的入口已經不在'], [/^cleared by/, '被清掉了'], [/asking service turn is over/, '問它的服務輪已經結束']];
    const dropWord = why => DROP_WORDS.find(([re]) => re.test(why ?? ''))?.[1] ?? '沒送到';
    function askRootOf(a) { const all = asksNow(); let x = a; for (let i = 0; i < 4 && x.parentAsk; i++) { const up = all.find(y => y.id === x.parentAsk); if (!up) break; x = up; } return x; }
    /** The whole chain under a root ask, depth first, in the order the calls were made. */
    function askChain(r) { const all = asksNow(), out = [], walk = (a, n) => { out.push(a); if (n < 3) for (const c of all.filter(x => x.parentAsk === a.id).sort((x, y) => x.createdAt - y.createdAt)) walk(c, n + 1); }; walk(r, 0); return out; }
    const askRoots = () => { const all = asksNow(); return all.filter(a => !a.parentAsk || !all.some(x => x.id === a.parentAsk)); };
    /** Where one ask stands, as [dot class, words]. */
    function askWord(a) {
        if (a.state === 'queued') {
            const ahead = Number(/^queued \((\d+) ahead\)/.exec(a.status ?? '')?.[1] ?? 0), seats = state.data.policy?.a2a?.seats?.filter(x => x.service === a.service && x.present && !x.revoked && !x.credentialExpired);
            return ['h-wait', seats && !seats.length ? '排隊 · 現在沒有能接的座位' : ahead ? `排隊 · 前面還有 ${ahead} 個` : '排隊 · 等空座位'];
        }
        if (a.state === 'running') {
            if (a.waitingApproval) return ['h-owner', '! 等你批准'];
            const sub = a.waitingSub.map(id => asksNow().find(x => x.id === id)).find(x => x && x.settledAt === null);
            if (sub) return ['h-wait', `等下游 ${sub.service}`];
            const turn = state.data.tasks.find(t => t.id === a.turnTaskIds.at(-1));
            return ['h-run', `回答中 · 已過 ${fmtDur(Date.now() - (turn?.createdAt ?? a.updatedAt))}`];
        }
        const took = fmtDur(a.settledAt - a.createdAt);
        return a.state === 'answered' ? ['h-done', `✓ 回答了 · 用時 ${took}`] : a.state === 'expired' ? ['h-fail', `✕ 逾時 · ${took}`] : a.state === 'canceled' ? ['h-off', '已取消'] : ['h-fail', `✕ 沒回答成 · ${took}`];
    }
    /** Where the caller stands: waiting inside its turn, waiting for its next turn, or how the answer reached it. */
    function callerWord(r) {
        const t = state.data.tasks.find(x => x.id === r.callerTask);
        if (r.settledAt === null) return ['h-wait', t && TERMINAL.has(t.state) ? '等回覆 · 這輪已結束，回覆會在下一輪開頭送到' : '等回覆'];
        if (r.delivery === 'delivered') return ['h-done', r.deliveredTaskId ? '回覆在下一輪開頭送到了' : '在呼叫裡收到回覆'];
        if (r.delivery === 'dropped') return ['h-fail', `回覆沒送到：${dropWord(r.dropReason)}`];
        return ['h-wait', '回覆排隊中 · 這個 session 空下來就送到'];
    }
    function askLadder(r, inTask = false) {
        const d = state.data, chain = askChain(r), session = id => d.sessions.find(s => s.id === id), task = id => d.tasks.find(t => t.id === id);
        const who = (ref, name) => { const s = session(ref); return s ? `<button type="button" class="link" data-goto-session="${esc(s.id)}">${esc(nameOf(s))}</button>` : esc(name ?? ref); };
        const hop = (cls, head, body = '') => `<div class="ask-hop ${cls}"><i></i><div>${head}${body}</div></div>`;
        const [cc, cw] = callerWord(r), callerTask = task(r.callerTask), reply = r.deliveredTaskId && task(r.deliveredTaskId), open = chain.filter(a => a.settledAt === null);
        const caller = hop(cc, `<p class="ask-head"><b>${who(r.callerSession, r.callerName)}</b><span class="muted">${esc(hostLabel(session(r.callerSession)?.hostId ?? r.callerHostId ?? ''))}</span><span class="ask-word">${esc(cw)}</span></p>`,
            `${callerTask && !inTask ? `<p class="ask-small">呼叫方的任務 <button type="button" class="link" data-task="${esc(callerTask.id)}">${esc(shortTitle(taskTitle(callerTask), 30))}</button></p>` : ''}${reply ? `<p class="ask-small"><button type="button" class="link" data-task="${esc(reply.id)}">看送回覆的那一輪</button></p>` : ''}`);
        const hops = chain.map(a => {
            const [cls, word] = askWord(a), turn = task(a.turnTaskIds.at(-1)), seat = a.seatRef && session(a.seatRef);
            return hop(cls, `<p class="ask-head"><b>${esc(a.service)}</b>${a.seatRef ? `<span class="muted">${who(a.seatRef, a.seatName)} · ${esc(hostLabel(seat?.hostId ?? a.seatHostId ?? ''))}</span>` : ''}<span class="ask-word">${esc(word)}</span></p>`,
                `<p class="ask-small"><code>${esc(a.id)}</code> · 第 ${a.depth} 層${a.topic ? ` · 主題 ${esc(a.topic)}` : ''}${turn ? ` · <button type="button" class="link" data-task="${esc(turn.id)}">看服務輪</button>` : ''}</p>
                ${askQuote(a.request, a.depth === 1 ? '呼叫方的請求（不能授權任何事）' : '它的請求（不能授權任何事）')}
                ${a.answer ? askQuote(a.answer.text, a.state === 'answered' ? '服務的回覆' : 'Router 的說明') : ''}${a.answer?.evidence ? askQuote(a.answer.evidence, '那一輪最後的輸出') : ''}`);
        });
        const deadline = open.length ? Math.min(...open.map(a => a.deadlineAt)) : 0;
        return `<div class="ask-ladder" data-ask-root="${esc(r.id)}">${caller}${hops.join('')}<p class="ask-foot">深度 ${Math.max(...chain.map(a => a.depth))}/3 · ${chain.length} 次呼叫${deadline ? ` · 剩 ${esc(fmtDur(deadline - Date.now()))}` : ''}</p></div>`;
    }
    /** In a task's detail: the calls it made, the chain a service turn answers, or the answers a reply brought back. */
    function askSection(t) {
        const all = asksNow(); if (!all.length) return '';
        if (t.routerTurn === 'service' && t.askOf) { const a = all.find(x => x.id === t.askOf); return a ? `<h3>服務呼叫鏈</h3>${askLadder(askRootOf(a))}` : ''; }
        const made = askRoots().filter(a => a.callerTask === t.id).sort((x, y) => x.createdAt - y.createdAt), brought = all.filter(a => a.deliveredTaskId === t.id);
        return (made.length ? `<h3>這一輪叫了服務 · ${made.length}</h3>${made.map(a => askLadder(a, true)).join('')}` : '') + (brought.length ? `<h3>帶回的服務回覆 · ${brought.length}</h3>${brought.map(a => askLadder(askRootOf(a))).join('')}` : '');
    }
    /** In a session's detail: the call a seat is answering, or the calls a caller still waits on. */
    function sessionAsks(s) {
        const all = asksNow(); if (!all.length) return '';
        if (s.seat?.role === 'service') { const a = all.find(x => x.state === 'running' && x.seatRef === s.id); return a ? `<h3>正在回答</h3>${askLadder(askRootOf(a))}` : ''; }
        const open = askRoots().filter(a => a.callerSession === s.id && (a.settledAt === null || a.delivery === 'queued')).slice(0, 3);
        return open.length ? `<h3>等服務回覆 · ${open.length}</h3>${open.map(a => askLadder(a)).join('')}` : '';
    }
    /** 服務呼叫 from the ribbon or a letter: the chains in flight, the last day's, and answers waiting to be delivered. */
    function callsPanel(focus) {
        const roots = askRoots().sort((x, y) => y.createdAt - x.createdAt), lead = focus && askRootOf(asksNow().find(a => a.id === focus) ?? { parentAsk: null, id: '' });
        const live = roots.filter(r => askChain(r).some(a => a.settledAt === null)).sort((x, y) => (y === lead) - (x === lead));
        const recent = roots.filter(r => !live.includes(r) && r.settledAt && Date.now() - r.settledAt < DAY).slice(0, 12), pending = (state.data.policy?.a2a?.queues?.callers ?? []).filter(c => c.undelivered);
        const row = r => { const [cls, word] = askWord(r), t = state.data.tasks.find(x => x.id === r.callerTask), s = state.data.sessions.find(x => x.id === r.callerSession), inner = `<i class="ask-dot ${cls}"></i><span><b>${esc(s ? nameOf(s) : r.callerName ?? '')} › ${esc(askChain(r).map(a => a.service).join(' › '))}</b><small>${esc(word)} · ${esc(callerWord(r)[1])} · ${esc(relTime(r.settledAt))}</small></span>`;
            return t ? `<button type="button" class="ask-row" data-task="${esc(t.id)}">${inner}</button>` : `<div class="ask-row">${inner}</div>`; };
        return `<p class="eyebrow">服務呼叫</p><h2>${live.length ? `${live.length} 條鏈進行中` : '沒有進行中的呼叫'}</h2>
          ${live.slice(0, 6).map(r => askLadder(r)).join('')}${live.length > 6 ? `<p class="inspector-hint">還有 ${live.length - 6} 條</p>` : ''}
          ${recent.length ? `<h3>最近 24 小時 · ${recent.length}</h3>${recent.map(row).join('')}` : ''}
          ${pending.length ? `<h3>等著送回的回覆</h3>${pending.map(c => `<p class="ask-small"><button type="button" class="link" data-goto-session="${esc(c.sessionRef)}">${esc(nameOf(state.data.sessions.find(x => x.id === c.sessionRef) ?? { title: c.name }))}</button> · ${esc(hostLabel(c.hostId ?? ''))} · ${c.undelivered} 則，它空下來就送到</p>`).join('')}` : ''}
          <p class="inspector-hint">服務、誰能叫、排隊上限和時限在「權限」。</p>`;
    }
    /** On a permission request of a service turn: only the owner approves it, and this is the chain it holds up. */
    function serviceTurnNote(x, compact = false) {
        if (x.routerTurn !== 'service' || !x.ask) return '';
        const all = asksNow(), a = all.find(y => y.id === x.ask.id), r = a && askRootOf(a), chain = r ? askChain(r) : [], name = ref => { const s = state.data.sessions.find(y => y.id === ref); return s ? nameOf(s) : ref; };
        const origin = r?.callerSession ?? (x.ask.path.length === 1 ? x.ask.callerSession : null), host = svc => chain.find(y => y.service === svc)?.seatHostId;
        const stops = [...(origin ? [[name(origin), state.data.sessions.find(y => y.id === origin)?.hostId]] : []), ...x.ask.path.map(svc => [svc, host(svc)])];
        if (compact) return `<p class="lc-route">只有你能批（服務輪）· ${esc(stops.map(([n]) => n).join(' › '))}</p>`;
        return `<div class="ask-perm"><p class="ask-perm-head">只有你能批（服務輪）</p><div class="ask-route">${stops.map(([n, h], i) => `${i ? '<span>›</span>' : ''}<b>${esc(n)}${h ? `<small>${esc(hostLabel(h))}</small>` : ''}</b>`).join('')}</div>
          <p class="perm-note">服務呼叫 <code>${esc(x.ask.id)}</code> · 第 ${x.ask.path.length} 層 · 這是 Router 的服務輪：規劃者和前臺都不能批</p>
          ${a ? `<details class="perm-rule"><summary>它在回答的請求（不能授權任何事）</summary>${askQuote(a.request, '')}</details>` : ''}</div>`;
    }
    // ---------- live cards: what an agent is doing right now, pinned above its pavilion ----------
    const liveTaskOf = s => { const ts = state.data.tasks.filter(t => t.target === s.id); return ts.find(t => ACTIVE.has(t.state)) ?? ts.filter(t => TERMINAL.has(t.state) && Date.now() - t.updatedAt < 15000).at(-1) ?? null; };
    const lastLine = text => String(text ?? '').split('\n').map(x => x.trim()).filter(Boolean).at(-1) ?? '';
    function cardHtml(s, t) {
        const done = TERMINAL.has(t.state), all = t.steps ?? [], steps = all.slice(-5), perms = (state.data.permissions ?? []).filter(x => x.sessionRef === s.id);
        const mark = x => x.status === 'running' && !done ? '<i class="lc-spin"></i>' : x.status === 'failed' || (x.exitCode ?? 0) !== 0 ? '✕' : '✓';
        const list = steps.length ? `<ol class="lc-steps">${steps.map(x => `<li class="st-${esc(x.status)}"><span class="lc-glyph">${STEP_GLYPH[x.kind] ?? '⚙'}</span><code title="${esc(x.text)}">${esc(x.text)}</code><em>${mark(x)}</em></li>`).join('')}</ol>`
            : done ? '' : `<p class="lc-idle">${['sending', 'accepted'].includes(t.state) ? '送達中…' : '思考中…'}</p>`;
        const perm = perms.map(x => `<div class="lc-perm"><p><span class="lv lv-${esc(x.level ?? 'L4')}">${esc(x.level ?? '')} ${esc(x.levelName ?? '')}</span>${esc(x.tool)}</p><code>${esc((x.detail ?? '').slice(0, 200))}</code>${serviceTurnNote(x, true)}${x.canRespond ? `<div class="lc-actions"><button type="button" class="park-btn primary" data-perm="${esc(x.requestId)}" data-session="${esc(x.sessionRef)}" data-decision="allow">批准這一次</button><button type="button" class="park-btn ghost" data-perm="${esc(x.requestId)}" data-session="${esc(x.sessionRef)}" data-decision="deny">拒絕</button></div>` : `<small>${esc(x.reason ?? '等你批准')}</small>`}</div>`).join('');
        const say = !done && t.resultSummary ? lastLine(t.resultSummary) : '';
        const tail = done ? `<p class="lc-result state-${taskCls(t.state)}"><b>${t.state === 'completed' ? '✓ 完成' : t.state === 'failed' ? '✕ 失敗' : '已取消'}</b>${esc(lastLine(t.resultSummary ?? t.completionEvidence ?? '').slice(0, 160))}</p>` : say ? `<p class="lc-say">${esc(say.slice(0, 160))}</p>` : '';
        return `<header><i style="--c:${provider(s).roof}"></i><b>${esc(nameOf(s))}</b><span>${esc(hostLabel(s.hostId))}</span><time data-since="${t.createdAt}"${done ? ` data-until="${t.updatedAt}"` : ''}>${esc(fmtDur((done ? t.updatedAt : Date.now()) - t.createdAt))}</time></header>
          <p class="lc-task" title="${esc(taskTitle(t))}">${esc(shortTitle(taskTitle(t), 34))}</p>${all.length > 5 ? `<p class="lc-more">前面還有 ${all.length - 5} 步</p>` : ''}${list}${perm}${tail}`;
    }
    function syncCards() {
        const d = state.data, L = state.layout, seen = new Set();
        for (const s of d.sessions) {
            const t = liveTaskOf(s), spot = L.spots.get(s.id); if (!t || !spot) continue; seen.add(s.id);
            let c = state.cards.get(s.id);
            if (!c) {
                const el = document.createElement('div'); el.className = 'live-card'; el.style.display = 'none'; labelLayer.appendChild(el);
                c = { el, pos: spot.clone().setY(8.4), sessionId: s.id }; state.cards.set(s.id, c);
                el.addEventListener('click', e => { if (!e.target.closest('button')) select({ kind: 'task', id: c.taskId }); });
            }
            c.taskId = t.id; c.urgent = t.state === 'waiting_permission' ? 1 : 0; c.updatedAt = t.updatedAt;
            c.el.className = `live-card is-${t.state === 'waiting_permission' ? 'warn' : TERMINAL.has(t.state) ? taskCls(t.state) : 'run'}`;
            const html = cardHtml(s, t);
            if (html !== c.html) {
                c.html = html; c.el.innerHTML = html;
                c.el.querySelectorAll('[data-perm]').forEach(b => b.onclick = async (e) => { e.stopPropagation(); const allow = b.dataset.decision === 'allow'; b.disabled = true;
                    try { await api.respondPermission({ sessionRef: b.dataset.session, requestId: b.dataset.perm, decision: b.dataset.decision }); api.toast(allow ? '已批准這一次' : '已拒絕'); } catch (err) { api.toast(err.message, true); b.disabled = false; } });
            }
        }
        for (const [id, c] of state.cards) if (!seen.has(id)) { c.el.remove(); state.cards.delete(id); }
    }
    setInterval(() => { for (const c of state.cards.values()) c.el.querySelectorAll('time[data-since]').forEach(el => { el.textContent = fmtDur((el.dataset.until ? Number(el.dataset.until) : Date.now()) - Number(el.dataset.since)); }); }, 1000);
    /** Which cards to show: the one you look at (selected, hovered, followed, toured), any waiting for an answer, all of them up close,
     * and otherwise the two most recently active (one on a phone), so the overview stays readable. */
    function cardsShown() {
        const shown = new Set(), d = state.data, sel = state.selected, hov = state.hover;
        if (!['overview', 'machines'].includes(root.dataset.view) && !state.showcase) return shown;
        const sessionOf = id => d.tasks.find(t => t.id === id)?.target;
        const focus = [sel?.kind === 'session' ? sel.id : sel?.kind === 'task' ? sessionOf(sel.id) : null, state.follow ? sessionOf(state.follow) : null, state.showcase?.session, hov?.kind === 'session' ? hov.id : hov?.kind === 'task' ? sessionOf(hov.id) : null];
        for (const [id, c] of state.cards) if (focus.includes(id) || c.urgent) shown.add(id);
        if (view.distance < fitDistance() * 0.6) for (const id of state.cards.keys()) shown.add(id);
        else if (!state.showcase) for (const c of [...state.cards.values()].filter(c => !shown.has(c.sessionId)).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, Math.max(0, (root.classList.contains('is-compact') ? 1 : 2) - shown.size))) shown.add(c.sessionId);
        return shown;
    }
    /** Cards stay clear of the side panels and of each other; their rectangles become obstacles for the signs. */
    function placeCards(w, h, shown, minX, maxX, minTop) {
        const placed = [];
        for (const [id, c] of [...state.cards].sort((a, b) => b[1].urgent - a[1].urgent)) {
            if (!shown.has(id)) { c.el.style.display = 'none'; continue; }
            v.copy(c.pos).project(camera);
            if (!(v.z < 1 && Math.abs(v.x) < 1.05 && Math.abs(v.y) < 1.05)) { c.el.style.display = 'none'; continue; }
            c.el.style.display = '';
            const cw = c.el.offsetWidth, ch = c.el.offsetHeight, x = Math.max(minX, Math.min(((v.x + 1) / 2) * w - 28, maxX - cw)); let top = Math.max(minTop, ((1 - v.y) / 2) * h - ch - 10);
            for (let i = 0; i < 3; i++) { const hit = placed.find(p => x < p.x + p.w + 8 && x + cw > p.x - 8 && top < p.top + p.h + 8 && top + ch > p.top - 8); if (!hit) break; top = hit.top - ch - 10 < minTop ? hit.top + hit.h + 10 : hit.top - ch - 10; }
            placed.push({ x, top, w: cw, h: ch });
            c.el.style.transform = `translate(${x}px, ${top}px)`;
        }
        return placed;
    }
    // ---------- showcase: a slow tour for a screen on the desk ----------
    function setShowcase(on) {
        state.showcase = on ? { next: 0, i: -1, session: null } : null;
        root.classList.toggle('is-showcase', on); state.follow = null;
        if (on) { state.selected = null; $('#park-inspector', root).hidden = true; if (root.dataset.view !== 'overview') setView('overview'); }
        else actions.overview();
        try { history.replaceState(null, '', on ? '#showcase' : location.pathname + location.search); } catch { /* a viewer convenience only */ }
        return on;
    }
    function showcaseTick(now) {
        const sc = state.showcase, L = state.layout; if (!sc || !L || now < sc.next) return;
        const cards = [...state.cards.values()].sort((a, b) => b.urgent - a.urgent || b.updatedAt - a.updatedAt);
        const stops = [...cards.map(c => ({ session: c.sessionId })), { area: 'overview' }, ...(missions().some(m => ['run', 'need', 'plan'].includes(m.state)) ? [{ area: 'tasks' }] : [])];
        const stop = stops[(sc.i = sc.i + 1) % stops.length], spot = stop.session && L.spots.get(stop.session);
        sc.session = stop.session ?? null;
        view.goal = spot ? { target: spot.clone().setY(2), distance: 46 * portrait(1.6) } : areaGoal(stop.area);
        sc.next = now + (spot ? 12000 : 9000);
    }
    function showcaseFocus(pos, sessionRef) { const sc = state.showcase; if (!sc) return; sc.session = sessionRef; view.goal = { target: pos.clone().setY(2), distance: 52 * portrait(1.6) }; sc.next = performance.now() + 9000; }
    document.addEventListener('keydown', e => { if (e.key !== 'Escape' || root.hidden) return; if (state.showcase) setShowcase(false); state.follow = null; });

    /** Results and messages travel the task's route backwards (pavilion → plaza → gate); messages fly in an arc. */
    function flight(route, mesh, ms, arc = false) { dynamic.add(mesh); state.flights.push({ mesh, route: [...route].reverse().map(x => ({ ...x, reverse: !x.reverse })), start: performance.now(), ms, arc }); }

    // ---------- missions: one user goal, possibly many sessions ----------
    // Tasks group by the planner's missionId, else by their handoff/reply chain. The rolled-up state is the most urgent
    // of its steps: something waiting for you, then running, queued, an unresolved failure, done.
    let missionCache = { data: null, list: [] };
    function missions() {
        const d = state.data; if (!d) return []; if (missionCache.data === d) return missionCache.list;
        const by = new Map(), goals = new Map((d.goals ?? []).map(g => [g.id, g]));
        for (const t of d.tasks) { const k = t.missionKey ?? t.missionId ?? t.rootTaskId ?? t.id; if (!by.has(k)) by.set(k, []); by.get(k).push(t); }
        for (const g of goals.values()) if (!by.has(g.id)) by.set(g.id, []);
        const list = [...by].map(([key, ts]) => {
            ts.sort((a, b) => a.createdAt - b.createdAt);
            const goal = goals.get(key);
            if (!ts.length) return { key, goal, name: goal.title, full: null, steps: [], state: goalMissionState(goal, 'plan'), done: 0, total: 0, recovered: false, updatedAt: goal.updatedAt, createdAt: goal.createdAt, origin: goal.originKind, hosts: [], sessions: [], ...missionShape([]) };
            const done = ts.filter(t => t.state === 'completed'), lastDone = Math.max(0, ...done.map(t => t.updatedAt));
            const needs = ts.filter(t => ATTENTION.has(t.state)), running = ts.filter(t => ACTIVE.has(t.state) && !ATTENTION.has(t.state)), queued = ts.filter(t => t.state === 'queued');
            const failedOpen = ts.filter(t => t.state === 'failed' && lastDone <= t.updatedAt);
            const derived = needs.length ? 'need' : running.length ? 'run' : queued.length ? 'queue' : failedOpen.length ? 'fail' : done.length ? 'done' : 'cancel', st = goal ? goalMissionState(goal, derived) : derived;
            // A mission without a name borrows its first instruction, shortened; the full text stays one click away.
            const named = ts.find(t => t.missionName)?.missionName ?? goal?.title ?? ts.find(t => t.missionTitle)?.missionTitle;
            return { key, goal, name: named ?? shortTitle(taskTitle(ts[0])), full: named ? null : taskTitle(ts[0]), steps: ts, state: st, done: done.length, total: ts.length,
                recovered: st === 'done' && ts.some(t => t.state === 'failed'), updatedAt: Math.max(goal?.updatedAt ?? 0, ...ts.map(t => t.updatedAt)), createdAt: goal?.createdAt ?? ts[0].createdAt, origin: goal?.originKind ?? ts[0].originKind,
                hosts: [...new Set(ts.map(t => t.hostId))], sessions: [...new Set(ts.map(t => t.target))], ...missionShape(ts) };
        }).sort((a, b) => b.updatedAt - a.updatedAt);
        missionCache = { data: d, list }; return list;
    }
    const MISSION_STATE = { need: ['需要你', 'warn'], run: ['進行中', 'run'], plan: ['規劃中', 'queue'], queue: ['排隊', 'queue'], fail: ['失敗未處理', 'err'], done: ['完成', 'done'], cancel: ['已取消', 'off'] };
    /** A goal speaks for its mission: a plan or a question waiting for an answer needs you; the planner's own verdict ends it. */
    function goalMissionState(g, derived) {
        if (g.state === 'awaiting_approval') return 'need';
        if (g.state === 'done') return derived === 'run' || derived === 'need' ? derived : 'done';
        if (g.state === 'failed') return 'fail';
        if (g.state === 'canceled') return derived === 'run' ? 'run' : 'cancel';
        const last = g.messages.at(-1);
        if (last?.from === 'planner' && last.kind === 'question') return 'need';
        return derived === 'done' || derived === 'cancel' ? 'plan' : derived;
    }
    const missionWord = m => m.state === 'done' && m.recovered ? '重試後完成' : MISSION_STATE[m.state][0];
    const DAY = 86400000, inGarden = m => !['done', 'cancel'].includes(m.state) || Date.now() - m.updatedAt < DAY;
    const GOAL_STATE = { open: ['規劃中', 'queue'], awaiting_approval: ['方案待批', 'warn'], active: ['執行中', 'run'], done: ['完成', 'done'], failed: ['失敗', 'err'], canceled: ['已取消', 'off'] };
    const GOAL_KIND = { goal: '目標', reply: '回覆', question: '提問', update: '進度', plan: '方案', decision: '決定', done: '完成', failed: '失敗', canceled: '取消' };
    /** The goal behind a mission: the user's words, the planner's plan (approve or reject it here), and the conversation. */
    function goalSection(g) {
        const [word, cls] = GOAL_STATE[g.state] ?? [g.state, 'off'], open = !['done', 'failed', 'canceled'].includes(g.state);
        const who = m => m.from === 'planner' ? '規劃者' : m.from === 'owner' ? '你' : clientName(m.clientId);
        const plan = g.plan ? `<div class="goal-plan"><h4>方案</h4><pre class="task-text">${esc(g.plan.text)}</pre>${g.plan.decision ? `<p class="perm-note">${g.plan.decision.approve ? '已批准' : '已退回'} · ${esc(clientName(g.plan.decision.by))} · ${esc(relTime(g.plan.decision.at))}${g.plan.decision.note ? `：${esc(g.plan.decision.note)}` : ''}</p>`
            : can('plan') ? `<form class="goal-decide" data-goal="${esc(g.id)}"><input name="note" maxlength="1000" placeholder="附註（可選）"><div class="perm-actions"><button type="submit" class="park-btn primary" data-decision="approve">批准方案</button><button type="submit" class="park-btn ghost" data-decision="reject">退回</button></div></form>` : '<p class="perm-note">等前臺或你批准</p>'}</div>` : '';
        return `<section class="goal-box"><p class="goal-state"><b class="state-${cls}">${esc(word)}</b><span>${esc(clientName(g.originKind))} 交給規劃者 · ${esc(relTime(g.createdAt))}</span></p>
          <blockquote class="goal-text">${esc(g.text)}</blockquote>${plan}
          <h4>對話</h4>${g.messages.slice(-12).map(m => `<div class="goal-msg from-${esc(m.from)}"><p><b>${esc(who(m))}</b><em>${esc(GOAL_KIND[m.kind] ?? m.kind)}</em><time>${esc(relTime(m.at))}</time></p><div>${esc(m.text)}</div></div>`).join('')}
          ${open && can('goal') ? `<details class="task-more" data-open-key="goal-reply:${esc(g.id)}"><summary>回覆規劃者</summary><form class="goal-reply" data-goal="${esc(g.id)}"><textarea name="text" rows="3" required placeholder="回答它的問題，或補充要求…"></textarea><div class="task-actions"><button type="submit" class="park-btn primary">送出</button><button type="button" class="park-btn ghost" data-goal-cancel="${esc(g.id)}">取消這個目標</button></div></form></details>` : ''}</section>`;
    }
    function missionTag(el, m) {
        el.innerHTML = `<i style="--c:${clientColor(m.origin)}"></i><b>${esc(m.name)}</b><span class="tag-state state-${MISSION_STATE[m.state][1]}">${esc(missionWord(m))}${m.total > 1 ? ` · ${m.done}/${m.total}` : ''}</span>`;
        el.title = `${m.full ?? m.name}\n${m.parts.length ? `${m.parts.map(b => b.part).join('、')} · ` : ''}${m.total} 步 · ${m.hosts.length} 台機器 · ${clientName(m.origin)} 發起`;
    }
    /** Plants follow the missions: front row needs you, middle row is working, back row finished within a day. */
    function syncGarden() {
        const L = state.layout; if (!L?.garden || !state.gardenGroup) return;
        const all = missions(), shown = all.filter(inGarden), rows = { front: [], middle: [], back: [] };
        for (const m of shown) rows[m.state === 'need' || m.state === 'fail' ? 'front' : ['run', 'queue', 'plan'].includes(m.state) ? 'middle' : 'back'].push(m);
        const count = $('#park-greenhouse-count', root); if (count) count.textContent = `${all.length - shown.length} 件歷史`;
        const sig = JSON.stringify(Object.entries(rows).map(([k, list]) => [k, list.map(m => [m.key, m.steps.map(t => [t.state, t.originKind, t.missionPart ?? '', t.dependencyId ?? t.replyToTaskId ?? ''].join(':')).join(',')])]));
        if (sig !== state.gardenSig) { state.gardenSig = sig; plantRows(rows); }
        for (const m of shown) { const o = state.objects.get('label:mission:' + m.key); if (o) { missionTag(o.el, m); o.important = ['need', 'fail', 'run'].includes(m.state); o.finished = ['done', 'cancel'].includes(m.state); o.el.classList.toggle('is-selected', state.selected?.kind === 'mission' && state.selected.id === m.key); } }
    }
    function plantRows(rows) {
        const gg = state.gardenGroup; if (state.plantGroup) gg.remove(state.plantGroup);
        for (const [k, o] of [...state.objects]) if (k.startsWith('label:mission:')) { o.el.remove(); state.objects.delete(k); }
        gardenPick.length = 0; state.plants.clear();
        const pg = new THREE.Group(); gg.add(pg); state.plantGroup = pg;
        const PER = 6, bedW = GARDEN_W - 28, step = bedW / (PER - 1), SCALE = 2.3;
        for (const [row, list] of Object.entries(rows)) list.slice(0, PER * 2).forEach((m, i) => {
            const plant = taskPlant(m, clientColor), lane = Math.floor(i / PER), twoLanes = list.length > PER, inLane = Math.min(PER, list.length - lane * PER);
            // centred in the bed, so a few plants stand in the middle rather than at the far end
            plant.position.set(-8 + ((i % PER) - (inLane - 1) / 2) * step + (lane ? step / 2 : 0), 0, GARDEN_ROWS[row] + (twoLanes ? (lane ? -1.6 : 1.4) : 0));
            plant.rotation.y = (i * 1.3) % (Math.PI * 2); plant.scale.setScalar(SCALE); pg.add(plant); plant.traverse(o => { if (o.isMesh) gardenPick.push(o); });
            gg.updateMatrixWorld(true);
            const pos = gg.localToWorld(plant.position.clone());
            state.plants.set(m.key, { group: plant, pos, mission: m, height: plant.userData.height * SCALE });
            const el = label('mission:' + m.key, '', pos.clone().setY(plant.userData.height * SCALE + 0.6), 'mission', () => select({ kind: 'mission', id: m.key }));
            missionTag(el, m); Object.assign(state.objects.get('label:mission:' + m.key), { important: ['need', 'fail', 'run'].includes(m.state), finished: ['done', 'cancel'].includes(m.state) });
        });
    }
    /** Where the camera rests in each view: the whole world, the machine park, or the task garden. */
    const gardenFit = () => Math.min(MAX_DISTANCE, GARDEN_W * 1.35 * portrait(2));
    const worldFit = () => { const g = state.layout?.garden; return g ? Math.min(MAX_DISTANCE, (g.parkR + g.center.length() + GARDEN_W / 2) * 1.5 * portrait(2.2)) : fitDistance(); };
    function areaGoal(v) {
        const g = state.layout?.garden;
        if (v === 'policy') return { target: new THREE.Vector3(), distance: fitDistance() * 0.62 }; // the Router hub: rules and the planner live there
        if (!g || v === 'machines') return { target: new THREE.Vector3(), distance: fitDistance() };
        if (v === 'tasks') return { target: g.center.clone().addScaledVector(g.right, -4), distance: gardenFit() }; // the beds sit left of the greenhouse
        return { target: g.right.clone().multiplyScalar((GARDEN_W + 12) / 2), distance: worldFit() }; // midway between the park's left edge and the garden's right edge
    }

    // ---------- HUD panels ----------
    function renderRoster() {
        const d = state.data, el = $('#park-roster', root);
        if (el.contains(document.activeElement) && document.activeElement.matches('input')) return; // a rename in progress
        const pen = (kind, id, name, original, always) => canEdit() ? `<button type="button" class="roster-rename${always ? ' always' : ''}" title="改名" aria-label="改名 ${esc(name)}" data-rename-kind="${kind}" data-rename-id="${esc(id)}" data-name="${esc(name)}" data-original="${esc(original ?? '')}">${PEN}</button>` : '';
        el.innerHTML = d.hosts.hosts.map(h => {
            const ss = d.sessions.filter(s => s.hostId === h.id), online = d.hosts.daemons.filter(x => x.hostId === h.id).some(x => x.connection === 'online');
            return `<section class="roster-host"><div class="roster-line"><button class="roster-host-head" data-host="${esc(h.id)}" title="${esc(h.description ?? '')}"><i style="--c:${online ? '#3a9a5b' : '#9aa0a6'}"></i><b>${esc(h.label)}</b><span>${online ? ss.length : '離線'}</span></button>${pen('host', h.id, h.label, h.configLabel, true)}</div>
            ${ss.map(s => { const st = sessionState(s); return `<div class="roster-line"><button class="roster-row" data-session="${esc(s.id)}" title="${esc(`${provider(s).name} · ${st.full}`)}"><i style="--c:${provider(s).roof}"></i><span class="roster-name">${esc(nameOf(s))}</span>${st.cls === 'idle' ? '' : `<span class="roster-state state-${st.cls}">${esc(st.text)}</span>`}</button>${pen('session', s.id, nameOf(s), s.title, false)}</div>`; }).join('') || '<p class="roster-empty">還沒有 session</p>'}</section>`;
        }).join('');
        el.querySelectorAll('[data-host]').forEach(b => { b.onclick = () => select({ kind: 'host', id: b.dataset.host }); b.ondblclick = () => { select({ kind: 'host', id: b.dataset.host }); startRename(); }; });
        el.querySelectorAll('[data-session]').forEach(b => { b.onclick = () => select({ kind: 'session', id: b.dataset.session }); b.ondblclick = () => { select({ kind: 'session', id: b.dataset.session }); startRename(); }; });
        // ✎ renames right in the list: one click, Enter saves, Esc cancels.
        el.querySelectorAll('[data-rename-kind]').forEach(b => b.onclick = (e) => { e.stopPropagation(); const { renameKind: kind, renameId: id, name, original } = b.dataset; renameInPlace(b.closest('.roster-line'), { kind, id, name, original }, () => renderRoster()); });
    }
    const canEdit = () => state.data.identity.scopes.includes('admin');
    /** Requests a session is waiting on: what it wants to run, who assigned the turn, and one-shot allow / deny. */
    function permissionBox(s) {
        const list = (state.data.permissions ?? []).filter(x => x.sessionRef === s.id); if (!list.length) return '';
        // a service turn's own note (serviceTurnNote) already says that only you approve it
        const approvers = x => x.routerTurn === 'service' ? '' : x.level === 'L4' || x.ownerOnly ? '只有你能批' : `可批：你${x.approvers?.includes('planner') ? '、規劃者' : ''}${x.approvers?.includes('frontend') ? '、派工的前臺' : ''}`;
        return `<section class="perm-box"><h3>等你批准</h3>${list.map(x => `<div class="perm">
            <p class="perm-head">${x.level ? `<span class="lv lv-${esc(x.level)}" title="${esc(x.why ?? '')}">${esc(x.level)} ${esc(x.levelName ?? '')}</span>` : ''}<b>${esc(x.tool)}</b>${x.description || x.title ? ` · ${esc(x.description || x.title)}` : ''}</p>
            ${x.detail ? `<pre class="perm-detail">${esc(x.detail)}</pre>` : ''}
            ${serviceTurnNote(x)}
            ${x.level ? `<p class="perm-note">${approvers(x) ? `${esc(approvers(x))} · ` : ''}${x.rule ? `規則 ${esc(x.rule)}` : '認不出來，按最高級處理'}${x.plannerSession ? ' · 這是規劃者自己的 session' : ''}</p>` : ''}
            ${x.canRespond ? `<div class="perm-actions"><button type="button" class="park-btn primary" data-perm="${esc(x.requestId)}" data-session="${esc(x.sessionRef)}" data-decision="allow">批准這一次</button><button type="button" class="park-btn ghost" data-perm="${esc(x.requestId)}" data-session="${esc(x.sessionRef)}" data-decision="deny">拒絕</button></div>` : `<p class="perm-note">${esc(x.reason ?? '')}</p>`}
            <p class="perm-note">${x.assignedBy ? `${esc(clientName(x.assignedBy))} 派的任務` : '不是經 Router 派的任務'}</p>
            ${x.routerTurn === 'service' && x.detail && /bash|shell|command/i.test(x.tool) ? `<p class="perm-note">要以後自動放行：把這條命令加進 ${esc(x.ask?.service ?? '這個服務')} 的「可跑的命令」（權限 › 服務呼叫）；等級規則不會替 Router 的服務輪批准。</p>` : ''}
            ${x.routerTurn !== 'service' && x.detail && state.data.identity?.scopes?.includes('admin') && /bash|shell|command/i.test(x.tool) ? `<details class="perm-rule"><summary>以後這條命令算…</summary><form class="perm-rule-form" data-detail="${esc(x.detail)}"><select name="level">${['L0', 'L1', 'L2', 'L3', 'L4'].map(l => `<option${l === x.level ? ' selected' : ''}>${l}</option>`).join('')}</select><button type="submit" class="park-btn">記下規則</button></form></details>` : ''}</div>`).join('')}</section>`;
    }
    function bindPermissions() {
        root.querySelectorAll('[data-perm]').forEach(b => b.onclick = async () => {
            const allow = b.dataset.decision === 'allow';
            root.querySelectorAll('[data-perm]').forEach(x => { x.disabled = true; });
            // the request belongs to its session, whichever panel (session or task) shows it
            try { await api.respondPermission({ sessionRef: b.dataset.session, requestId: b.dataset.perm, decision: b.dataset.decision }); api.toast(allow ? '已批准這一次' : '已拒絕'); }
            catch (err) { api.toast(err.message, true); }
            renderInspector(true);
        });
    }
    /** The name at the top of the panel is where renaming happens: ✎ or a double-click turns it into an input. */
    function titleBlock(kind, id, name, original) {
        return `<div class="inspector-title" data-kind="${kind}" data-id="${esc(id)}" data-name="${esc(name)}" data-original="${esc(original ?? '')}"><h2>${esc(name)}</h2>${canEdit() ? `<button type="button" class="rename-btn" title="改名（也可以雙擊名字）">${PEN}<span>改名</span></button>` : ''}</div>`;
    }
    function startRename() { $('.inspector-title .rename-btn', root)?.click(); }
    const PEN = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4"/></svg>';
    /** Turn a name into an input in place. Enter saves, Esc cancels, leaving the field saves; empty restores the config name. */
    function renameInPlace(box, { kind, id, name, original }, after) {
        let done = false;
        box.classList.add('is-renaming');
        box.innerHTML = `<input class="rename-input" maxlength="80" value="${esc(name)}" placeholder="${esc(original ? `留空恢復原名：${original}` : '新名稱')}" aria-label="新名稱"><p class="rename-hint">Enter 儲存 · Esc 取消</p>`;
        const input = $('.rename-input', box); input.focus(); input.select();
        const finish = async (save) => {
            if (done) return; done = true;
            const value = input.value.trim();
            if (save && value !== name) {
                input.disabled = true;
                try { await api.annotate({ kind, id, displayName: value || null }); api.toast(value ? '已改名' : '已恢復原名'); }
                catch (err) { api.toast(err.message, true); }
            }
            input.blur(); after();
        };
        input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); finish(true); } else if (e.key === 'Escape') { e.preventDefault(); finish(false); } };
        input.onblur = () => finish(true);
    }
    function bindRename() {
        const box = $('.inspector-title', root); if (!box || !canEdit()) return;
        const begin = () => renameInPlace(box, box.dataset, () => renderInspector(true));
        $('.rename-btn', box).onclick = begin; $('h2', box).ondblclick = begin;
    }
    function editForm(kind, id, fields) {
        if (!canEdit()) return '<p class="inspector-note">只有管理員能修改名稱與說明。</p>';
        return `<form class="inspector-form" data-kind="${kind}" data-id="${esc(id)}">
          <label>說明<textarea name="description" maxlength="1000" rows="3" placeholder="${kind === 'host' ? '這台機器上有什麼數據、資源，用來做什麼' : kind === 'session' ? '這個 session 負責什麼工作' : '用這個模板建的 session 適合做什麼'}">${esc(fields.description ?? '')}</textarea></label>
          ${kind !== 'template' ? `<label>標籤<input name="tags" value="${esc((fields.tags ?? []).join(', '))}" placeholder="data, research"></label>` : ''}
          ${kind === 'host' ? `<label>規則（每行一條）<textarea name="rules" rows="2" placeholder="這台沒有實盤憑證，不要在這裡下單">${esc((fields.rules ?? []).join('\n'))}</textarea></label>` : ''}
          <div class="inspector-actions"><button type="submit" class="park-btn primary">儲存</button><span class="inspector-hint">寫給大腦看的說明，不是權限控制</span></div></form>`;
    }
    const can = scope => state.data.identity.scopes.includes(scope) || state.data.identity.scopes.includes('admin');
    const taskLink = t => `<button type="button" class="mini-task" data-task="${esc(t.id)}"><i style="--c:${clientColor(t.originKind)}"></i><span>${esc(clientName(t.originKind))} → <b class="state-${taskCls(t.state)}">${esc(STATE_NAMES[t.state] ?? t.state)}</b></span><em>${esc(shortTitle(taskTitle(t), 44))}</em></button>`;
    const hostLabel = id => state.data.hosts.hosts.find(h => h.id === id)?.label ?? id;
    /** Send work to this session. Busy sessions queue it; the running turn is never interrupted. */
    function composer(s) {
        if (!s.allowedActions?.includes('submit')) return '';
        return `<form class="composer" data-session="${esc(s.id)}"><h3>派任務</h3><textarea name="prompt" rows="3" required placeholder="要它做什麼…"></textarea>
          <div class="inspector-actions"><button type="submit" class="park-btn primary">送出</button><span class="inspector-hint">${s.activeTurnId || s.nativeStatus === 'running' ? '它正在忙：會排在這一輪之後，不會打斷' : '它現在空閒，會馬上送出'}</span></div></form>`;
    }
    function dispatchControl(s) {
        if (!s.worker || !can('bind')) return '';
        const paused = s.worker.mode !== 'managed';
        return `<div class="dispatch-row"><span>${paused ? '後續派工已暫停' : '派工正常'} · worker ${esc(s.worker.alias ?? s.worker.id)}</span><button type="button" class="park-btn" data-dispatch="${paused ? 'managed' : 'paused'}" data-worker="${esc(s.worker.id)}" data-rev="${s.worker.revision}">${paused ? '恢復派工' : '暫停後續派工'}</button></div>`;
    }
    const frontierCache = new Map();
    const frontierSection = s => s.workspaceId ? `<details class="task-more" data-open-key="frontier:${esc(s.workspaceId)}" data-frontier="${esc(s.workspaceId)}" data-session="${esc(s.id)}"><summary>工作區筆記（Frontier）</summary><div class="frontier-body">${frontierCache.get(s.workspaceId) ?? '<p class="muted">載入中…</p>'}</div></details>` : '';
    async function loadFrontier(dd) {
        const ws = dd.dataset.frontier, body = $('.frontier-body', dd);
        try {
            const f = await api.read('psr_get_frontier', { workspaceId: ws }), cards = Object.entries(f.cards ?? {});
            const html = `${cards.length ? cards.map(([id, c]) => `<div class="fr-card"><b>${esc(id)}</b><p><span>現在</span>${esc(c.current)}</p><p><span>下一步</span>${esc(c.next)}</p></div>`).join('') : '<p class="muted">還沒有筆記。</p>'}
              ${can('frontier') ? `<form class="fr-form" data-rev="${f.revision}"><input name="card" required maxlength="160" placeholder="卡片名稱，例如 maker-fill"><textarea name="current" rows="2" required placeholder="現在的狀態"></textarea><textarea name="next" rows="2" required placeholder="下一步"></textarea><button class="park-btn primary" type="submit">寫入</button></form>` : ''}
              <p class="inspector-hint">修訂 ${f.revision} · ${cards.length}/16 張卡片 · 同一份筆記所有入口共用</p>`;
            frontierCache.set(ws, html); body.innerHTML = html;
        } catch (err) { body.innerHTML = `<p class="muted">${esc(err.message)}</p>`; return; }
        const form = $('.fr-form', body); if (!form) return;
        form.oninput = () => { form.dataset.dirty = '1'; };
        form.onsubmit = async (e) => {
            e.preventDefault(); const v = n => form.elements.namedItem(n).value.trim();
            try { await api.act('psr_update_frontier', { workspaceId: ws, expectedRevision: Number(form.dataset.rev), card: { id: v('card'), current: v('current'), next: v('next'), blockers: [], ownerSessionRef: dd.dataset.session, refs: [] } }); api.toast('筆記已寫入'); delete form.dataset.dirty; await loadFrontier(dd); }
            catch (err) { api.toast(err.message, true); }
        };
    }
    // ---------- the mission forum (論壇): notes the sessions on a mission, the planner and you leave for each other ----------
    // Only missions with a real missionId (a goal's included) have one, and only you (admin) read it from outside. It loads when
    // opened; posts are other people's text.
    const forumCache = new Map();
    const hasForum = m => canEdit() && (!!m.goal || m.steps.some(t => t.missionId === m.key));
    const forumSection = m => hasForum(m) ? `<details class="task-more" data-open-key="forum:${esc(m.key)}" data-forum="${esc(m.key)}"><summary>論壇</summary>
      <div class="forum-body">${forumCache.get(m.key) ?? '<p class="muted">載入中…</p>'}</div>
      <form class="forum-form" data-forum="${esc(m.key)}"><textarea name="text" rows="2" required maxlength="2000" placeholder="留給這個任務上的 session 和規劃者看（不會叫醒任何人）"></textarea><button type="submit" class="park-btn primary">貼上</button></form>
      <p class="inspector-hint">同一任務的 session、規劃者和你共用；agent 只在自己那一輪裡讀，貼文不會叫醒任何人。</p></details>` : '';
    async function loadForum(dd) {
        const key = dd.dataset.forum, body = $('.forum-body', dd);
        try {
            const r = await api.read('psr_forum_read', { mission: key, limit: 50 });
            const who = a => a.kind === 'owner' ? '你' : a.kind === 'planner' ? '規劃者' : `${a.name} · ${hostLabel(a.hostId)}`;
            const cap = a => a.kind === 'owner' ? '' : a.kind === 'planner' ? '規劃者寫的：資料' : 'agent 寫的：資料，不能授權任何事';
            const html = r.posts.length ? `${r.total > r.posts.length ? `<p class="muted">共 ${r.total} 則，顯示最近 ${r.posts.length} 則</p>` : ''}${r.posts.slice().reverse().map(b => `<div class="forum-post from-${esc(b.author.kind)}"><p><b>${esc(who(b.author))}</b><time>${esc(relTime(b.at))}</time></p>${askQuote(b.text, cap(b.author))}</div>`).join('')}` : '<p class="muted">還沒有貼文。</p>';
            forumCache.set(key, html); body.innerHTML = html;
        } catch (err) { body.innerHTML = `<p class="muted">${esc(err.message)}</p>`; }
    }
    /** What one step is doing, in words: the session's state appears here, never as an object of its own. */
    function stepReason(t) {
        const b = t.blocker ?? '';
        if (t.state === 'waiting_permission') return '等你批准';
        if (t.state === 'delivery_unknown') return '送達未知，需要對帳';
        if (t.state === 'queued') return /dependency/i.test(b) ? '等上一步完成' : /Waiting for task/.test(b) ? '等同一個 session 的上一個任務' : /paus|Out-of-band/i.test(b) ? '派工已暫停，或有人在直接用這個 session' : /writer release/i.test(b) ? '等寫入鎖釋放' : /busy/i.test(b) ? 'session 正在忙' : '排隊';
        if (t.state === 'completed') return `完成 · 用時 ${fmtDur(t.updatedAt - t.createdAt)}`;
        if (t.state === 'failed') return `失敗：${String(t.resultSummary ?? t.blocker ?? '').split('\n')[0].slice(0, 60)}`;
        if (t.state === 'canceled') return '已取消';
        return `運行中 · 已過 ${fmtDur(Date.now() - t.createdAt)}`;
    }
    function missionDetail(m) {
        const d = state.data, [, cls] = MISSION_STATE[m.state], sessions = m.sessions.map(id => d.sessions.find(s => s.id === id)).filter(Boolean);
        const step = (t, depth) => { const s = d.sessions.find(x => x.id === t.target); return `<button type="button" class="mini-step" style="--depth:${depth}" data-task="${esc(t.id)}"><i class="t-dot state-${taskCls(t.state)}"></i><span class="ms-main"><b title="${esc(taskTitle(t))}">${t.routerTurn === 'service' ? '<em class="t-kind">服務</em>' : t.dependencyId ? '<em class="t-kind">交接</em>' : t.replyToTaskId ? '<em class="t-kind">回覆</em>' : ''}${esc(shortTitle(taskTitle(t), 40))}</b><em>${esc(stepReason(t))}</em><small>${esc(hostLabel(t.hostId))} · ${esc(s ? nameOf(s) : t.target)}</small></span></button>`; };
        const chain = (t, depth) => step(t, depth) + (m.kids.get(t.id) ?? []).map(c => chain(c, depth + 1)).join('');
        const loose = m.branches.filter(b => !b.part).flatMap(b => b.roots);
        const steps = m.parts.length ? m.parts.map(b => `<h4 class="m-part"><i class="t-dot state-${taskCls(partState(b))}"></i>${esc(b.part)}<span>${b.steps.filter(t => t.state === 'completed').length}/${b.steps.length} 步完成 · ${new Set(b.steps.map(t => t.hostId)).size} 台機器</span></h4>${b.roots.map(t => chain(t, 0)).join('')}`).join('')
            + (loose.length ? `<h4 class="m-part m-part-loose">未分組</h4>${loose.map(t => chain(t, 0)).join('')}` : '') : loose.map(t => chain(t, 0)).join('');
        return `<p class="eyebrow">任務 · ${esc(clientName(m.origin))} 發起 · ${m.total} 步 · ${m.hosts.length} 台機器</p>
          ${titleBlock('mission', m.key, m.name, m.steps.find(t => t.missionTitle)?.missionTitle ?? '')}<p class="inspector-id">${esc(m.key)}</p>
          ${m.full && m.name !== m.full ? `<p class="inspector-text mission-full">${esc(m.full)}</p>` : ''}
          <p class="task-state state-${cls}"><b>${esc(missionWord(m))}</b><span>${m.total ? `${m.done}/${m.total} 步完成 · ` : ''}${esc(relTime(m.updatedAt))}更新</span></p>
          ${m.total ? `<div class="m-progress" role="img" aria-label="${m.done}/${m.total} 步完成">${m.steps.map(t => `<i class="state-${taskCls(t.state)}"></i>`).join('')}</div>` : ''}
          ${m.goal ? goalSection(m.goal) : ''}
          ${sessions.map(permissionBox).join('')}
          ${forumSection(m)}
          ${filesBlock(transfersNow().filter(t => t.missionId === m.key), '檔案', false)}
          ${m.total ? `<h3>${m.parts.length ? `子任務 · ${m.parts.length} 個` : '步驟'}</h3>${steps}` : '<p class="inspector-hint">規劃者還沒派出任何步驟。</p>'}
          ${can('submit') ? regroupForm(m) : ''}`;
    }
    /** A part's state: the most urgent of its steps, as for a mission (a failure a later step fixed does not count). */
    const partState = b => { const s = b.steps, lastDone = Math.max(0, ...s.filter(t => t.state === 'completed').map(t => t.updatedAt));
        return s.find(t => ATTENTION.has(t.state))?.state ?? s.find(t => ACTIVE.has(t.state))?.state ?? s.find(t => t.state === 'queued')?.state ?? (s.some(t => t.state === 'failed' && t.updatedAt >= lastDone) ? 'failed' : lastDone ? 'completed' : s.at(-1).state); };
    /** Tidy a mission by hand: pull in other missions that belong to the same goal, sort chains into named parts (子任務), or
     * split chains back out. Organizational only; nothing is resent. */
    function regroupForm(m) {
        const near = missions().filter(x => x.key !== m.key)
            .sort((a, b) => (a.origin === m.origin ? 0 : 1) - (b.origin === m.origin ? 0 : 1) || Math.abs(a.createdAt - m.createdAt) - Math.abs(b.createdAt - m.createdAt)).slice(0, 12);
        const box = (name, value, title, sub) => `<label class="rg-item"><input type="checkbox" name="${name}" value="${esc(value)}"><span><b>${esc(title)}</b><small>${esc(sub)}</small></span></label>`;
        const roots = m.branches.flatMap(b => b.roots);
        return `<details class="task-more" data-open-key="regroup:${esc(m.key)}"><summary>整理：合併其他任務、分子任務</summary>
          <form class="regroup-form" data-mission="${esc(m.key)}">
            ${roots.length > 1 ? `<p class="rg-head">這個任務裡的步驟</p>${roots.map(t => box('own', t.id, shortTitle(taskTitle(t), 32), `${t.missionPart ? `子任務 ${t.missionPart} · ` : ''}${hostLabel(t.hostId)} · ${relTime(t.createdAt)}`)).join('')}` : ''}
            ${near.length ? `<p class="rg-head">其他任務（勾選後併進來）</p>${near.map(x => box('other', x.key, x.name, `${x.total} 步 · ${x.hosts.map(hostLabel).join('、')} · ${clientName(x.origin)} · ${relTime(x.createdAt)}`)).join('')}` : ''}
            <label class="rg-part">子任務名稱<input name="part" maxlength="40" placeholder="例如 盤點、升級；留空＝不分組"></label>
            <div class="task-actions"><button type="submit" class="park-btn primary">把勾選的放進這個任務</button>${roots.length > 1 ? '<button type="button" class="park-btn" data-split>勾選的步驟拆成獨立任務</button>' : ''}</div>
          </form></details>`;
    }
    /** Where a task's acceptance stands, in one phrase. */
    const VERIFY_LABELS = { 'judgment-only': '只有仲裁者判斷，沒有機械驗證', 'same-family': '仲裁者和幹活的是同一家模型', unverified: '沒有判決' };
    function verifyWord(t) {
        const v = t.verification ?? {};
        const word = v.status === 'passed' ? '驗收通過' : v.status === 'failed' ? '驗收未通過' : v.status === 'pending' ? (v.stage === 'verifier' ? '驗證器檢查中' : '等仲裁者驗收') : t.verify ? (v.stage === 'done' ? '沒有驗收結果' : '做完後會驗收') : '未驗收（完成不等於做對）';
        return word + (v.labels?.length ? ` · ${v.labels.map(l => VERIFY_LABELS[l] ?? l).join('、')}` : '');
    }
    /** The criteria the task was checked against, each with the arbiter's evidence once there is a verdict. */
    function verifyBox(t) {
        const v = t.verification ?? {}, judged = v.criteria ?? [];
        return `<h3>驗收標準</h3><ol class="verify-list">${t.verify.criteria.map((c, i) => { const j = judged[i]; return `<li class="${j ? (j.pass ? 'is-pass' : 'is-fail') : ''}"><b>${j ? (j.pass ? '✓' : '✕') : '·'}</b><span>${esc(c)}${j ? `<small>${esc(j.evidence)}</small>` : ''}</span></li>`; }).join('')}</ol>
          ${v.verifier ? `<p class="inspector-hint">${esc(v.verifier.replace(/^arbiter:/, '仲裁者 ').replace(/^verifier:/, '驗證器 '))}${v.decidedAt ? ` · ${esc(relTime(v.decidedAt))}` : ''}</p>` : ''}
          ${v.stage === 'done' && v.status === 'not_run' && v.evidence ? `<p class="inspector-hint">${esc(v.evidence)}</p>` : ''}
          ${v.verifierOutput ? `<details class="task-more"><summary>驗證器輸出（exit ${esc(v.verifierExit)}）</summary><pre class="task-text">${esc(v.verifierOutput)}</pre></details>` : ''}`;
    }
    /** Everything about one task: where it went, what it was told, what came back, what it spawned, what you can do now. */
    function taskDetail(t) {
        const d = state.data, s = d.sessions.find(x => x.id === t.target), parentId = t.dependencyId ?? t.replyToTaskId, parent = parentId && d.tasks.find(x => x.id === parentId);
        const children = d.tasks.filter(x => (x.dependencyId ?? x.replyToTaskId) === t.id), msgs = d.messages.filter(m => m.taskId === t.id), done = TERMINAL.has(t.state);
        const mission = missions().find(x => x.key === t.missionKey);
        const retry = d.tasks.find(x => x.retryOf === t.id), checked = t.verifyOf && d.tasks.find(x => x.id === t.verifyOf);
        return `<p class="eyebrow">任務 · ${esc(clientName(t.originKind))} 派出${t.routerTurn === 'arbiter' ? ' · 驗收' : t.routerTurn === 'service' ? ' · 服務呼叫' : t.retryOf ? ' · 自動重試' : t.dependencyId ? ' · 交接' : t.replyToTaskId ? ' · 回覆' : ''}</p>
          ${mission && (mission.total > 1 || t.missionId) ? `<p class="inspector-hint">屬於 <button type="button" class="link" data-goto-mission="${esc(mission.key)}">${esc(mission.name)}</button>${t.missionPart ? ` › 子任務 ${esc(t.missionPart)}` : ''} · 第 ${mission.steps.indexOf(t) + 1}/${mission.total} 步</p>` : ''}
          <h2 class="task-title" title="${esc(taskTitle(t))}">${esc(shortTitle(taskTitle(t), 40))}</h2><p class="inspector-id">${esc(t.id)}</p>
          <p class="task-state state-${taskCls(t.state)}"><b>${esc(STATE_NAMES[t.state] ?? t.state)}</b>${t.blocker && t.blocker !== 'AWAITING_WRITER_RELEASE' ? `<span>${esc(t.blocker)}</span>` : ''}</p>
          <dl><dt>交給</dt><dd>${s ? `<button type="button" class="link" data-goto-session="${esc(s.id)}">${esc(nameOf(s))}</button>` : esc(t.target)} · ${esc(hostLabel(t.hostId))}</dd>
            <dt>建立</dt><dd>${esc(fmtTime(t.createdAt))}</dd><dt>${done ? '用時' : '已過'}</dt><dd>${esc(fmtDur((done ? t.updatedAt : Date.now()) - t.createdAt))}</dd>
            ${t.routerTurn ? '' : `<dt>驗收</dt><dd class="verify-${esc(t.verification?.status ?? 'not_run')}">${esc(verifyWord(t))}</dd>`}
            ${t.lockHeld ? '<dt>寫入鎖</dt><dd>還佔著</dd>' : ''}</dl>
          ${checked ? `<h3>驗收的是</h3>${taskLink(checked)}` : ''}${t.verify ? verifyBox(t) : ''}
          ${retry ? `<p class="inspector-hint">這一輪只回了暫時性錯誤，Router 已自動重試一次：</p>${taskLink(retry)}` : ''}
          ${t.retryOf && d.tasks.find(x => x.id === t.retryOf) ? `<h3>重試自</h3>${taskLink(d.tasks.find(x => x.id === t.retryOf))}` : ''}
          ${parent ? `<h3>${t.routerTurn === 'service' ? '替這個任務回答' : '接續自'}</h3>${taskLink(parent)}` : ''}
          ${children.length ? `<h3>後續步驟</h3>${children.map(taskLink).join('')}` : ''}
          ${s ? permissionBox(s) : ''}
          ${askSection(t)}
          <h3>指令</h3><pre class="task-text">${esc(t.prompt)}</pre>
          ${t.resultSummary ? `<h3>結果</h3><pre class="task-text is-result">${esc(t.resultSummary)}</pre>` : ''}
          ${msgs.length ? `<h3>中途消息</h3>${msgs.map(m => `<div class="mini-msg"><b>${esc(m.kind)}</b><span>${esc(m.text)}</span></div>`).join('')}` : ''}
          ${t.approvals?.length ? `<h3>審批記錄</h3>${t.approvals.map(a => `<div class="mini-msg"><b>${a.decision === 'allow' ? '批准' : '拒絕'}</b><span>${esc(clientName(a.by))}${a.rule ? `（規則 ${esc(a.rule)}）` : ''} · ${esc(fmtTime(a.at))} · ${esc(a.tool)}${a.detail ? `：${esc(a.detail)}` : ''}</span></div>`).join('')}` : ''}
          ${taskActions(t)}
          ${mission?.total === 1 && can('submit') ? regroupForm(mission) : ''}
          ${t.completionEvidence && !/^Native turn_\w+ for /.test(t.completionEvidence) ? `<p class="inspector-hint">${esc(t.completionEvidence)}</p>` : ''}`;
    }
    function taskActions(t) {
        const d = state.data, out = [];
        // Queued work is cancelled in the Router. A running turn, or one waiting for an answer, is interrupted through the daemon
        // (that turn only, the session stays) where the adapter can; otherwise say where to stop it instead of a dead button.
        const canStopTurn = d.hosts.daemons.find(x => x.id === t.daemonId)?.capabilities?.cancel === true;
        if (t.state === 'queued' && can('cancel')) out.push(`<div class="task-actions"><button type="button" class="park-btn" data-task-cancel="${esc(t.id)}">取消（還沒送出）</button></div>`);
        else if (!TERMINAL.has(t.state) && t.state !== 'cancel_requested' && can('cancel'))
            out.push(canStopTurn ? `<div class="task-actions"><button type="button" class="park-btn" data-task-cancel="${esc(t.id)}">${t.state === 'waiting_permission' ? '取消這一輪（不批准）' : '停止這一輪'}</button></div>`
                : `<p class="inspector-hint">這一輪已經送到 Paseo 在跑：Router 不會強行終止它。要停下，在那台機器的 Paseo 裡停止這個 session（Paseo App，或 <code>paseo stop</code>）。</p>`);
        if (state.parcels.has(t.id) && root.dataset.view !== 'tasks') out.push(`<div class="task-actions"><button type="button" class="park-btn" data-follow="${esc(t.id)}">跟著這個箱子走</button></div>`);
        if (t.state !== 'canceled' && can('submit'))
            out.push(`<details class="task-more" data-open-key="reply:${esc(t.id)}"><summary>回覆這個 session</summary><form class="reply-form" data-task="${esc(t.id)}"><textarea name="prompt" rows="3" required placeholder="接著說什麼…（在這一輪之後送達）"></textarea><label class="check"><input type="checkbox" name="withResult"> 附上這個任務的結果</label><button type="submit" class="park-btn primary">送出回覆</button></form></details>`);
        const others = d.sessions.filter(x => x.id !== t.target && x.allowedActions?.includes('submit'));
        if (t.state === 'queued' && !t.replyToTaskId && can('submit') && others.length)
            out.push(`<details class="task-more" data-open-key="move:${esc(t.id)}"><summary>改派到別的 session</summary><form class="move-form" data-task="${esc(t.id)}"><select name="target" aria-label="改派到">${others.map(x => `<option value="${esc(x.id)}">${esc(nameOf(x))} · ${esc(hostLabel(x.hostId))}${x.providerLimit ? ' · 額度用完' : ''}</option>`).join('')}</select><button type="submit" class="park-btn">改派（還沒送出，不會重複執行）</button></form></details>`);
        if (!['failed', 'canceled'].includes(t.state) && can('handoff') && others.length)
            out.push(`<details class="task-more" data-open-key="handoff:${esc(t.id)}"><summary>交接給另一個 session</summary><form class="handoff-form" data-task="${esc(t.id)}"><select name="target" aria-label="交接給">${others.map(x => `<option value="${esc(x.id)}">${esc(nameOf(x))} · ${esc(hostLabel(x.hostId))}</option>`).join('')}</select><textarea name="objective" rows="2" required maxlength="4096" placeholder="交給它做什麼"></textarea><label class="check"><input type="checkbox" name="withResult" checked> 附上這個任務的結果</label><button type="submit" class="park-btn primary">排入交接</button><p class="inspector-hint">這個任務完成、寫入鎖釋放之後才送出；不會複製任何檔案。</p></form></details>`);
        if (t.lockHeld && TERMINAL.has(t.state) && d.identity.scopes.includes('admin'))
            out.push(`<details class="task-more" data-open-key="release:${esc(t.id)}"><summary>釋放寫入鎖</summary><form class="release-form" data-task="${esc(t.id)}"><textarea name="evidence" rows="2" required minlength="20" placeholder="你確認了什麼（至少 20 字），例如背景任務都已停止"></textarea><label class="check"><input type="checkbox" name="confirm" required> 我已確認這個 session 的背景工作都停了</label><button type="submit" class="park-btn">釋放</button></form></details>`);
        return out.join('');
    }
    let composeKey = null; // the same text retried keeps one idempotency key, so a flaky network never sends it twice
    function bindActions(el) {
        const run = async (btn, fn, done) => { btn.disabled = true; try { const r = await fn(); api.toast(done(r)); if (typeof r?.id === 'string' && r.id.startsWith('task_') && r.state) select({ kind: 'task', id: r.id }); else renderInspector(true); } catch (err) { api.toast(err.message, true); btn.disabled = false; } };
        const resolve = async ref => { const r = await api.read('psr_resolve_target', { sessionRef: ref }); if (r.status !== 'resolved') throw new Error(r.reason ?? '目標不明確'); return r.routeTicket; };
        const c = $('.composer', el);
        if (c) {
            c.prompt.addEventListener('input', () => { composeKey = null; });
            c.onsubmit = e => { e.preventDefault(); const prompt = c.prompt.value.trim(); if (!prompt) return; composeKey ??= crypto.randomUUID();
                run(c.querySelector('[type=submit]'), async () => { const t = await api.act('psr_submit_task', { routeTicket: await resolve(c.dataset.session), prompt, idempotencyKey: composeKey, busyPolicy: 'queue' }); composeKey = null; delete c.dataset.dirty; return t; }, t => `已派出：${STATE_NAMES[t.state] ?? t.state}`); };
        }
        el.querySelectorAll('[data-dispatch]').forEach(b => b.onclick = () => run(b, () => api.act('psr_set_dispatch_mode', { workerId: b.dataset.worker, mode: b.dataset.dispatch, expectedRevision: Number(b.dataset.rev) }), () => b.dataset.dispatch === 'paused' ? '後續派工已暫停，正在跑的不受影響' : '已恢復派工'));
        el.querySelectorAll('[data-task-cancel]').forEach(b => b.onclick = () => run(b, () => api.act('psr_cancel_task', { taskId: b.dataset.taskCancel }), t => `取消狀態：${STATE_NAMES[t.state] ?? t.state}`));
        el.querySelectorAll('[data-peer-decide]').forEach(b => b.onclick = () => run(b, () => api.act('psr_peer_decide', { messageId: b.dataset.peerDecide, decision: b.dataset.decision }), () => b.dataset.decision === 'release' ? '已放行，一小時內送到' : '已拒絕'));
        el.querySelectorAll('.takes-form').forEach(f => f.mode.onchange = () => { f.mode.blur(); run(f.mode, () => api.act('psr_set_peer_mode', { memberId: f.dataset.member, mode: f.mode.value }), r => `收訊息方式：${TAKES[r.takes]?.[0] ?? r.takes}`); });
        el.querySelectorAll('.peer-send').forEach(f => f.onsubmit = e => { e.preventDefault(); const text = f.text.value.trim(); if (!text) return; if (new TextEncoder().encode(text).length > 2000) return api.toast('每則最多 2000 bytes（中文約 660 字）', true);
            const m = localMember(f.dataset.to);
            run(f.querySelector('[type=submit]'), async () => { const r = await api.act('psr_peer_send', { to: f.dataset.to, kind: f.kind.value, text, ...(f.urgent?.checked ? { urgent: true } : {}) }); f.reset(); delete f.dataset.dirty; return r; },
                r => r.delivery === 'held' ? '停下等你放行' : r.urgent ? '急件：它這一輪裡就會收到' : r.kind === 'notice' || m?.takes !== 'push' ? '已放進它的收件匣，它查收件匣時會看到' : `已排入：在它兩輪之間送進去${m && !m.live ? '（它最近沒回應，等它回來或過期）' : ''}`); });
        el.querySelectorAll('form[data-revoke]').forEach(f => twoStep(f, b => run(b, () => api.act('psr_revoke_local_credential', { credentialId: f.dataset.revoke }), r => `已撤銷${r.closedSessions.length ? `，${r.closedSessions.length} 個 session 已斷開` : ''}`)));
        el.querySelectorAll('form[data-take]').forEach(f => twoStep(f, b => run(b, () => api.act('psr_release_resource', { resourceId: f.dataset.take, memberId: f.dataset.member }), () => '已收回；排隊的下一個會被通知')));
        el.querySelectorAll('form[data-res-remove]').forEach(f => twoStep(f, b => run(b, () => api.act('psr_remove_resource', { resourceId: f.dataset.resRemove }), r => `已移除 ${r.removed}${r.endedClaims ? `，${r.endedClaims} 個 session 已被告知` : ''}`)));
        el.querySelectorAll('form.res-edit').forEach(f => f.onsubmit = e => { e.preventDefault(); const id = f.dataset.res || f.elements.namedItem('id').value.trim(), desc = f.description.value.trim();
            if (new TextEncoder().encode(desc).length > 300) return api.toast('說明最多 300 bytes（中文約 100 字）', true);
            run(f.querySelector('[type=submit]'), async () => { const r = await api.act('psr_set_resource', { resourceId: id, slots: Number(f.slots.value), remindAfterMinutes: Number(f.remind.value), description: desc }); delete f.dataset.dirty; return r; }, () => f.dataset.res ? `${id} 已儲存` : `已登記 ${id}`); });
        el.querySelectorAll('form[data-helper]').forEach(f => {
            twoStep(f, b => run(b, () => api.act('psr_decide_helper', { requestId: f.dataset.helper, decision: 'approve' }), r => r.state === 'running' ? '已批准：任務已送給幫手' : r.state === 'failed' ? `批准了，但沒能開始：${r.error ?? ''}` : '已批准'));
            const no = f.querySelector('[data-helper-reject]'), why = f.elements.namedItem('why');
            if (no) no.onclick = () => run(no, () => api.act('psr_decide_helper', { requestId: f.dataset.helper, decision: 'reject', ...(why?.value.trim() ? { note: why.value.trim() } : {}) }), () => '已拒絕，提出的 session 會被告知');
            if (why) why.onkeydown = e => { if (e.key === 'Enter') e.preventDefault(); }; // Enter in the reason must not approve
        });
        el.querySelectorAll('form.helper-rule-new').forEach(f => f.onsubmit = e => { e.preventDefault(); const hp = helperRules(); if (!hp) return;
            // what a person types: a trailing slash is dropped; anything that is no absolute path is said here, in words
            const scope = f.scope.value, typed = f.folders.value.split('\n').map(x => x.trim()).filter(Boolean).map(x => x.length > 1 ? x.replace(/\/+$/, '') || '/' : x);
            const folders = scope === 'any' ? ['*'] : scope === 'list' ? [...new Set(typed)] : [], note = f.note.value.trim();
            if (scope === 'list' && !folders.length) return api.toast('列出至少一個資料夾，或改選別的選項', true);
            const wrong = scope === 'list' ? folders.find(x => !x.startsWith('/') || x === '/' || x.slice(1).split('/').some(part => part === '' || part === '.' || part === '..')) : null;
            if (wrong) return api.toast(`「${wrong}」不能用：要寫那台機器上的絕對路徑，以 / 開頭（不能用 ~、不能是 / 本身、不能有 .. ）`, true);
            if (folders.length > 10) return api.toast('一條規則最多 10 個資料夾', true);
            const rule = { id: `r${Date.now().toString(36)}`, templateId: f.template.value, from: f.from.value, folders, ...(note ? { note } : {}) };
            run(f.querySelector('[type=submit]'), async () => { const r = await api.act('psr_set_policy', { helpers: { add: rule } }); delete f.dataset.dirty; return r; }, () => '已新增：符合的請求之後不用等你'); });
        el.querySelectorAll('form.helper-rule-new').forEach(f => { f.folders.oninput = () => { if (f.folders.value.trim() && f.scope.value === 'template') f.scope.value = 'list'; }; });
        el.querySelectorAll('form[data-helper-rule-remove]').forEach(f => twoStep(f, b => run(b, () => api.act('psr_set_policy', { helpers: { remove: f.dataset.helperRuleRemove } }), () => '已移除：這類請求之後又會等你')));
        el.querySelectorAll('[data-goto-helpers]').forEach(b => b.onclick = () => select({ kind: 'helpers', id: 'all' }));
        el.querySelectorAll('[data-goto-helper-rules]').forEach(b => b.onclick = () => el.querySelector('.helper-rules')?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
        el.querySelectorAll('[data-goto-task]').forEach(b => b.onclick = () => select({ kind: 'task', id: b.dataset.gotoTask }));
        el.querySelectorAll('[data-goto-resources]').forEach(b => b.onclick = () => select({ kind: 'resources', id: 'all' }));
        el.querySelectorAll('[data-goto-transfers]').forEach(b => b.onclick = () => select({ kind: 'transfers', id: 'all' }));
        el.querySelectorAll('[data-resume]').forEach(b => b.onclick = () => run(b, () => api.act('psr_resume_session', { sessionRef: b.dataset.resume }), () => '已恢復派工，排著的任務會依序送出'));
        el.querySelectorAll('form[data-create]').forEach(f => twoStep(f, async (b, reset) => {
            const id = f.dataset.create, t = state.data.templates?.templates.find(x => x.id === id); if (!t) return;
            b.disabled = true; b.textContent = '建立中…';
            const key = creating.get(id) ?? `console-${crypto.randomUUID()}`; creating.set(id, key);
            try { const s = await api.act('psr_create_session', { templateId: id, idempotencyKey: key }); creating.delete(id); api.toast(`已建立：${t.title}`); select({ kind: 'session', id: s.id }); }
            catch (err) { api.toast(/DELIVERY_UNKNOWN/.test(err.message) ? '建立結果不確定：先到那台的 Paseo 看有沒有多出這個 session；確定沒有，重新整理頁面再建。' : err.message, true); b.disabled = false; reset(); }
        }));
        const reply = $('.reply-form', el);
        if (reply) reply.onsubmit = e => { e.preventDefault(); run(reply.querySelector('[type=submit]'), () => api.act('psr_reply_task', { taskId: reply.dataset.task, prompt: reply.prompt.value.trim(), idempotencyKey: crypto.randomUUID(), includeSourceResult: reply.withResult.checked }), t => `回覆已排入：${STATE_NAMES[t.state] ?? t.state}`); };
        const handoff = $('.handoff-form', el);
        if (handoff) handoff.onsubmit = e => { e.preventDefault(); const src = state.data.tasks.find(x => x.id === handoff.dataset.task);
            run(handoff.querySelector('[type=submit]'), async () => api.act('psr_handoff', { sourceTaskId: src.id, targetRouteTicket: await resolve(handoff.elements.namedItem('target').value), idempotencyKey: crypto.randomUUID(), objective: handoff.objective.value.trim(), contextSummary: (src.resultSummary ?? '來源任務還沒完成，請等它的結果再動手。').slice(0, 4000), artifactRefs: [], acceptanceCriteria: ['先閱讀來源任務的結果再動手'], includeSourceResult: handoff.withResult.checked }), t => `交接已排入：${STATE_NAMES[t.state] ?? t.state}`); };
        const regroup = $('.regroup-form', el);
        if (regroup) {
            const picked = name => [...regroup.querySelectorAll(`input[name=${name}]:checked`)].map(x => x.value);
            regroup.onsubmit = e => { e.preventDefault(); const key = regroup.dataset.mission, others = picked('other'), own = picked('own'), part = regroup.part.value.trim() || null;
                const taskIds = [...own, ...missions().filter(x => others.includes(x.key)).flatMap(x => x.steps.map(t => t.id))];
                if (!taskIds.length) return api.toast('先勾選要放進來的任務或步驟', true);
                run(regroup.querySelector('[type=submit]'), () => api.act('psr_set_mission', { taskIds, missionId: key, missionPart: part }), r => `已整理 ${r.moved.length} 步${part ? `，子任務：${part}` : ''}`); };
            const split = regroup.querySelector('[data-split]');
            if (split) split.onclick = () => { const own = picked('own'); if (!own.length) return api.toast('先勾選要拆出去的步驟', true);
                run(split, async () => { for (const id of own) await api.act('psr_set_mission', { taskIds: [id], missionId: `solo:${id}`, missionPart: null }); return { moved: own }; }, () => `已拆出 ${own.length} 個獨立任務`); };
        }
        el.querySelectorAll('.goal-decide').forEach(f => f.onsubmit = e => { e.preventDefault(); const decision = e.submitter?.dataset.decision ?? 'approve';
            run(e.submitter ?? f.querySelector('[type=submit]'), () => api.act('psr_decide_plan', { goalId: f.dataset.goal, decision, ...(f.note.value.trim() ? { note: f.note.value.trim() } : {}) }), () => decision === 'approve' ? '方案已批准，規劃者會接著做' : '方案已退回'); });
        el.querySelectorAll('.goal-reply').forEach(f => f.onsubmit = e => { e.preventDefault(); run(f.querySelector('[type=submit]'), () => api.act('psr_goal_reply', { goalId: f.dataset.goal, text: f.text.value.trim() }), () => '已回覆規劃者'); });
        // the owner posts as the owner; the redraw run() forces reloads the open forum. maxlength counts characters, the limit is bytes
        el.querySelectorAll('.forum-form').forEach(f => f.onsubmit = e => { e.preventDefault(); const text = f.text.value.trim(); if (!text) return; if (new TextEncoder().encode(text).length > 2000) return api.toast('每則最多 2000 bytes（中文約 660 字）', true); run(f.querySelector('[type=submit]'), () => api.act('psr_forum_post', { mission: f.dataset.forum, text }), r => r.masked ? '已貼到論壇（像金鑰的內容已遮掉）' : '已貼到論壇'); });
        el.querySelectorAll('[data-goal-cancel]').forEach(b => b.onclick = () => { if (confirm('取消這個目標？排隊中的步驟會取消，正在跑的這一輪會跑完。')) run(b, () => api.act('psr_cancel_goal', { goalId: b.dataset.goalCancel }), () => '目標已取消'); });
        el.querySelectorAll('.perm-rule-form').forEach(f => f.onsubmit = e => { e.preventDefault(); const detail = f.dataset.detail.trim(), rules = state.data.policy?.rules ?? [];
            run(f.querySelector('[type=submit]'), () => api.act('psr_set_policy', { rules: [...rules, { id: `r${Date.now().toString(36)}`, level: f.level.value, pattern: `^${detail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, note: '從權限請求記下' }] }), () => `以後這條命令算 ${f.level.value}`); });
        el.querySelectorAll('[data-follow]').forEach(b => b.onclick = () => select({ kind: 'task', id: b.dataset.follow }, { follow: true }));
        const move = $('.move-form', el);
        if (move) move.onsubmit = e => { e.preventDefault(); run(move.querySelector('[type=submit]'), async () => api.act('psr_move_task', { taskId: move.dataset.task, routeTicket: await resolve(move.elements.namedItem('target').value) }), t => `已改派到 ${nameOf(state.data.sessions.find(x => x.id === t.target) ?? { title: t.target })}`); };
        const release = $('.release-form', el);
        if (release) release.onsubmit = e => { e.preventDefault(); run(release.querySelector('[type=submit]'), () => api.act('psr_release_mutation', { taskId: release.dataset.task, confirmation: `RELEASE ${release.dataset.task}`, evidence: release.evidence.value.trim() }), () => '寫入鎖已釋放'); };
    }
    function bindForm() {
        // Any form in the panel with unsaved input keeps live updates from redrawing it.
        $('#park-inspector', root).querySelectorAll('form').forEach(f => f.addEventListener('input', () => { f.dataset.dirty = '1'; }));
        const form = $('.inspector-form', root); if (!form) return;
        form.onsubmit = async (e) => {
            e.preventDefault(); const f = new FormData(form), clean = v => { const t = String(v ?? '').trim(); return t ? t : null; };
            const args = { kind: form.dataset.kind, id: form.dataset.id, description: clean(f.get('description')) };
            if (f.has('tags')) { const tags = String(f.get('tags')).split(/[,，]/).map(x => x.trim()).filter(Boolean); args.tags = tags.length ? tags : null; }
            if (f.has('rules')) { const rules = String(f.get('rules')).split('\n').map(x => x.trim()).filter(Boolean); args.rules = rules.length ? rules : null; }
            form.querySelector('button[type=submit]').disabled = true;
            try { await api.annotate(args); delete form.dataset.dirty; renderInspector(true); api.toast('已儲存'); } catch (err) { api.toast(err.message, true); } finally { form.querySelector('button[type=submit]') && (form.querySelector('button[type=submit]').disabled = false); }
        };
    }
    // A machine's logins as the Router last checked them: each provider, what is wrong, and (owner) a check of this machine now.
    /** The command that renews one provider's login on one machine, run in the owner's own terminal (psr-login, installed on the
     * Mac from .state/login): the console only shows and copies it; no code, link or token comes back here. */
    const reloginCmd = (hostId, provider) => { const cmd = `psr-login ${hostId} ${provider}`;
        return `<form class="login-cmd"><code>${esc(cmd)}</code><button type="button" class="park-btn ghost" data-copy="${esc(cmd)}">複製</button></form>`; };
    function loginBlock(h, ds) {
        const ls = h.logins ?? []; if (!ls.length) return '';
        const many = ds.length > 1, admin = !!state.data?.identity?.scopes?.includes('admin');
        const row = l => { const [text, cls] = loginState(l), bits = [l.method, l.plan, l.version].filter(Boolean).join(' · ');
            return `<div class="login-row"><p><b>${esc(providerName(l.provider))}</b>${many ? `<small>${esc(ds.find(x => x.id === l.daemonId)?.label ?? l.daemonId)}</small>` : ''}<span class="login-state state-${cls}">${esc(text)}</span></p>
              <small>${esc(bits)}${l.checkedAt ? `${bits ? ' · ' : ''}${esc(relTime(l.checkedAt))}檢查` : ''}${l.error ? ` · ${esc(l.error.slice(0, 140))}` : ''}</small>
              ${l.lastFailure ? `<small class="login-state state-err">${esc(relTime(l.lastFailure.at))}的一輪：${esc(l.lastFailure.notice.slice(0, 140))}</small>` : ''}
              ${admin && ['err', 'warn'].includes(cls) ? reloginCmd(h.id, l.provider) : ''}</div>`; };
        const need = ls.some(l => ['err', 'warn'].includes(loginState(l)[1])), never = ls.every(l => l.state === 'unchecked');
        const how = '在 Mac 的終端機貼上執行。Claude：打開它給的網址登入，把頁面上的 code 貼回終端機；Codex：打開網址，輸入它顯示的短碼。登入只在你的終端機和瀏覽器之間進行，不經過 Router。完成後按「重新檢查這台」。';
        return `<h3>登入</h3>${ls.map(row).join('')}
          ${need && admin ? `<p class="inspector-hint">${how}</p>` : never ? '<p class="inspector-hint">還沒檢查過。檢查時 Router 只讀 Paseo 回報的登入狀態，碰不到任何憑證。</p>' : ''}
          ${admin ? `<p><button type="button" class="park-btn ghost" data-check-logins="${esc(h.id)}">重新檢查這台</button></p>
            ${need ? '' : `<details class="task-more" data-open-key="relogin:${esc(h.id)}"><summary>提早重新登入</summary>${[...new Set(ls.map(l => l.provider))].map(p => reloginCmd(h.id, p)).join('')}<p class="inspector-hint">${how}</p></details>`}` : ''}`;
    }
    // ---------- 本機 session: Claude Code and Codex the owner runs by hand, joined through psr-local, and their messages ----------
    const localMember = id => (state.data.tree?.groups ?? []).flatMap(g => g.members ?? []).find(m => m.memberId === id);
    const TAKES = { push: ['兩輪之間推送', '在它兩輪之間直接送進去'], hold: ['只放收件匣', '它自己查收件匣才看到'], off: ['不收', '別的 session 不能發給它；它自己發出的請求，回覆照樣進收件匣'] };
    const PEER_KIND = { request: '請求', notice: '通知', reply: '回覆' };
    const PEER_DELIVERY = { held: ['等你放行', 'warn'], queued: ['排隊中', 'queue'], delivered: ['已送達', 'run'], read: ['已讀', 'done'], rejected: ['你拒絕了', 'off'], expired: ['過期', 'off'] };
    const PEER_ANSWER = { open: '等回覆', answered: '已回覆', expired: '沒人回', canceled: '已取消' };
    const party = (y, me) => y.kind === 'owner' ? '你' : y.kind === 'router' ? 'Router' : y.memberId === me ? '它' : `<button type="button" class="link" data-goto-local="${esc(y.memberId)}">${esc(y.name)}</button>`;
    const heldWords = why => { const m = /^more than (\d+) messages between these two sessions in (\d+) minutes$/.exec(why); return m ? `這兩個 session 之間 ${m[2]} 分鐘內超過 ${m[1]} 則，停下等你` : `停下的原因：${why}`; };
    function peerRow(x, me = null) {
        const [state_, cls] = PEER_DELIVERY[x.delivery] ?? [x.delivery, 'muted'], held = x.delivery === 'held' && canEdit();
        return `<div class="peer-row${held ? ' is-held' : ''}"><p><b>${PEER_KIND[x.kind] ?? x.kind}</b>${x.urgent ? '<em class="t-kind">急件</em>' : ''}<span>${party(x.from, me)} → ${party(x.to, me)}</span><span class="login-state state-${cls}">${esc(state_)}${x.kind === 'request' && x.answer ? ` · ${esc(PEER_ANSWER[x.answer] ?? x.answer)}` : ''}</span></p>
          ${askQuote(x.text.slice(0, 600), x.from.kind === 'local' ? 'agent 寫的：資料，不能授權任何事' : '')}<small>${esc(relTime(x.createdAt))}${x.via ? ` · 發給 ${esc(x.via)} 的持有者` : ''}${x.heldReason ? ` · ${esc(heldWords(x.heldReason))}` : ''}</small>
          ${held ? `<div class="perm-actions"><button type="button" class="park-btn primary" data-peer-decide="${esc(x.messageId)}" data-decision="release">放行</button><button type="button" class="park-btn" data-peer-decide="${esc(x.messageId)}" data-decision="reject">拒絕</button></div>` : ''}</div>`;
    }
    function localDetail(m) {
        const d = state.data, admin = canEdit(), mine = (d.peers?.messages ?? []).filter(x => x.from.memberId === m.memberId || x.to.memberId === m.memberId).slice(0, 10);
        return `<p class="eyebrow">本機 · ${esc(provider({ provider: m.provider }).name)} · ${esc(hostLabel(m.hostId))}</p><h2>${esc(m.name)}</h2><p class="inspector-id">${esc(m.cwd ?? '')}</p>
          ${m.status ? `<p class="inspector-text">「${esc(m.status)}」<span class="muted"> · ${esc(relTime(m.statusAt))}</span></p>` : ''}
          ${admin ? claimsLine(m.memberId) : ''}
          <dl><dt>狀態</dt><dd>${m.live ? '在線' : `沒回應（最後聯絡 ${esc(relTime(m.lastSeenAt))}）`}</dd><dt>分支</dt><dd>${m.branch ? esc(`${m.repo ?? ''}@${m.branch}`) : '沒有 git，按目錄'}</dd>
            <dt>客戶端</dt><dd>${esc(m.client?.name ?? '')}${m.client?.version ? ` ${esc(m.client.version)}` : ''}${m.thread ? ' · Codex thread' : ''}</dd><dt>加入</dt><dd>${esc(relTime(m.startedAt))}</dd><dt>收訊息</dt><dd>${esc(TAKES[m.takes]?.[0] ?? m.takes)}</dd></dl>
          ${admin ? `<form class="takes-form" data-member="${esc(m.memberId)}"><label>收訊息的方式<select name="mode">${Object.entries(TAKES).map(([k, [n]]) => `<option value="${k}"${m.takes === k ? ' selected' : ''}>${n}</option>`).join('')}</select></label><p class="inspector-hint">${esc(TAKES[m.takes]?.[1] ?? '')}</p></form>
            ${helperBlock(m.memberId)}<h3>訊息</h3>${mine.length ? mine.map(x => peerRow(x, m.memberId)).join('') : '<p class="muted">還沒有。</p>'}
            <form class="peer-send" data-to="${esc(m.memberId)}"><h3>以你的名義發訊息</h3><select name="kind" aria-label="種類"><option value="notice">通知：告訴它一件事</option><option value="request">請求：它要回你一次</option></select>
              <textarea name="text" rows="2" required maxlength="2000" placeholder="要告訴它什麼"></textarea>${m.provider === 'claude' ? '<label class="check"><input type="checkbox" name="urgent"> 急件：在它這一輪裡就送進去，不等這一輪結束</label>' : ''}
              <div class="inspector-actions"><button type="submit" class="park-btn primary">送出</button><span class="inspector-hint">請求的回覆會出現在上面</span></div></form>` : ''}
          ${admin ? `<details class="task-more" data-open-key="forum:${esc(m.forum)}" data-forum="${esc(m.forum)}"><summary>分支論壇 · ${esc(m.forumName)}</summary><div class="forum-body">${forumCache.get(m.forum) ?? '<p class="muted">載入中…</p>'}</div>
            <form class="forum-form" data-forum="${esc(m.forum)}"><textarea name="text" rows="2" required maxlength="2000" placeholder="留給這個分支上的本機 session 看（不會叫醒任何人）"></textarea><button type="submit" class="park-btn primary">貼上</button></form>
            <p class="inspector-hint">同一個倉庫和分支（沒有 git 時同一個目錄）上的本機 session 共用；它們開工和接新工作前會讀。</p></details>` : ''}
          ${filesBlock(filesOf(m.memberId), '送收的檔案')}`;
    }
    // ---------- 幫手: a local session asks for a session on another machine or in another folder to do one task. Nothing starts
    // until you approve it here; the task then runs as yours and its result goes back to the session that asked ----------
    const helpersNow = () => state.data.helpers?.requests ?? [];
    const HELPER_STATE = { pending: ['等你批准', 'warn'], starting: ['啟動中', 'run'], running: ['進行中', 'run'], done: ['完成', 'done'], failed: ['失敗', 'err'], canceled: ['已取消', 'off'], rejected: ['你拒絕了', 'off'], expired: ['過期，沒人決定', 'off'] };
    function helperRow(r, me = null) {
        const [txt, cls] = HELPER_STATE[r.state] ?? [r.state, 'muted'], pending = r.state === 'pending' && canEdit(), [prov, ...model] = String(r.provider).split('/');
        const host = state.data.hosts.hosts.find(h => h.id === r.hostId), left = Math.max(1, Math.round((r.expiresAt - Date.now()) / 3600000));
        const who = r.from.gone ? `${esc(r.from.name)} <span class="muted">（已離開）</span>` : r.from.memberId === me ? '它' : `<button type="button" class="link" data-goto-local="${esc(r.from.memberId)}">${esc(r.from.name)}</button>${r.from.live ? '' : ' <span class="muted">（不在線）</span>'}`;
        const session = r.sessionRef ? `<button type="button" class="link" data-goto-session="${esc(r.sessionRef)}">${esc(r.sessionName ?? '幫手 session')}</button>` : '';
        const task = r.taskId ? ` · <button type="button" class="link" data-goto-task="${esc(r.taskId)}">任務${r.taskState ? `（${esc(STATE_NAMES[r.taskState] ?? r.taskState)}）` : ''}</button>` : '';
        return `<form class="peer-row helper-row${pending ? ' is-held' : ''}" data-helper="${esc(r.requestId)}" data-armed-text="再按一次確定批准">
          <p><b>${r.followUp ? '接著問' : '新幫手'}</b><span class="login-state state-${cls}">${esc(txt)}</span></p>
          <small class="helper-who">${who} → ${esc(host?.label ?? r.hostId)}</small>
          <small class="mono helper-cwd">${esc(r.cwd)}${r.customCwd ? ' <em class="t-kind helper-own">請求自己指定的資料夾</em>' : ''}</small>
          <small>${esc(provider({ provider: r.provider }).name ?? prov)} · ${esc(model.join('/'))} · ${esc(modeWords(r))}${r.followUp && session ? ` · 送給 ${session}` : ''}</small>
          ${r.purpose ? `<small>用途：${esc(r.purpose)}</small>` : ''}
          <div class="ask-quote helper-task"><small>任務全文 · agent 寫的，批准後原樣送給幫手</small><span>${esc(r.task)}</span></div>
          <small>${esc(relTime(r.createdAt))}提出${pending ? ` · 再 ${left} 小時沒決定就過期` : ''}${!r.followUp && session ? ` · ${session}` : ''}${task}${r.auto ? ` · <b class="helper-auto">自動批准</b>（${esc(helperRuleName(r.auto))}）` : ''}${r.decisionNote ? ` · 你說：${esc(r.decisionNote)}` : ''}${r.error ? ` · ${esc(r.error)}` : ''}</small>
          ${pending ? `<input name="why" type="text" maxlength="100" placeholder="要拒絕的話，可以給它一句原因" aria-label="拒絕的原因">
            <div class="perm-actions"><button type="submit" class="park-btn">批准</button><button type="button" class="park-btn" data-helper-reject>拒絕</button></div>
            <p class="inspector-hint">${r.followUp ? '批准後，這個任務送給同一個幫手 session。' : `批准後，Router 在 ${esc(host?.label ?? r.hostId)} 的這個資料夾建一個新 session，把任務以你的名義送給它。`}${host?.ownerApprovalOnly ? '這台只有你能批：它要做的每個動作還會再來問你。' : ''}${r.from.gone ? '<b>提出的 session 已經離開</b>（關掉了，或它的機器睡了超過 30 分鐘）：批准的話幫手照樣做，但結果沒有人收，只會留在任務頁。' : ''}</p>` : ''}</form>`;
    }
    const helperBlock = id => { const rs = helpersNow().filter(r => r.from.memberId === id).slice(0, 5); return rs.length ? `<h3>它請求的幫手 · ${rs.length}</h3>${rs.map(r => helperRow(r, id)).join('')}` : ''; };
    /** On a session that is a helper: who asked for it. */
    const helperOf = ref => { const rs = helpersNow().filter(r => r.sessionRef === ref && r.taskId); if (!rs.length) return ''; const r = rs.at(-1);
        return `<p class="pol-line">幫手 · <button type="button" class="link" data-goto-local="${esc(r.from.memberId)}">${esc(r.from.name)}</button> 請求的${rs.length > 1 ? `，共 ${rs.length} 個任務` : ''} · <button type="button" class="link" data-goto-helpers>看請求</button></p>`; };
    // 自動批准: the owner's standing rules (policy helpers.auto). A request a rule covers starts without waiting, as the owner
    // who set the rule; never on a machine only the owner approves on, and only so many a day from one machine.
    const helperRules = () => state.data.policy?.helpers ?? null;
    const helperRuleName = id => { const r = helperRules()?.auto.find(x => x.id === id); return r?.note || `規則 ${id}`; };
    const ruleFolders = r => r.folders.includes('*') ? '請求自己指定的任意資料夾也自動' : r.folders.length ? `模板自己的資料夾，以及 ${r.folders.join('、')}（含底下的）` : '只有模板自己的資料夾';
    function helperRulesBlock() {
        const hp = helperRules(); if (!hp || !canEdit()) return '';
        const tpl = id => { const t = hp.templates.find(x => x.id === id); return id === '*' ? '所有模板' : t ? `${t.title} · ${hostLabel(t.hostId)}` : `${id}（設定裡已經沒有）`; };
        const row = r => `<form class="tpl-row" data-helper-rule-remove="${esc(r.id)}" data-armed-text="再按一次移除"><p><b>${esc(tpl(r.templateId))}</b><small>${r.from === '*' ? '任何機器的 session 提出' : `${esc(hostLabel(r.from))} 的 session 提出`}</small></p>
          <small>${esc(ruleFolders(r))}</small><small>${r.note ? `${esc(r.note)} · ` : ''}${esc(clientName(r.by))} ${esc(relTime(r.at))}設定</small><div class="inspector-actions"><button type="submit" class="park-btn ghost">移除</button></div></form>`;
        const askers = state.data.hosts.hosts.filter(h => !h.ownerApprovalOnly), locked = state.data.hosts.hosts.filter(h => h.ownerApprovalOnly).map(h => h.label);
        // with no rule yet the form is simply there (nothing to find); with rules it folds away under them
        const form = `<form class="res-edit helper-rule-new"><label>哪個模板<select name="template"><option value="*">所有模板</option>${hp.templates.map(t => `<option value="${esc(t.id)}">${esc(t.title)} · ${esc(hostLabel(t.hostId))} · ${esc(modeWords(t))}</option>`).join('')}</select></label>
              <label>哪台機器上的 session 提出的<select name="from"><option value="*">任何機器</option>${askers.map(h => `<option value="${esc(h.id)}">${esc(h.label)}</option>`).join('')}</select></label>
              <label>請求自己指定資料夾時<select name="scope"><option value="template">不自動（只有模板自己的資料夾自動）</option><option value="list">下面列的資料夾和它們底下的也自動</option><option value="any">任意資料夾都自動</option></select></label>
              <label>資料夾，每行一個絕對路徑<textarea name="folders" rows="2" placeholder="/data"></textarea></label>
              <label>備註<input name="note" maxlength="60" placeholder="可不填，會顯示在自動批准的請求上"></label>
              <div class="inspector-actions"><button type="submit" class="park-btn primary">新增規則</button></div></form>
            <p class="inspector-hint">符合規則的請求不用等你：Router 直接建 session，以你的名義派任務，卡片上會標「自動批准」。每台機器 24 小時內最多自動啟動 ${hp.perDay} 個，超過的照舊等你。${locked.length ? `只有你能批的機器（${esc(locked.join('、'))}）永遠不自動。` : ''}已經在等的請求不會被追溯：手動批准，或讓提出的 session 再提一次。</p>`;
        return `<h3 class="helper-rules">自動批准 · ${hp.auto.length} 條規則</h3>${hp.auto.length ? `${hp.auto.map(row).join('')}<details class="task-more" data-open-key="helper-rule:new"><summary>新增自動批准規則</summary>${form}</details>`
            : `<p class="muted">還沒有規則：每個請求都等你。要讓某一類請求不用等，在這裡加一條：</p>${form}`}`;
    }
    function helpersPanel() {
        const hs = state.data.helpers, all = hs?.requests ?? [], pending = all.filter(r => r.state === 'pending'), open = all.filter(r => r.state === 'starting' || r.state === 'running'), rest = all.filter(r => !['pending', 'starting', 'running'].includes(r.state)).slice(0, 20);
        return `<p class="eyebrow">本機 session</p><h2>幫手</h2><p class="inspector-text">本機 session 要到別台機器、或別的資料夾做事時，在這裡請求一個幫手：Router 新建的 session，只做那一個任務，結果回到提出請求的 session。除了符合下面${canEdit() && helperRules() ? '<button type="button" class="link" data-goto-helper-rules>「自動批准」規則</button>' : '「自動批准」規則'}的，你批准之前什麼都不會開始；24 小時沒決定就過期。</p>
          ${!hs ? '<p class="muted">讀不到幫手請求（只有你看得到）。</p>' : `<h3>等你批准 · ${pending.length}</h3>${pending.length ? pending.map(r => helperRow(r)).join('') : '<p class="muted">沒有。</p>'}
          ${helperRulesBlock()}
          ${open.length ? `<h3>進行中 · ${open.length}</h3>${open.map(r => helperRow(r)).join('')}` : ''}
          <h3>最近</h3>${rest.length ? rest.map(r => helperRow(r)).join('') : '<p class="muted">還沒有。</p>'}${hs.more ? '<p class="inspector-hint">只列出最近 100 個。</p>' : ''}`}`;
    }
    function peersPanel() {
        const ps = state.data.peers, all = ps?.messages ?? [], held = all.filter(x => x.delivery === 'held'), rest = all.filter(x => x.delivery !== 'held').slice(0, 20);
        return `<p class="eyebrow">本機 session</p><h2>訊息</h2><p class="inspector-text">本機 session 之間互發的請求和通知，以及你發給它們的。發得太密的（兩個 session 之間 10 分鐘內第 7 則起）會停在這裡等你放行，一小時沒處理就過期。</p>
          ${!ps ? '<p class="muted">讀不到訊息（只有你看得到）。</p>' : `<h3>等你放行 · ${held.length}</h3>${held.length ? held.map(x => peerRow(x)).join('') : '<p class="muted">沒有。</p>'}
          <h3>最近</h3>${rest.length ? rest.map(x => peerRow(x)).join('') : '<p class="muted">還沒有訊息。</p>'}${ps.more ? '<p class="inspector-hint">只列出最近 200 則。</p>' : ''}
          ${ps.modes?.length ? `<h3>不在推送模式的 session</h3>${ps.modes.map(x => `<p class="pol-line"><button type="button" class="link" data-goto-local="${esc(x.memberId)}">${esc(x.name)}</button> · ${esc(TAKES[x.takes]?.[0] ?? x.takes)}</p>`).join('')}` : ''}`}`;
    }
    // 機器憑證: one per machine for the sessions the owner runs by hand there. Issued only from the Router host (it must never
    // pass through a page); revoking one closes its sessions at once. Owner-only machines take none.
    function credentialBlock(h) {
        if (!canEdit() || h.ownerApprovalOnly) return '';
        const cs = (state.data.hosts.localCredentials ?? []).filter(c => c.hostId === h.id).sort((a, b) => b.createdAt - a.createdAt), now = Date.now();
        const ymd = ts => new Date(ts).toLocaleDateString('zh-TW', { year: 'numeric', month: 'numeric', day: 'numeric' });
        const row = c => { const status = c.revoked ? ['已撤銷', 'muted'] : c.exp <= now ? ['已過期', 'err'] : [`有效 · ${ymd(c.exp)} 到期`, 'run'];
            return `<form class="tpl-row" data-revoke="${esc(c.id)}" data-armed-text="${c.openSessions ? `再按一次撤銷（${c.openSessions} 個 session 會斷開）` : '再按一次撤銷'}"><p><b class="mono">${esc(c.id.slice(0, 14))}</b><span class="login-state state-${status[1]}">${esc(status[0])}</span></p>
              <small>發於 ${esc(ymd(c.createdAt))} · ${c.openSessions} 個 session 開著</small>${!c.revoked && c.exp > now ? '<div class="inspector-actions"><button type="submit" class="park-btn">撤銷</button></div>' : ''}</form>`; };
        return `<h3>機器憑證</h3>${cs.length ? cs.map(row).join('') : ''}<p class="inspector-hint">${cs.length ? '撤銷後，用它加入的本機 session 立刻斷開，之後也不能再用它加入。' : '這台還沒有。'}要發新的，在 Router 主機上用 psr_issue_local_credential，直接接到 psr-local 的安裝程式；憑證不經過網頁。</p>`;
    }
    // ---------- 檔案: files sent through the Router (psr_send_file, psr-xfer). Records only: the code is never shown or kept ----------
    const transfersNow = () => state.data.transfers?.transfers ?? [];
    const fmtSize = n => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB` : `${(n / 1048576).toFixed(n < 10485760 ? 1 : 0)} MB`;
    /** A sender or receiver: a session opens it; a machine's psr-xfer and you are plain words. */
    const fileParty = y => !y ? '' : y.kind === 'owner' ? '你' : y.kind === 'agent' ? `<button type="button" class="link" data-goto-session="${esc(y.ref)}">${esc(y.name)}</button>`
        : y.kind === 'local' ? `<button type="button" class="link" data-goto-local="${esc(y.ref)}">${esc(y.name)}</button>` : `${esc(hostLabel(y.hostId))} 的 psr-xfer`;
    function fileState(t) {
        if (t.state === 'received') return [`已收 · ${relTime(t.receivedAt)}`, 'done'];
        if (t.state === 'expired') return ['過期，沒人收', 'off'];
        if (t.receiving) return ['正在收', 'run'];
        return [`等人收 · 還有 ${Math.max(1, Math.round((t.expiresAt - Date.now()) / 60000))} 分`, 'queue'];
    }
    function fileRow(t, withMission = true) {
        const [txt, cls] = fileState(t), m = withMission && t.missionId ? missions().find(x => x.key === t.missionId) : null;
        return `<div class="peer-row"><p><b title="${esc(t.name)}">${esc(t.name.length > 40 ? t.name.slice(0, 39) + '…' : t.name)}</b><small>${esc(fmtSize(t.size))}</small><span class="login-state state-${cls}">${esc(txt)}</span></p>
          <small>${fileParty(t.from)} → ${t.receivedBy ? fileParty(t.receivedBy) : t.receiving ? fileParty(t.receiving) : '還沒有人'} · ${esc(relTime(t.createdAt))}送出${m ? ` · <button type="button" class="link" data-goto-mission="${esc(m.key)}">${esc(m.name)}</button>` : t.missionId && withMission ? ` · ${esc(t.missionId)}` : ''}</small>
          <small class="mono" title="${esc(t.sha256)}">sha256 ${esc(t.sha256.slice(0, 16))}…</small></div>`;
    }
    /** What a session (a Paseo session ref or a local member id) sent or received, as rows; or a mission's files. */
    const filesOf = id => transfersNow().filter(t => t.from.ref === id || t.receivedBy?.ref === id || t.receiving?.ref === id);
    const filesBlock = (list, title, withMission = true) => canEdit() && list.length ? `<h3>${title} · ${list.length}</h3>${list.slice(0, 6).map(t => fileRow(t, withMission)).join('')}${list.length > 6 ? '<p><button type="button" class="link" data-goto-transfers>全部檔案</button></p>' : ''}` : '';
    function transfersPanel() {
        const tf = state.data.transfers; if (!tf) return '<p class="eyebrow">檔案轉送</p><h2>檔案</h2><p class="muted">讀不到（只有你看得到）。</p>';
        const list = tf.transfers, waiting = list.filter(t => t.state === 'pending');
        return `<p class="eyebrow">檔案轉送</p><h2>檔案</h2><p class="inspector-text">經 Router 送的檔案：送的一方拿到一次性口令，收的一方用口令取檔，機器之間不直連。檔案最多留 60 分鐘、每個最大 100 MB，記錄留一天；口令只給送的一方，這裡永遠不顯示。</p>
          ${waiting.length ? `<h3>等人收 · ${waiting.length}</h3>${waiting.map(t => fileRow(t)).join('')}` : ''}
          <h3>${waiting.length ? '其他' : '最近一天'}</h3>${list.filter(t => t.state !== 'pending').map(t => fileRow(t)).join('') || '<p class="muted">一天內沒有其他檔案。</p>'}`;
    }
    // ---------- 共用資源: things only one (or a few) sessions may use at a time, e.g. an editor on a workstation or a GPU ----------
    // Sessions take one before using it and give it back after; the rest wait in line and are told when it is theirs. Advisory:
    // no lock on the machine. A host without a Paseo daemon has no card, so all of it lives in one panel.
    const resourcesNow = () => state.data.resources?.resources ?? [];
    const holderLink = c => c.kind === 'local' ? `<button type="button" class="link" data-goto-local="${esc(c.memberId)}">${esc(c.name)}</button>` : `<button type="button" class="link" data-goto-session="${esc(c.memberId)}">${esc(c.name)}</button>`;
    const resState = r => r.holders.length >= r.slots ? [r.waiting.length ? `滿了 · ${r.waiting.length} 個在排隊` : `${r.holders.length}/${r.slots} 在用`, r.waiting.length ? 'warn' : 'run'] : r.holders.length ? [`${r.holders.length}/${r.slots} 在用`, 'run'] : ['空著', 'muted'];
    /** What a session (a local member id or a Paseo session ref) holds or waits for, as one line. */
    function claimsLine(id) {
        const out = resourcesNow().flatMap(r => [...r.holders.filter(c => c.memberId === id).map(c => `拿著 <b>${esc(r.resourceId)}</b>（${esc(relTime(c.since))}起${c.note ? `：${esc(c.note)}` : ''}）`),
            ...r.waiting.filter(c => c.memberId === id).map(c => `排第 ${c.position} 等 <b>${esc(r.resourceId)}</b>`)]);
        return out.length ? `<p class="inspector-text">共用資源：${out.join('；')} <button type="button" class="link" data-goto-resources>管理</button></p>` : '';
    }
    /** A machine's resources in its detail, one line each; managing them is in the panel. */
    function resourceSummary(h) {
        const rs = resourcesNow().filter(r => r.hostId === h.id); if (!rs.length) return '';
        return `<h3>共用資源</h3>${rs.map(r => { const [t, cls] = resState(r); return `<p class="pol-line"><b>${esc(r.resourceId)}</b> <span class="login-state state-${cls}">${esc(t)}</span></p>`; }).join('')}<p><button type="button" class="link" data-goto-resources>管理共用資源</button></p>`;
    }
    const resForm = (r = null) => `<form class="res-edit" data-res="${esc(r?.resourceId ?? '')}">
          ${r ? '' : `<label>名稱<input name="id" required maxlength="100" pattern="[A-Za-z0-9][A-Za-z0-9._\\-]{0,39}/[a-z0-9][a-z0-9._\\-]{0,59}" placeholder="機器/名稱，例如 mac/unreal-editor" list="res-hosts"><datalist id="res-hosts">${[...new Set([...state.data.hosts.hosts.map(h => h.id), ...resourcesNow().map(x => x.hostId)])].map(h => `<option value="${esc(h)}/">`).join('')}</datalist></label>`}
          <div class="svc-nums"><label>名額<input type="number" name="slots" min="1" max="16" required value="${r?.slots ?? 1}"></label><label>提醒（分）<input type="number" name="remind" min="5" max="1440" required value="${r?.remindAfterMinutes ?? 120}"></label></div>
          <label>說明（一行，給 session 看）<input name="description" maxlength="300" value="${esc(r?.description ?? '')}" placeholder="這是什麼、怎麼用"></label>
          <div class="inspector-actions"><button type="submit" class="park-btn primary">${r ? '儲存' : '登記'}</button><span class="inspector-hint">名額：同時能拿著的 session 數。提醒：有人排隊超過這麼久，提醒持有者一次（不會收回）</span></div></form>`;
    function resourcesPanel() {
        const rs = state.data.resources; if (!rs) return '<p class="eyebrow">共用資源</p><h2>共用資源</h2><p class="muted">讀不到（只有你看得到）。</p>';
        const claim = (r, c, waiting) => `<div class="res-claim"><p>${waiting ? `<b>#${c.position}</b> ` : ''}${holderLink(c)} <small>${c.kind === 'local' ? '本機' : 'Paseo'} · ${esc(relTime(c.since))}${waiting ? '開始排' : '拿到'}${c.told === false ? ' · 還沒通知到' : ''}</small></p>${c.note ? `<small>「${esc(c.note)}」</small>` : ''}
            <form class="two-step" data-take="${esc(r.resourceId)}" data-member="${esc(c.memberId)}" data-armed-text="${waiting ? '再按一次移出' : '再按一次收回（它會被告知停止使用）'}"><button type="submit" class="park-btn ghost">${waiting ? '移出排隊' : '收回'}</button></form></div>`;
        const card = r => { const [t, cls] = resState(r); return `<div class="res-card"><p><b>${esc(r.resourceId)}</b><span class="login-state state-${cls}">${esc(t)}</span></p>${r.description ? `<p class="inspector-text">${esc(r.description)}</p>` : ''}
            ${r.holders.length ? `<h4>拿著</h4>${r.holders.map(c => claim(r, c, false)).join('')}` : ''}${r.waiting.length ? `<h4>排隊</h4>${r.waiting.map(c => claim(r, c, true)).join('')}` : ''}
            <details class="task-more" data-open-key="res:${esc(r.resourceId)}"><summary>修改 · 名額 ${r.slots} · 提醒 ${r.remindAfterMinutes} 分</summary>${resForm(r)}
              <form class="two-step" data-res-remove="${esc(r.resourceId)}" data-armed-text="${r.holders.length + r.waiting.length ? `再按一次移除（${r.holders.length + r.waiting.length} 個 session 會被告知）` : '再按一次移除'}"><button type="submit" class="park-btn ghost">移除這個資源</button></form></details></div>`; };
        return `<p class="eyebrow">本機與 Paseo session</p><h2>共用資源</h2><p class="inspector-text">同一時間只能一個（或幾個）session 用的東西。session 用之前先拿、用完放回；被佔用就排隊，輪到時 Router 通知它。只是約定，機器上沒有鎖。</p>
          ${rs.resources.length ? rs.resources.map(card).join('') : '<p class="muted">還沒有登記。</p>'}
          <details class="task-more" data-open-key="res:new"><summary>登記新資源</summary>${resForm()}</details>`;
    }
    // A form whose button needs a second press within 6 s (data-armed-text says what will happen): for what cannot be undone.
    function twoStep(f, go) {
        f.onsubmit = e => { e.preventDefault(); const b = f.querySelector('[type=submit]'); f.dataset.label ??= b.textContent;
            // armed, the form counts as being edited, so a live redraw (Safari never focuses a clicked button) does not disarm it
            // (text typed into the form keeps it dirty, so a redraw does not take it away)
            const reset = () => { delete f.dataset.armed; if (![...f.querySelectorAll('input[type=text], textarea')].some(i => i.value.trim())) delete f.dataset.dirty; b.textContent = f.dataset.label; b.classList.remove('primary'); };
            if (f.dataset.armed !== '1') { f.dataset.armed = '1'; f.dataset.dirty = '1'; b.textContent = f.dataset.armedText; b.classList.add('primary'); setTimeout(() => { if (f.isConnected && f.dataset.armed === '1' && !b.disabled) reset(); }, 6000); return; }
            // an action that failed leaves the form on screen with its button enabled again: it must take two clicks once more
            Promise.resolve(go(b, reset)).then(() => { if (f.isConnected && !b.disabled) reset(); }); };
    }
    // 建 session: the machine's templates (seat templates are the owner's, created from 權限). Each row is a form, so a live
    // redraw never takes the button away between its two clicks.
    const MODE_WORDS = { claude: { default: '每個命令都先問', plan: '先寫計畫，動手前問', acceptEdits: '改檔自己做，命令先問', auto: 'Claude 自動審核後執行', bypassPermissions: '全部不問' },
        codex: { auto: '沙盒內自己跑、斷網，越界才問', 'auto-review': '越界由 Codex 自動審核', 'full-access': '全部不問', 'read-only': '只讀，越界才問' } };
    const modeWords = t => { const p = String(t.provider).split('/')[0]; return t.modeId ? MODE_WORDS[p]?.[t.modeId] ?? t.modeId : 'Paseo 預設模式'; };
    const creating = new Map(); // templateId → idempotency key until it succeeds: a retry after a dropped connection never makes two
    function createBlock(h) {
        const tl = state.data.templates; if (!tl?.canCreate) return '';
        const ts = tl.templates.filter(t => t.hostId === h.id && !t.seat), up = state.data.hosts.daemons.some(x => x.hostId === h.id && x.connection === 'online');
        if (!ts.length) return '<h3>建 session</h3><p class="inspector-hint">這台沒有模板，Router 不能在這裡建 session；你在 Paseo 裡開的 session 一樣能派任務。</p>';
        const row = t => { const [prov, ...model] = String(t.provider).split('/');
            return `<form class="tpl-row" data-create="${esc(t.id)}" data-armed-text="再按一次確定建立"><p><b>${esc(t.title)}</b><small>${esc(provider({ provider: t.provider }).name ?? prov)} · ${esc(model.join('/'))}</small></p>
              <small>${esc(t.cwd)} · ${esc(modeWords(t))}</small>
              ${t.description ? `<details class="task-more" data-open-key="tpl:${esc(t.id)}"><summary>用途</summary><p class="inspector-text">${esc(t.description)}</p></details>` : ''}
              <div class="inspector-actions"><button type="submit" class="park-btn"${up ? '' : ' disabled'}>在這台建立</button></div></form>`; };
        return `<h3>建 session</h3>${ts.map(row).join('')}<p class="inspector-hint">${h.ownerApprovalOnly ? '這台只有你能批：用這些模板建的 session，每個要批准的動作都只會到你這裡。' : '建好的 session 是空閒的，派任務後才開始動作。'}${up ? '' : '這台離線，現在不能建。'}</p>`;
    }
    // A session someone used directly in Paseo (not through the Router): dispatch to it waits until the owner resumes it.
    function pauseBlock(s) {
        if (!s.externalActivity) return '';
        const d = state.data, ours = d.tasks.some(t => t.target === s.id && ACTIVE.has(t.state) && t.turnId && t.turnId === s.activeTurnId);
        const running = !!s.activeTurnId && !ours, waiting = d.tasks.filter(t => t.target === s.id && t.state === 'queued').length;
        return `<div class="pause-box"><p><b>派工暫停中</b>：有人直接在 Paseo 裡用了這個 session（沒經過 Router），所以 Router 先不送任務進去，免得兩邊同時操作。${waiting ? `有 ${waiting} 個任務在等。` : ''}</p>
          ${can('bind') ? running ? '<p class="inspector-hint">那邊的這一輪還在跑，跑完才能恢復。</p>' : `<div class="inspector-actions"><button type="button" class="park-btn primary" data-resume="${esc(s.id)}">恢復派工</button><span class="inspector-hint">確認那邊沒人在用了再按</span></div>` : ''}</div>`;
    }
    function renderInspector(force = false) {
        const el = $('#park-inspector', root), sel = state.selected, d = state.data;
        if (!sel) { el.hidden = true; return; }
        // Live updates must not clobber typing or an unsaved form; choosing another object or saving does replace it.
        const key = `${sel.kind}:${sel.id ?? ''}`;
        const working = document.activeElement?.closest?.('#park-inspector form, #park-inspector details, #park-inspector .inspector-title') || [...el.querySelectorAll('form')].some(f => f.dataset.dirty);
        if (!force && el.dataset.sel === key && working) return;
        el.hidden = false; let html = '';
        if (sel.kind === 'host') {
            const h = d.hosts.hosts.find(x => x.id === sel.id); if (!h) { state.selected = null; el.hidden = true; return; }
            const ds = d.hosts.daemons.filter(x => x.hostId === h.id), ss = d.sessions.filter(s => s.hostId === h.id);
            html = `<p class="eyebrow">機器</p>${titleBlock('host', h.id, h.label, h.configLabel)}<p class="inspector-id">${esc(h.id)}${h.configLabel && h.configLabel !== h.label ? ` · 配置名：${esc(h.configLabel)}` : ''}</p>
              ${h.description ? `<p class="inspector-text">${esc(h.description)}</p>` : '<p class="inspector-text muted">還沒有說明。寫下這台機器的數據、資源和用途，Muse 規劃時會先讀它。</p>'}
              ${h.tags?.length ? `<div class="chips">${h.tags.map(t => `<span class="chip">${esc(t)}</span>`).join('')}</div>` : ''}
              ${h.rules?.length ? `<ul class="rules">${h.rules.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
              <dl><dt>Paseo daemon</dt><dd>${ds.map(x => `${esc(x.label)} · ${x.connection === 'online' ? '在線' : esc(x.connection)}`).join('<br>')}</dd><dt>Session</dt><dd>${ss.length} 個</dd></dl>
              ${loginBlock(h, ds)}
              ${createBlock(h)}
              ${resourceSummary(h)}
              ${credentialBlock(h)}
              ${editForm('host', h.id, { description: h.description, tags: h.tags, rules: h.rules })}`;
        } else if (sel.kind === 'session') {
            const s = d.sessions.find(x => x.id === sel.id); if (!s) { state.selected = null; el.hidden = true; return; }
            const tasks = d.tasks.filter(t => t.target === s.id).slice(-5).reverse(), msgs = d.messages.filter(m => m.sessionRef === s.id).slice(-4).reverse();
            html = `<p class="eyebrow">${esc(provider(s).name)} · ${esc(d.hosts.hosts.find(h => h.id === s.hostId)?.label ?? s.hostId)}${s.seat?.role === 'service' ? ` · 服務座位 ${esc(s.seat.service)}` : ''}</p>${titleBlock('session', s.id, nameOf(s), s.title)}<p class="inspector-id">${esc(s.cwd ?? '')}</p>
              ${s.description ? `<p class="inspector-text">${esc(s.description)}</p>` : ''}
              ${s.providerLimit ? `<p class="inspector-hint state-warn">${s.providerLimit.kind === 'login' ? '登入失效' : '額度用完'}（${esc(relTime(s.providerLimit.since))}）：${esc(s.providerLimit.notice.slice(0, 160))}。${s.providerLimit.kind === 'login' ? '在那台機器上重新登入後，在機器詳情裡按「重新檢查這台」就解除；下一輪完成後也會解除。' : '下一輪完成後自動解除。'}</p>` : ''}<dl><dt>狀態</dt><dd>${esc(STATE_NAMES[s.nativeStatus] ?? s.nativeStatus)}${s.externalActivity ? ' · 有人直接在用' : ''}</dd><dt>模型</dt><dd>${esc(s.provider)}</dd><dt>Session ID</dt><dd class="mono">${esc(s.id)}</dd></dl>
              ${pauseBlock(s)}
              ${canEdit() ? claimsLine(s.id) : ''}${canEdit() ? helperOf(s.id) : ''}
              ${permissionBox(s)}
              ${sessionAsks(s)}
              ${composer(s)}
              ${dispatchControl(s)}
              <h3>最近任務</h3>${tasks.length ? tasks.map(taskLink).join('') : '<p class="muted">還沒有經 Router 派來的任務。</p>'}
              ${msgs.length ? `<h3>中途發來的消息</h3>${msgs.map(m => `<div class="mini-msg"><b>${esc(m.kind)}</b><span>${esc(m.text.slice(0, 140))}</span></div>`).join('')}` : ''}
              ${filesBlock(filesOf(s.id), '送收的檔案')}
              ${frontierSection(s)}
              ${editForm('session', s.id, { description: s.description, tags: s.tags })}`;
        } else if (sel.kind === 'mission') {
            const m = missions().find(x => x.key === sel.id); if (!m) { state.selected = null; el.hidden = true; return; }
            html = missionDetail(m);
        } else if (sel.kind === 'task') {
            const t = d.tasks.find(x => x.id === sel.id); if (!t) { state.selected = null; el.hidden = true; return; }
            html = taskDetail(t);
        } else if (sel.kind === 'router') {
            const running = d.tasks.filter(t => ACTIVE.has(t.state)).length;
            const pl = d.policy?.planner, turns = (d.plannerTurns ?? []).slice(-5).reverse();
            html = `<p class="eyebrow">總機</p><h2>Router 中台</h2><p class="inspector-text">認識所有機器和 session，負責送達、排隊、權限與記錄。規劃交給它喚醒的規劃者；每個權限請求的等級和誰能批，由這裡按你的規則判定。</p>
              <dl><dt>連著的機器</dt><dd>${d.hosts.hosts.length} 台</dd><dt>正在處理</dt><dd>${running} 件</dd><dt>規劃者</dt><dd>${!pl?.session ? '還沒建立' : `${esc(pl.session.name)} · ${!pl.enabled ? '已停用' : pl.session.busy ? '思考中' : '待命'}`}</dd>${pl?.session ? `<dt>待處理事件</dt><dd>${pl.pendingEvents} 件 · 最近一小時喚醒 ${pl.turnsLastHour}/${pl.maxTurnsPerHour} 次</dd>` : ''}<dt>模式</dt><dd>${esc(d.hosts.mode)}</dd></dl>
              ${pl?.sessionRef ? `<p><button type="button" class="link" data-goto-session="${esc(pl.sessionRef)}">打開規劃者 session</button></p>` : ''}
              ${turns.length ? `<h3>最近的喚醒</h3>${turns.map(t => `<div class="mini-msg"><b>${esc(STATE_NAMES[t.state] ?? t.state)}</b><span>${esc(relTime(t.createdAt))} · ${esc(t.prompt.replace(/^\[Router\]\s*/, '').split('。')[0])}</span></div>`).join('')}` : ''}
              <p class="inspector-hint">等級規則、誰能批、前臺上限和規劃者設定在「權限」。</p>`;
        } else if (sel.kind === 'local') {
            const m = localMember(sel.id); if (!m) { state.selected = null; el.hidden = true; return; }
            html = localDetail(m);
        } else if (sel.kind === 'peers') html = peersPanel();
        else if (sel.kind === 'helpers') html = helpersPanel();
        else if (sel.kind === 'resources') html = resourcesPanel();
        else if (sel.kind === 'transfers') html = transfersPanel();
        else if (sel.kind === 'calls') html = callsPanel(sel.id);
        else if (sel.kind === 'client') {
            const ts = d.tasks.filter(t => t.originKind === sel.id).slice(-6).reverse();
            html = `<p class="eyebrow">入口</p><h2>${esc(clientName(sel.id))}</h2><p class="inspector-text">從這個入口派出的任務與收到的消息。</p>
              ${ts.map(taskLink).join('') || '<p class="muted">還沒有任務。</p>'}`;
        }
        el.dataset.sel = key;
        el.innerHTML = `<button class="inspector-close" aria-label="關閉">✕</button>${html}`;
        $('.inspector-close', el).onclick = () => { state.selected = null; el.hidden = true; syncTagsSelected(); views.markSelected(); };
        el.querySelectorAll('.mini-task[data-task], .mini-step[data-task], .ask-ladder [data-task], .ask-row[data-task]').forEach(b => b.onclick = () => select({ kind: 'task', id: b.dataset.task }));
        el.querySelectorAll('[data-goto-mission]').forEach(b => b.onclick = () => select({ kind: 'mission', id: b.dataset.gotoMission }));
        el.querySelectorAll('[data-goto-session]').forEach(b => b.onclick = () => select({ kind: 'session', id: b.dataset.gotoSession }));
        el.querySelectorAll('[data-goto-local]').forEach(b => b.onclick = () => select({ kind: 'local', id: b.dataset.gotoLocal }));
        el.querySelectorAll('[data-copy]').forEach(b => b.onclick = async () => {
            try { await navigator.clipboard.writeText(b.dataset.copy); api.toast('已複製，貼到 Mac 的終端機執行'); }
            // no clipboard: select the command, and keep live redraws off it (its form counts as being edited) while you press ⌘C
            catch { const f = b.closest('form'), r = document.createRange(); r.selectNodeContents(b.previousElementSibling); getSelection().removeAllRanges(); getSelection().addRange(r);
                f.dataset.dirty = '1'; setTimeout(() => { delete f.dataset.dirty; }, 10000); api.toast('瀏覽器不讓複製：命令已選取，按 ⌘C', true); } });
        el.querySelectorAll('[data-check-logins]').forEach(b => b.onclick = async () => { b.disabled = true; b.textContent = '檢查中…';
            try { await api.act('psr_check_logins', { hostId: b.dataset.checkLogins }); api.toast('登入狀態已更新'); }
            catch (err) { api.toast(err.message, true); b.disabled = false; b.textContent = '重新檢查這台'; } });
        // Sections the viewer opened stay open across live redraws; work notes and a mission's forum load when opened.
        el.querySelectorAll('details[data-open-key]').forEach(dd => {
            const k = dd.dataset.openKey;
            $('summary', dd).addEventListener('click', () => { dd.open ? openSections.delete(k) : openSections.add(k); }); // recorded now, not on the later toggle event
            dd.ontoggle = () => { if (!dd.open) return; if (dd.dataset.frontier) loadFrontier(dd); if (dd.dataset.forum) loadForum(dd); };
            dd.open = openSections.has(k);
        });
        bindForm(); bindRename(); bindPermissions(); bindActions(el);
    }
    const openSections = new Set();
    function syncTagsSelected() { for (const [k, o] of state.objects) if (k.startsWith('label:session:')) o.el.classList.toggle('is-selected', state.selected?.kind === 'session' && 'session:' + state.selected.id === k.slice(6)); }
    function select(sel, opts = {}) {
        state.follow = opts.follow && sel.kind === 'task' && state.parcels.has(sel.id) && root.dataset.view !== 'tasks' ? sel.id : null;
        if (sel.kind === 'greenhouse') { setView('tasks'); views.showHistory(); view.goal = { target: state.layout.garden.greenhouse.clone(), distance: 46 * portrait(1.8) }; return; }
        state.selected = sel; renderInspector(true); syncTagsSelected(); syncGarden(); views.markSelected();
        if (state.follow) return; // the frame loop rides along with the box
        const L = state.layout; let to = null, near = 90;
        // In the garden a task belongs to its mission's plant; elsewhere the camera looks at the session that runs it.
        if (sel.kind === 'task') { const t = state.data.tasks.find(x => x.id === sel.id); sel = root.dataset.view === 'tasks' ? { kind: 'mission', id: t?.missionKey } : { kind: 'session', id: t?.target }; }
        if (sel.kind === 'mission') { const p = state.plants.get(sel.id); to = p ? p.pos.clone().setY(p.height * 0.45) : L.garden?.greenhouse; near = 40 + (p?.height ?? 0) * 1.2; }
        else if (sel.kind === 'host') { to = L.islands.get(sel.id)?.center; near = 62; }
        else if (sel.kind === 'session') { to = L.spots.get(sel.id); near = 44; }
        else if (sel.kind === 'local') { const m = localMember(sel.id); to = m ? L.islands.get(m.hostId)?.center : null; near = 62; }
        else if (['peers', 'resources', 'transfers'].includes(sel.kind)) to = null;
        else if (sel.kind === 'client') to = L.gates.get(sel.id); else to = new THREE.Vector3();
        if (to) view.goal = { target: to.clone(), distance: near * portrait(1.8) };
    }

    // ---------- controls ----------
    let drag = null;
    canvas.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY, az: view.azimuth, po: view.polar, moved: false }; canvas.setPointerCapture(e.pointerId); });
    canvas.addEventListener('pointermove', e => { if (!drag) return; if (!e.buttons) { drag = null; return; } const dx = e.clientX - drag.x, dy = e.clientY - drag.y; if (Math.abs(dx) + Math.abs(dy) > 4) { drag.moved = true; state.follow = null; } if (!drag.moved) return; view.azimuth = drag.az - dx * 0.005; view.polar = Math.min(1.25, Math.max(0.55, drag.po - dy * 0.004)); view.goal = null; });
    canvas.addEventListener('pointerup', e => { if (drag && !drag.moved) clickAt(e); drag = null; });
    canvas.addEventListener('pointercancel', () => { drag = null; });
    canvas.addEventListener('wheel', e => { e.preventDefault(); state.follow = null; view.distance = Math.min(MAX_DISTANCE, Math.max(28, view.distance * (1 + Math.sign(e.deltaY) * 0.08))); view.goal = null; }, { passive: false });
    const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
    function pickAt(x, y) { const rect = canvas.getBoundingClientRect(); ndc.set(((x - rect.left) / rect.width) * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1); ray.setFromCamera(ndc, camera); return ray.intersectObjects([...pick, ...gardenPick, ...parcelPick], false)[0]?.object.userData.pick ?? null; }
    function clickAt(e) { const p = pickAt(e.clientX, e.clientY); if (p) select(p, { follow: p.kind === 'task' }); }
    // Hover names what is under the pointer: a session shows its sign, an island shows the signs of its sessions.
    let hoverAt = null;
    canvas.addEventListener('pointermove', e => { if (!drag) hoverAt = [e.clientX, e.clientY]; });
    canvas.addEventListener('pointerleave', () => { hoverAt = null; state.hover = null; canvas.style.cursor = ''; });
    function updateHover() { if (!hoverAt) return; const p = pickAt(...hoverAt); hoverAt = null; state.hover = p; canvas.style.cursor = p ? 'pointer' : ''; }
    // A portrait screen sees less sideways, so the overview steps back until the outer islands fit.
    const sceneSpan = () => (state.layout?.ringR ?? 40) * 3.4 + 40, MAX_DISTANCE = 640;
    const portrait = (cap) => Math.min(cap, Math.max(1, 1.25 / camera.aspect));
    const fitDistance = () => Math.min(MAX_DISTANCE, sceneSpan() * portrait(2.2));
    function fitFog() { if (scene.fog) { scene.fog.near = worldFit() * 1.05 * state.fogScale[0]; scene.fog.far = worldFit() * 2.3 * state.fogScale[1]; } }
    const actions = {
        overview: () => { view.goal = areaGoal(root.dataset.view); view.polar = 0.98; view.turn = Math.atan2(Math.sin(HOME_AZIMUTH - view.azimuth), Math.cos(HOME_AZIMUTH - view.azimuth)); },
        left: () => { view.turn = (view.turn ?? 0) + Math.PI / 4; },
        right: () => { view.turn = (view.turn ?? 0) - Math.PI / 4; },
        zoomIn: () => { view.goal = { target: (view.goal?.target ?? view.target).clone(), distance: Math.max(28, (view.goal?.distance ?? view.distance) * 0.75) }; },
        zoomOut: () => { view.goal = { target: (view.goal?.target ?? view.target).clone(), distance: Math.min(MAX_DISTANCE, (view.goal?.distance ?? view.distance) * 1.3) }; },
        labels: () => { state.labels = !state.labels; labelLayer.classList.toggle('hidden', !state.labels); return state.labels; },
        tasks: () => setView('tasks'),
        showcase: () => setShowcase(!state.showcase),
        pixel: () => { state.pixel = !state.pixel; try { localStorage.setItem('psr-pixel', state.pixel ? 'on' : 'off'); } catch { /* a viewer convenience only */ } fx.setPixel(state.pixel); return state.pixel; },
    };

    // ---------- the sky: the configured place's clock and season, and the weather the Router reports (config weather) ----------
    // Any sky can be previewed: ?sky=clear|cloudy|overcast|fog|drizzle|rain|snow|storm, ?hour=0–24, ?season=spring|summer|autumn|winter.
    const SKY = new URLSearchParams(location.search), WEEKDAYS = { Sun: '日', Mon: '一', Tue: '二', Wed: '三', Thu: '四', Fri: '五', Sat: '六' };
    const CLOUD = { clear: 0, cloudy: 0.35, overcast: 0.75, fog: 0.6, drizzle: 0.7, rain: 0.85, snow: 0.7, storm: 0.95 };
    const SKY_WORDS = { clear: '晴', cloudy: '多雲', overcast: '陰', fog: '霧', drizzle: '毛毛雨', rain: '雨', snow: '雪', storm: '雷雨' };
    // a preview names one of the table's own keys, never a name every object inherits (?season=constructor, ?sky=toString)
    const own = (table, v) => v !== null && Object.hasOwn(table, v) ? v : null;
    const PREVIEW = { sky: own(CLOUD, SKY.get('sky')), season: own(SEASONS, SKY.get('season')) };
    const clockIn = zone => Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', weekday: 'short' }).formatToParts(new Date()).map(p => [p.type, p.value]));
    const hoursOf = hm => { const m = /^(\d{1,2}):(\d\d)$/.exec(hm ?? ''); return m ? Number(m[1]) + Number(m[2]) / 60 : null; };
    const ramp = (x, a, b) => Math.min(1, Math.max(0, (x - a) / (b - a)));
    function skyNow() {
        // no place configured: this computer's own time zone, and no weather
        const w = state.weather, now = w?.current, c = clockIn(w?.timezone ?? undefined), month = Number(c.month), south = w?.hemisphere === 'south';
        const forced = SKY.has('hour') && Number.isFinite(Number(SKY.get('hour'))), hour = forced ? Number(SKY.get('hour')) % 24 : (Number(c.hour) % 24) + Number(c.minute) / 60;
        const north = month >= 3 && month <= 5 ? 'spring' : month >= 6 && month <= 8 ? 'summer' : month >= 9 && month <= 11 ? 'autumn' : 'winter';
        const season = PREVIEW.season ?? (south ? { spring: 'autumn', summer: 'winter', autumn: 'spring', winter: 'summer' }[north] : north);
        const rise = hoursOf(now?.sunrise) ?? 6, set = hoursOf(now?.sunset) ?? 17.5, night = Math.max(1 - ramp(hour, rise - 0.6, rise + 0.4), ramp(hour, set - 0.3, set + 0.7));
        const golden = Math.max(0, 1 - Math.abs(hour - set) / 1.2, 1 - Math.abs(hour - rise) / 1.0) * (1 - night * 0.6);
        const kind = PREVIEW.sky ?? (Object.hasOwn(CLOUD, now?.kind ?? '') ? now.kind : 'clear');
        return { hour, season, night, golden, kind, cloud: CLOUD[kind] ?? 0, month, day: Number(c.day), weekday: WEEKDAYS[c.weekday] ?? c.weekday,
            hh: String(Math.floor(hour)).padStart(2, '0'), mm: forced ? String(Math.round((hour % 1) * 60) % 60).padStart(2, '0') : c.minute,
            temp: now?.temperature ?? null, wind: now?.windSpeed ?? 6, windDir: now?.windDirection ?? 300, precipitation: now?.precipitation ?? 0, live: !!now, shown: !!now || PREVIEW.sky !== null, place: w?.place ?? '' };
    }
    /** Light, haze, lamps and snow from the sky; a new season repaints the farm. */
    function applySky() {
        const k = skyNow(); state.sky = k;
        if (state.layout && k.season !== state.season) { buildWorld(); return; }
        const { night, golden, cloud } = k, wet = ['drizzle', 'rain', 'storm'].includes(k.kind), C = c => new THREE.Color(c);
        const top = C('#5aaee8').lerp(C('#f0a468'), golden * 0.8).lerp(C('#8d9fb0'), cloud * 0.8).lerp(C('#121a38'), night);
        const haze = C('#c4e6f6').lerp(C('#fbd49a'), golden).lerp(C('#cfd6dc'), cloud * 0.8).lerp(C('#2a3864'), night);
        root.style.setProperty('--sky-top', '#' + top.getHexString()); root.style.setProperty('--sky-low', '#' + haze.getHexString());
        state.fogScale = k.kind === 'fog' ? [0.6, 0.65] : wet || k.kind === 'snow' ? [0.9, 0.85] : [1, 1]; fitFog(); if (scene.fog) scene.fog.color.copy(haze);
        // night stays readable, as in Stardew: a blue moonlit world rather than a black one
        hemi.color.copy(top).lerp(C('#ffffff'), 0.55 * (1 - night)).lerp(C('#8394d6'), night * 0.75); hemi.groundColor.set(SEASONS[k.season].grass).lerp(C('#26355a'), 0.4 + night * 0.4);
        hemi.intensity = state.baseHemi = 1.25 - night * 0.3 - cloud * 0.15;
        sun.color.set('#fff2d6').lerp(C('#ffb46a'), golden * 0.7).lerp(C('#b4c2ff'), night); sun.intensity = (2.5 - cloud * 1.9) * (1 - night) + 0.95 * night;
        // Stardew's night is a blue wash with warm windows; dusk warms everything; rain greys it a little
        const grade = post.uniforms.grade.value.set(1, 1, 1).lerp(new THREE.Vector3(0.7, 0.76, 1.0), night).multiply(new THREE.Vector3(1, 1, 1).lerp(new THREE.Vector3(1.05, 0.95, 0.86), golden * (1 - night)));
        if (wet) grade.multiply(new THREE.Vector3(0.84, 0.88, 0.96));
        const lightsOn = Math.max(night, cloud > 0.7 ? 0.4 : 0);
        LANTERN.emissiveIntensity = 0.2 + lightsOn * 2.0; WINDOW.emissiveIntensity = lightsOn * 1.6; POOL.opacity = lightsOn * 0.42;
        const cover = k.kind === 'snow' ? 0.85 : 0;
        for (const m of state.snowables) m.color.set(m.userData.base).lerp(SNOW, cover);
        for (const m of crownCache.values()) m.color.set(m.userData.base).lerp(SNOW, cover * 0.6);
        fx.setSky(k); renderClock(k);
    }
    /** The corner clock, the way Stardew shows the day: date, weather and season, the time, and where. */
    /** Where, and the weather only when there is some (real, or previewed with ?sky=): never a made-up 晴. */
    const placeLine = k => { const sky = k.shown ? `${SKY_WORDS[k.kind] ?? k.kind}${k.temp === null ? '' : ` ${Math.round(k.temp)}°C`}` : '', text = [k.place, sky].filter(Boolean).join(' · ');
        return text ? `<p class="clk-place">${esc(text)}</p>` : ''; };
    function renderClock(k) {
        const clock = $('#park-clock', root); if (!clock) return;
        const icon = k.kind === 'clear' ? (k.night > 0.5 ? 'moon' : 'sun') : k.kind === 'cloudy' ? (k.night > 0.5 ? 'cloud' : 'partly') : k.kind === 'overcast' ? 'cloud' : k.kind === 'drizzle' ? 'rain' : k.kind;
        clock.innerHTML = `<p class="clk-date">週${esc(k.weekday)} · ${k.month}月${k.day}日</p><p class="clk-mid">${pixelIcon(icon)}<span class="clk-season season-${esc(k.season)}">${esc(SEASONS[k.season].name)}</span><b>${esc(k.hh)}:${esc(k.mm)}</b></p>${placeLine(k)}`;
        clock.title = k.live ? `${k.place}的天氣，來自 Open-Meteo，每 10 分鐘更新` : k.place ? `${k.place}的時間；沒有天氣（沒設座標，或暫時拿不到）` : '這台電腦的時間（Router 沒有設定地點，見設定檔的 weather）';
    }

    // ---------- weather you can see: rain, snow, drifting leaves or petals, fireflies, lightning ----------
    const fx = (() => {
        const r = rng('weather'), unit = () => [r() - 0.5, r(), r() - 0.5, r()];
        const RAIN = 1500, drops = Array.from({ length: RAIN }, unit), rainPos = new Float32Array(RAIN * 6), rainGeo = new THREE.BufferGeometry();
        rainGeo.setAttribute('position', new THREE.BufferAttribute(rainPos, 3));
        const rain = new THREE.LineSegments(rainGeo, new THREE.LineBasicMaterial({ color: '#dbe8ff', transparent: true, opacity: 0.55, depthWrite: false, fog: false }));
        const points = (n, size, extra = {}) => {
            const pos = new Float32Array(n * 3), col = new Float32Array(n * 3).fill(1), geo = new THREE.BufferGeometry();
            geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
            const m = new THREE.Points(geo, new THREE.PointsMaterial({ size, vertexColors: true, sizeAttenuation: false, transparent: true, depthWrite: false, fog: false, ...extra }));
            m.userData.size = size; return { m, pos, col, items: Array.from({ length: n }, unit) };
        };
        const snow = points(1300, 2), drift = points(150, 3), flies = points(80, 2, { blending: THREE.AdditiveBlending });
        for (const o of [rain, snow.m, drift.m, flies.m]) { o.frustumCulled = false; o.visible = false; scene.add(o); }
        let want = { rain: 0, snow: 0, drift: 0, flies: 0, storm: false, wx: 0, wz: 0 }, flash = 0, nextFlash = 0;
        function setSky(k) {
            const wind = Math.min(1, k.wind / 30), a = (k.windDir * Math.PI) / 180, palette = SEASONS[k.season].drift;
            const rainy = { drizzle: 0.3, rain: Math.min(1, 0.55 + k.precipitation * 0.15), storm: 1 }[k.kind] ?? 0;
            want = { rain: rainy, snow: k.kind === 'snow' ? 0.85 : 0, drift: palette.length && !rainy && !['snow', 'fog'].includes(k.kind) ? (0.2 + wind * 0.8) * (1 - k.night * 0.7) : 0,
                flies: k.season === 'summer' && k.night > 0.6 && !rainy ? 1 : 0, storm: k.kind === 'storm', wx: Math.sin(a) * (0.15 + wind), wz: Math.cos(a) * (0.15 + wind) };
            palette.forEach((hex, j) => { const c = new THREE.Color(hex); for (let i = j; i < drift.items.length; i += palette.length) drift.col.set([c.r, c.g, c.b], i * 3); });
            drift.m.geometry.attributes.color.needsUpdate = true;
        }
        function setPixel(on) { for (const p of [snow, drift, flies]) p.m.material.size = p.m.userData.size * (on ? 1 / renderer.getPixelRatio() : PIXEL); }
        function flow(p, amount, fall, sway, t) {
            const n = Math.round(p.items.length * amount), c = view.target, span = view.distance * 1.15, high = view.distance * 0.5;
            p.m.visible = n > 0; p.m.geometry.setDrawRange(0, n); if (!n) return;
            for (let i = 0; i < n; i++) {
                const q = p.items[i], o = i * 3; q[1] -= fall * (0.6 + q[3] * 0.8); if (q[1] < 0) { q[1] += 1; q[0] = r() - 0.5; q[2] = r() - 0.5; }
                const sw = Math.sin(t * (0.6 + q[3]) + q[3] * 20) * sway;
                p.pos[o] = c.x + (q[0] + sw + want.wx * q[1] * 0.08) * span; p.pos[o + 1] = q[1] * high; p.pos[o + 2] = c.z + (q[2] + sw * 0.6 + want.wz * q[1] * 0.08) * span;
            }
            p.m.geometry.attributes.position.needsUpdate = true;
        }
        function update(dt, t) {
            const c = view.target, span = view.distance * 1.15, high = view.distance * 0.5, step = Math.min(dt, 0.1);
            const nr = Math.round(RAIN * want.rain); rain.visible = nr > 0; rainGeo.setDrawRange(0, nr * 2);
            if (nr) {
                const len = high * 0.05;
                for (let i = 0; i < nr; i++) {
                    const d = drops[i], o = i * 6; d[1] -= step * (1.3 + d[3] * 0.6); if (d[1] < 0) { d[1] += 1; d[0] = r() - 0.5; d[2] = r() - 0.5; }
                    const x = c.x + d[0] * span + want.wx * d[1] * high * 0.3, y = d[1] * high, z = c.z + d[2] * span + want.wz * d[1] * high * 0.3;
                    rainPos[o] = x; rainPos[o + 1] = y; rainPos[o + 2] = z; rainPos[o + 3] = x + want.wx * len * 0.3; rainPos[o + 4] = y + len; rainPos[o + 5] = z + want.wz * len * 0.3;
                }
                rainGeo.attributes.position.needsUpdate = true;
            }
            flow(snow, want.snow, step * 0.09, 0.012, t); flow(drift, want.drift, step * 0.05, 0.03, t);
            flies.m.visible = !!want.flies;
            if (want.flies) {
                for (let i = 0; i < flies.items.length; i++) {
                    const q = flies.items[i], o = i * 3, b = Math.max(0, Math.sin(t * 1.7 + q[3] * 30)) ** 3;
                    flies.pos[o] = c.x + q[0] * span * 0.7 + Math.sin(t * 0.3 + q[3] * 9) * 2; flies.pos[o + 1] = 0.8 + q[1] * 2.5 + Math.sin(t * 0.9 + q[3] * 5) * 0.4; flies.pos[o + 2] = c.z + q[2] * span * 0.7 + Math.cos(t * 0.25 + q[3] * 7) * 2;
                    flies.col.set([0.9 * b, b, 0.45 * b], o);
                }
                flies.m.geometry.attributes.position.needsUpdate = true; flies.m.geometry.attributes.color.needsUpdate = true;
            }
            if (want.storm && t > nextFlash) { flash = 1; nextFlash = t + 4 + r() * 9; }
            flash *= Math.exp(-step * 7); const f = flash > 0.02 ? flash * (0.6 + 0.4 * Math.sin(t * 60)) : 0;
            post.uniforms.flash.value = f * 0.45; hemi.intensity = (state.baseHemi ?? 1.2) + f * 2;
        }
        return { setSky, setPixel, update };
    })();
    async function fetchWeather() { try { state.weather = await api.weather?.() ?? null; } catch { /* the sky keeps its clock */ } applySky(); }
    fx.setPixel(state.pixel); applySky(); fetchWeather(); setInterval(fetchWeather, 10 * 60000); setInterval(applySky, 30000);
    root.querySelector('[data-park="pixel"]')?.setAttribute('aria-pressed', String(state.pixel));

    // ---------- frame loop ----------
    const v = new THREE.Vector3(), timer = new THREE.Timer();
    function frame() {
        requestAnimationFrame(frame); if (document.hidden || root.hidden) return;
        // Time-based easing: camera moves arrive on time even when the browser delivers few frames.
        timer.update(); const dt = Math.min(timer.getDelta(), 1), t = timer.getElapsed(), ease = k => 1 - Math.exp(-dt * k);
        if (view.turn) { const step = view.turn * ease(6); view.azimuth += step; view.turn -= step; if (Math.abs(view.turn) < 0.002) view.turn = 0; }
        if (view.goal) { view.target.lerp(view.goal.target, ease(4)); view.distance += (view.goal.distance - view.distance) * ease(4); if (view.target.distanceTo(view.goal.target) < 0.05 && Math.abs(view.goal.distance - view.distance) < 0.3) view.goal = null; }
        setCamera();
        for (const [, o] of state.objects) {
            if (!o.group?.userData.critter) continue; const { critter: c, alert: a, smoke, chimney } = o.group.userData;
            // a working cottage smokes: three puffs rise from the chimney, swell and fade
            smoke.forEach((puff, i) => { puff.visible = !!o.busy; if (!o.busy) return; const k = (t * 0.45 + i / 3) % 1; puff.position.set(chimney.x + Math.sin(k * 5 + i) * 0.18, chimney.y + k * 1.7, chimney.z - k * 0.35); puff.scale.setScalar(0.2 + Math.sin(k * Math.PI) * 1.1); });
            if (a.visible) a.position.y = 4.1 + Math.sin(t * 3) * 0.12;
            if (o.offline) { c.position.y = 0.18; c.rotation.z = 0.25; continue; }
            c.rotation.z = 0; c.position.y = 0.18 + (o.busy ? Math.abs(Math.sin(t * 6 + o.group.id)) * 0.35 : Math.sin(t * 1.6 + o.group.id) * 0.04);
            if (o.busy) c.rotation.y = Math.sin(t * 2 + o.group.id) * 0.35;
        }
        // plants: running buds breathe, lanterns waiting for you pulse
        for (const [, p] of state.plants) for (const tip of p.group.userData.tips) {
            if (tip.kind === 'run') tip.head.scale.setScalar(tip.size * (1 + Math.sin(t * 4 + p.group.id) * 0.12));
            else if (tip.kind === 'need') { tip.head.rotation.z = Math.sin(t * 2.2 + p.group.id) * 0.18; tip.head.userData.glow.material.emissiveIntensity = 0.75 + Math.sin(t * 5) * 0.45; }
        }
        beltTexture.offset.y -= Math.min(dt, 0.25) * 0.9; TEX.water.offset.x += Math.min(dt, 0.25) * 0.03;
        for (const [, p] of state.parcels) {
            if (p.phase < 1) p.phase = Math.min(1, p.phase + Math.min(dt, 0.25) / 6);
            const at = pointOnRoute(p.route, p.phase), ahead = pointOnRoute(p.route, Math.min(1, p.phase + 0.004));
            p.mesh.position.copy(at).setY(0.14); if (ahead.distanceToSquared(at) > 1e-6) p.mesh.rotation.y = Math.atan2(ahead.x - at.x, ahead.z - at.z);
            p.pos.copy(at).setY(2.8);
        }
        if (state.follow) { const p = state.parcels.get(state.follow); if (p) { view.goal = null; view.target.lerp(p.mesh.position, ease(3)); view.distance += (36 * portrait(1.6) - view.distance) * ease(1.5); } else state.follow = null; }
        if (state.showcase) { showcaseTick(performance.now()); view.azimuth += dt * 0.02; }
        moveAskFlights(t);
        state.flights = state.flights.filter(f => { const k = (performance.now() - f.start) / f.ms; if (k >= 1) { dynamic.remove(f.mesh); return false; } f.mesh.position.copy(pointOnRoute(f.route, k)); if (f.arc) { f.mesh.position.y += Math.sin(k * Math.PI) * 4 + 0.6; f.mesh.rotation.z = Math.sin(t * 8) * 0.2; } return true; });
        fx.update(dt, t); draw();
        updateHover(); if (state.labels) placeLabels();
    }
    // Signs are HTML pinned to 3D points. Sessions win over machines when two would overlap; the loser steps upward.
    const LABEL_RANK = { flight: -1, parcel: 0, session: 0, mission: 0, client: 1, router: 1, host: 2, area: 2 };
    /** A box says what it is when you follow, hover or select it, and when you are close enough to read it. */
    function parcelTagShown(o) { const sel = state.selected, hov = state.hover; return state.follow === o.id || (sel?.kind === 'task' && sel.id === o.id) || (hov?.kind === 'task' && hov.id === o.id) || view.distance < fitDistance() * 0.4; }
    /** Mission signs: the ones that need you or are working always; the rest when you are in the garden, hover or select. */
    function missionSignShown(o) {
        const g = state.layout?.garden, hov = state.hover, sel = state.selected;
        const inGardenView = !!g && view.target.distanceTo(g.center) < GARDEN_W && view.distance < gardenFit() * 1.1;
        return o.important || (inGardenView && !o.finished) || (sel?.kind === 'mission' && sel.id === o.id) || (hov?.kind === 'mission' && hov.id === o.id);
    }
    /** Overview shows machines, gates and only the sessions that need a look; zooming in, hovering or selecting names the rest. */
    function sessionSignShown(o) {
        const hov = state.hover, sel = state.selected;
        const focusHost = hov?.kind === 'host' ? hov.id : sel?.kind === 'host' ? sel.id : null;
        return view.distance < fitDistance() * 0.55 || o.important || o.hostId === focusHost || (sel?.kind === 'session' && sel.id === o.id) || (hov?.kind === 'session' && hov.id === o.id);
    }
    function placeLabels() {
        const w = root.clientWidth, h = root.clientHeight, shown = [], cards = cardsShown();
        const box = root.getBoundingClientRect(), panel = id => { const el = $(id, root); return el && !el.hidden && el.offsetParent ? el.getBoundingClientRect() : null; };
        const left = [panel('#park-roster'), panel('#park-page')].filter(r => r && r.width < w / 2).reduce((m, r) => Math.max(m, r.right - box.left), 0), insp = panel('#park-inspector');
        const bar = [panel('#park-stats'), panel('#park-counter')].filter(Boolean).reduce((m, r) => Math.max(m, r.bottom - box.top), 0);
        const cardRects = placeCards(w, h, cards, left + 10, (insp && insp.width < w / 2 ? insp.left - box.left : w) - 10, bar + 10); placeBursts(w, h);
        for (const [k, o] of state.objects) {
            if (!k.startsWith('label:')) continue;
            // a session with its live card open needs no sign of its own
            if ((o.kind === 'session' && (!sessionSignShown(o) || cards.has(o.id))) || (o.kind === 'mission' && !missionSignShown(o)) || (o.kind === 'parcel' && !parcelTagShown(o))) { o.el.style.display = 'none'; continue; }
            v.copy(o.pos).project(camera);
            const visible = v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1;
            o.el.style.display = visible ? '' : 'none';
            if (visible) shown.push({ o, x: ((v.x + 1) / 2) * w, y: ((1 - v.y) / 2) * h, rank: o.el.classList.contains('is-selected') ? -1 : LABEL_RANK[k.split(':')[1]] ?? 1 });
        }
        for (const l of shown) { l.w = l.o.el.offsetWidth; l.h = l.o.el.offsetHeight; }
        // Machine signs are wide and sit on the outer rims: keep them clear of the side panels and the screen edges.
        const roster = panel('#park-roster'), inspector = panel('#park-inspector');
        const minX = (roster && roster.width < w / 2 ? roster.right - box.left : 0) + 10, maxX = (inspector && inspector.width < w / 2 ? inspector.left - box.left : w) - 10;
        for (const l of shown) if (l.rank === LABEL_RANK.host && maxX - minX > l.w) l.x = Math.min(Math.max(l.x, minX + l.w / 2), maxX - l.w / 2);
        shown.sort((a, b) => a.rank - b.rank || b.y - a.y);
        const placed = cardRects.map(r => ({ x: r.x + r.w / 2, w: r.w, h: r.h, top: r.top })), overlaps = top => l => placed.find(p => Math.abs(p.x - l.x) < (p.w + l.w) / 2 + 4 && top < p.top + p.h + 3 && top + l.h > p.top - 3);
        for (const l of shown) {
            // Step up past at most two signs; a sign that still has no room waits until the view changes (the selected one always shows).
            let top = l.y - l.h, hit = overlaps(top)(l);
            for (let step = 0; hit && step < 2; step++) { top = hit.top - l.h - 4; hit = overlaps(top)(l); }
            if (hit && l.rank >= 0) { l.o.el.style.visibility = 'hidden'; continue; }
            l.o.el.style.visibility = '';
            placed.push({ x: l.x, w: l.w, h: l.h, top });
            l.o.el.style.transform = `translate(${l.x}px, ${top}px) translate(-50%, 0)`;
        }
    }
    // ---------- three ways to look at the same fleet: 總覽 (3D), 機器, 任務 ----------
    const views = createViews($('#park-page', root), {
        esc, provider, nameOf, clientName, clientColor, sessionState, taskTitle: t => shortTitle(taskTitle(t), 40), fullTitle: taskTitle, relTime, STATE_NAMES, ACTIVE, ATTENTION, TERMINAL, PEN, missions, missionWord, MISSION_STATE, taskCls, partState, serviceColor,
        canEdit: () => canEdit(), selected: () => state.selected, select: sel => select(sel), renameInPlace,
        can: scope => can(scope), isAdmin: () => !!state.data?.identity?.scopes?.includes('admin'), hostLabel: id => hostLabel(id), act: api.act, read: api.read, toast: api.toast,
    });
    function setView(v) {
        v = ['overview', 'machines', 'tasks', 'relations', 'policy'].includes(v) ? v : 'overview';
        root.dataset.view = v; $('#park-page', root).hidden = v === 'overview';
        root.querySelectorAll('[data-view]').forEach(b => { b.classList.toggle('is-on', b.dataset.view === v); b.setAttribute('aria-selected', String(b.dataset.view === v)); });
        // one world: switching views is a camera flight, never a cut to a flat page
        if (state.layout) { view.goal = areaGoal(v); view.polar = 0.98; }
        views.show(v); renderInspector(true); api.viewChanged?.(v);
    }
    root.querySelectorAll('[data-view]').forEach(b => b.onclick = () => setView(b.dataset.view));
    root.dataset.view = 'overview';
    resize(); setCamera(); frame();

    return {
        setView,
        update(data) {
            state.data = data; const layout = computeLayout(data);
            if (!state.layout || layout.signature !== state.layout.signature) { const first = !state.layout; for (const [, p] of state.parcels) dynamic.remove(p.mesh); state.parcels.clear(); for (const [k, o] of state.objects) if (k.startsWith('queue:')) dynamic.remove(o.group); state.layout = layout; dropAskFlights(); buildWorld(); if (first) { const g = areaGoal(root.dataset.view); view.target.copy(g.target); view.distance = g.distance; setCamera(); } }
            else { // names and online state can change without moving anything
                for (const [hostId, isl] of state.layout.islands) { const h = data.hosts.hosts.find(x => x.id === hostId); if (h) isl.host = h; isl.sessions = data.sessions.filter(s => s.hostId === hostId); const tag = state.objects.get('label:host:' + hostId)?.el; if (tag) hostTag(tag, isl.host, data.hosts.daemons.filter(x => x.hostId === hostId).some(x => x.connection === 'online')); }
            }
            syncLive(); $('.park-loading', root)?.remove();
            if (!state.showcaseChecked) { state.showcaseChecked = true; if (location.hash === '#showcase') setShowcase(true); }
        },
        action(name) { return actions[name]?.(); },
        setStreamState(text, ok) { const el = $('#park-live', root); if (el) { el.textContent = text; el.classList.toggle('is-off', !ok); } },
    };
}
