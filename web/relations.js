// 關係: who works with whom, drawn from what the Router recorded. Each machine is a column (the entries that give work, you,
// Muse, Grokbot and the others, come first), each session a box, and each kind of link between two of them one arrow with a
// count: 派工 (an entry or the planner gave it a turn), 交接 (a finished task was handed on), 呼叫服務 (psr_ask), 驗收 (an
// arbiter seat checked its work), 建立 (who asked the Router for it), 訊息 (local sessions writing to each other), 傳檔 and 幫手 (a
// local session's request you approved: from it to the session the Router started for it). An arrow opens the tasks behind it; a
// box opens the session. Local sessions, creators, messages and helper requests come with the console's shared load.
const KINDS = {
    assign: { name: '派工', color: 'oklch(52% 0.13 250)' },
    handoff: { name: '交接', color: 'oklch(55% 0.15 150)' },
    ask: { name: '呼叫服務', color: 'oklch(60% 0.15 65)' },
    verify: { name: '驗收', color: 'oklch(52% 0.15 305)' },
    created: { name: '建立', color: 'oklch(62% 0.02 250)' },
    message: { name: '訊息', color: 'oklch(56% 0.17 28)' },
    file: { name: '傳檔', color: 'oklch(50% 0.11 205)' },
    helper: { name: '幫手', color: 'oklch(54% 0.16 345)' },
};
const WINDOWS = [[86400000, '最近 24 小時'], [7 * 86400000, '最近 7 天'], [30 * 86400000, '最近 30 天'], [0, '全部時間']];
const W = 168, H = 44, GAP_Y = 14, COL_GAP = 88, PAD = 18, HEAD = 34, ARCH = 64;
const ENTRY_ORDER = ['web', 'cli', 'muse', 'grokbot', 'dot', 'planner'];

export function createRelations(page, ctx) {
    const { esc, clientName, clientColor, nameOf, STATE_NAMES, relTime } = ctx;
    const ui = { mission: 'all', window: 86400000, kinds: new Set(Object.keys(KINDS)), idle: false, focus: null };
    let data = null, sig = null;
    const $ = s => page.querySelector(s);

    function frame() {
        return `<section class="pg-panel pg-relations" aria-label="session 之間的關係">
          <header class="pg-head"><h2>關係</h2><span id="rel-count"></span>
            <select id="rel-mission" aria-label="mission"></select><select id="rel-window" aria-label="時間">${WINDOWS.map(([v, l]) => `<option value="${v}"${ui.window === v ? ' selected' : ''}>${l}</option>`).join('')}</select>
            <label class="check rel-idle"><input type="checkbox" id="rel-idle"${ui.idle ? ' checked' : ''}> 也顯示沒有往來的 session</label></header>
          <div class="rel-kinds" id="rel-kinds">${Object.entries(KINDS).map(([k, x]) => `<button type="button" class="rel-kind${ui.kinds.has(k) ? ' is-on' : ''}" data-kind="${k}" style="--c:${x.color}"><i></i>${x.name}</button>`).join('')}</div>
          <div class="rel-scroll" id="rel-scroll"><div id="rel-graph"></div></div>
          <div class="rel-detail" id="rel-detail" hidden></div></section>`;
    }
    function bind() {
        $('#rel-window').onchange = e => { e.target.blur(); ui.window = Number(e.target.value); sig = null; draw(); };
        $('#rel-mission').onchange = e => { e.target.blur(); ui.mission = e.target.value; sig = null; draw(); };
        $('#rel-idle').onchange = e => { ui.idle = e.target.checked; sig = null; draw(); };
        $('#rel-kinds').querySelectorAll('[data-kind]').forEach(b => b.onclick = () => { const k = b.dataset.kind; ui.kinds.has(k) ? ui.kinds.delete(k) : ui.kinds.add(k); b.classList.toggle('is-on', ui.kinds.has(k)); sig = null; draw(); });
        $('#rel-graph').onclick = e => {
            const edge = e.target.closest('[data-edge]'), node = e.target.closest('[data-node]');
            if (edge) { ui.focus = ui.focus === `e:${edge.dataset.edge}` ? null : `e:${edge.dataset.edge}`; }
            else if (node) { const id = node.dataset.node; ui.focus = `n:${id}`; if (id.startsWith('s:')) ctx.select({ kind: 'session', id: id.slice(2) }); else if (id.startsWith('c:')) ctx.select({ kind: 'client', id: id.slice(2) }); }
            else ui.focus = null;
            sig = null; draw();
        };
        $('#rel-detail').onclick = e => { const t = e.target.closest('[data-task]'); if (t) ctx.select({ kind: 'task', id: t.dataset.task }); const s = e.target.closest('[data-session]'); if (s) ctx.select({ kind: 'session', id: s.dataset.session }); };
    }
    function render(d) { data = d; draw(); }

    // ---------- the graph: nodes and aggregated links within the filters ----------
    function model() {
        const now = Date.now(), inWindow = at => !ui.window || (typeof at === 'number' && now - at <= ui.window);
        const missionOf = new Map(), mlist = ctx.missions();
        for (const m of mlist) for (const t of m.steps) missionOf.set(t.id, m.key);
        const inMission = taskId => ui.mission === 'all' || missionOf.get(taskId) === ui.mission;
        const byId = new Map(data.tasks.map(t => [t.id, t])), sessions = new Map(data.sessions.map(s => [s.id, s]));
        const treeNodes = new Map(), locals = new Map();
        const walk = ns => { for (const n of ns) { treeNodes.set(n.sessionRef, n); walk(n.children ?? []); } };
        for (const g of data.tree?.groups ?? []) { walk(g.children ?? []); for (const m of g.members ?? []) locals.set(m.memberId, m); }
        const plannerRef = data.policy?.planner?.sessionRef ?? [...treeNodes.values()].find(n => n.role === 'planner')?.sessionRef ?? null;
        const nodes = new Map(), edges = new Map();
        const node = (id, info) => { if (!nodes.has(id)) nodes.set(id, { id, ...info }); return id; };
        const sessionNode = (ref, hostHint) => {
            const s = sessions.get(ref), n = treeNodes.get(ref);
            return node(`s:${ref}`, { kind: 'session', ref, host: s?.hostId ?? n?.hostId ?? hostHint ?? '?', label: s ? nameOf(s) : n?.name ?? ref.slice(0, 10), sub: s ? `${String(s.provider).split('/')[0]} · ${s.cwd ?? ''}` : n ? `${String(n.provider).split('/')[0]} · ${n.cwd ?? ''}` : '已不在',
                gone: !s && !n, planner: ref === plannerRef || n?.role === 'planner', seat: s?.seat?.role ?? n?.role ?? null, state: s ? ctx.sessionState(s) : null });
        };
        const entryNode = k => k === 'planner' && plannerRef ? sessionNode(plannerRef) : node(`c:${k}`, { kind: 'entry', ref: k, host: null, label: clientName(k), color: clientColor(k), sub: k === 'web' ? '總控臺（你）' : '入口' });
        const localNode = (id, name, hostId) => { const m = locals.get(id); return node(`l:${id}`, { kind: 'local', ref: id, host: m?.hostId ?? hostId ?? '?', label: m?.name ?? name ?? id, sub: m ? `本機 ${m.provider} · ${m.branch ? `${m.repo ?? ''}@${m.branch}` : m.cwd ?? ''}` : '本機 · 已離開', gone: !m, live: m?.live }); };
        const link = (kind, from, to, item) => {
            if (!ui.kinds.has(kind) || from === to) return;
            const key = `${kind}|${from}|${to}`; let e = edges.get(key);
            if (!e) edges.set(key, e = { key, kind, from, to, items: [], last: 0 });
            e.items.push(item); e.last = Math.max(e.last, item.at ?? 0);
        };
        for (const t of data.tasks) {
            if (!inWindow(t.createdAt) || !inMission(t.id) || t.routerTurn === 'service') continue; // service turns are drawn from their call
            const to = sessionNode(t.target, t.hostId), item = { type: 'task', id: t.id, at: t.createdAt };
            if (t.routerTurn === 'arbiter') { const src = byId.get(t.verifyOf); if (src) link('verify', sessionNode(src.target, src.hostId), to, item); continue; }
            const dep = t.dependencyId && byId.get(t.dependencyId);
            if (dep && dep.target !== t.target) link('handoff', sessionNode(dep.target, dep.hostId), to, item);
            else link('assign', entryNode(t.originKind), to, item);
        }
        for (const a of data.asks ?? []) {
            if (!a.seatRef || !inWindow(a.createdAt) || !inMission(a.callerTask)) continue;
            link('ask', sessionNode(a.callerSession), sessionNode(a.seatRef), { type: 'ask', id: a.id, task: a.turnTaskIds?.at(-1) ?? a.callerTask, at: a.createdAt, text: a.service, state: a.state });
        }
        for (const n of treeNodes.values()) {
            const by = n.createdBy; if (!by || !inWindow(n.createdAt) || ui.mission !== 'all') continue;
            const from = by.kind === 'planner' ? (by.sessionRef ? sessionNode(by.sessionRef) : entryNode('planner')) : entryNode(by.kind);
            link('created', from, sessionNode(n.sessionRef), { type: 'created', id: n.sessionRef, at: n.createdAt });
        }
        if (ui.mission === 'all') for (const x of data.peers?.messages ?? []) {
            if (!inWindow(x.createdAt) || x.to.kind !== 'local') continue;
            const from = x.from.kind === 'local' ? localNode(x.from.memberId, x.from.name, x.from.hostId) : x.from.kind === 'owner' ? entryNode('web') : null;
            if (from) link('message', from, localNode(x.to.memberId, x.to.name, x.to.hostId), { type: 'message', id: x.messageId, at: x.createdAt, text: x.text, state: x.state ?? x.delivery, kind: x.kind });
        }
        const fileNode = y => y.kind === 'agent' ? sessionNode(y.ref, y.hostId) : y.kind === 'local' ? localNode(y.ref, y.name, y.hostId) : y.kind === 'owner' ? entryNode('web')
            : node(`m:${y.hostId}`, { kind: 'machine', ref: y.hostId, host: y.hostId ?? '?', label: `${ctx.hostLabel(y.hostId)} psr-xfer`, sub: '命令列傳檔' });
        for (const t of data.transfers?.transfers ?? []) {
            const to = t.receivedBy ?? t.receiving; if (!to || !inWindow(t.createdAt) || (ui.mission !== 'all' && t.missionId !== ui.mission)) continue;
            link('file', fileNode(t.from), fileNode(to), { type: 'file', id: t.id, at: t.createdAt, text: t.name, size: t.size, state: t.state });
        }
        for (const r of data.helpers?.requests ?? []) {
            if (!r.sessionRef || !r.taskId || !inWindow(r.createdAt) || !inMission(r.taskId)) continue; // only what you approved
            link('helper', localNode(r.from.memberId, r.from.name, r.from.hostId), sessionNode(r.sessionRef, r.hostId), { type: 'helper', id: r.requestId, task: r.taskId, at: r.createdAt, text: r.purpose ?? r.task.split('\n')[0], state: r.state });
        }
        // nodes without a link stay out unless asked for (or chosen)
        const linked = new Set([...edges.values()].flatMap(e => [e.from, e.to]));
        if (ui.idle) { for (const s of data.sessions) sessionNode(s.id); for (const m of locals.values()) localNode(m.memberId); }
        for (const id of [...nodes.keys()]) if (!linked.has(id) && !ui.idle && ui.focus !== `n:${id}`) nodes.delete(id);
        return { nodes, edges: [...edges.values()].filter(e => nodes.has(e.from) && nodes.has(e.to)), missions: mlist };
    }
    function layout(nodes, edges) {
        const hosts = data.hosts.hosts.map(h => h.id), cols = [];
        const entries = [...nodes.values()].filter(n => n.kind === 'entry').sort((a, b) => ENTRY_ORDER.indexOf(a.ref) - ENTRY_ORDER.indexOf(b.ref));
        if (entries.length) cols.push({ id: 'entries', title: '入口', nodes: entries });
        for (const h of [...hosts, ...new Set([...nodes.values()].map(n => n.host).filter(x => x && !hosts.includes(x)))]) {
            const ns = [...nodes.values()].filter(n => n.kind !== 'entry' && n.host === h);
            if (ns.length) cols.push({ id: h, title: ctx.hostLabel(h), online: data.hosts.daemons.some(d => d.hostId === h && d.connection === 'online'), nodes: ns.sort((a, b) => (b.planner - a.planner) || (a.kind === 'local') - (b.kind === 'local') || a.label.localeCompare(b.label)) });
        }
        const place = () => cols.forEach((c, i) => c.nodes.forEach((n, j) => { n.col = i; n.x = PAD + i * (W + COL_GAP); n.y = HEAD + ARCH + PAD + j * (H + GAP_Y); }));
        place();
        // two barycentre sweeps: each box moves towards the boxes it links to, so arrows cross less
        const nb = new Map(); for (const e of edges) { (nb.get(e.from) ?? nb.set(e.from, []).get(e.from)).push(e.to); (nb.get(e.to) ?? nb.set(e.to, []).get(e.to)).push(e.from); }
        for (let pass = 0; pass < 2; pass++) {
            for (const c of cols) { if (c.id === 'entries') continue; const bc = n => { const ys = (nb.get(n.id) ?? []).map(id => nodes.get(id)).filter(m => m && m.col !== n.col).map(m => m.y); return ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : n.y; };
                c.nodes.sort((a, b) => (b.planner - a.planner) || bc(a) - bc(b)); }
            place();
        }
        const width = PAD * 2 + cols.length * W + Math.max(0, cols.length - 1) * COL_GAP, height = HEAD + ARCH + PAD * 2 + Math.max(1, ...cols.map(c => c.nodes.length)) * (H + GAP_Y);
        return { cols, width, height };
    }
    function edgePath(a, b, shift) {
        const ay = a.y + H / 2 + shift, by = b.y + H / 2 + shift;
        if (a.col === b.col) { const sx = a.x + W, ex = b.x + W, bulge = 34 + Math.abs(by - ay) * 0.18; return { d: `M${sx} ${ay} C${sx + bulge} ${ay} ${ex + bulge} ${by} ${ex + 6} ${by}`, mx: sx + bulge * 0.75, my: (ay + by) / 2 }; }
        const fwd = a.col < b.col, sx = fwd ? a.x + W : a.x, ex = fwd ? b.x - 6 : b.x + W + 6, dx = (ex - sx) / 2;
        // an arrow that skips a column arches over the boxes in it (a cubic rises 3/4 of its control points' lift)
        const span = Math.abs(b.col - a.col), lift = span > 1 ? (H / 2 + GAP_Y + 6 * span) / 0.75 : 0, top = Math.min(ay, by) - lift;
        if (lift) { // its label sits nearer the target, so arches from one box to different boxes keep their labels apart
            const p = [[sx, ay], [sx + dx * 0.4, top], [ex - dx * 0.4, top], [ex, by]], t = 0.72, u = 1 - t, at = i => u ** 3 * p[0][i] + 3 * u * u * t * p[1][i] + 3 * u * t * t * p[2][i] + t ** 3 * p[3][i];
            return { d: `M${sx} ${ay} C${p[1][0]} ${top} ${p[2][0]} ${top} ${ex} ${by}`, mx: at(0), my: at(1) };
        }
        return { d: `M${sx} ${ay} C${sx + dx} ${ay} ${ex - dx} ${by} ${ex} ${by}`, mx: (sx + ex) / 2, my: (ay + by) / 2 };
    }
    function draw() {
        if (!data || !page.contains($('#rel-graph'))) return;
        if (page.contains(document.activeElement) && document.activeElement.matches('select')) return; // a dropdown is open
        const { nodes, edges, missions: mlist } = model();
        const s = JSON.stringify([[...nodes.values()].map(n => [n.id, n.label, n.sub, n.state?.cls]), edges.map(e => [e.key, e.items.length]), ui.focus, !!data.tree, ui.mission, mlist.length]);
        if (s === sig) return; sig = s;
        const sel = $('#rel-mission');
        sel.innerHTML = `<option value="all">全部 mission</option>${mlist.slice(0, 60).map(m => `<option value="${esc(m.key)}"${ui.mission === m.key ? ' selected' : ''}>${esc(m.name.slice(0, 40))}</option>`).join('')}`;
        if (ui.mission !== 'all' && !mlist.some(m => m.key === ui.mission)) ui.mission = 'all';
        const { cols, width, height } = layout(nodes, edges);
        const focusNode = ui.focus?.startsWith('n:') ? ui.focus.slice(2) : null, focusEdge = ui.focus?.startsWith('e:') ? ui.focus.slice(2) : null;
        const lit = e => (!focusNode && !focusEdge) || e.key === focusEdge || e.from === focusNode || e.to === focusNode;
        const pairs = new Map(); for (const e of edges) { const p = [e.from, e.to].sort().join('|'); (pairs.get(p) ?? pairs.set(p, []).get(p)).push(e); }
        $('#rel-count').textContent = `${nodes.size} 個 · ${edges.reduce((n, e) => n + e.items.length, 0)} 條往來`;
        const markers = Object.entries(KINDS).map(([k, x]) => `<marker id="rel-arrow-${k}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="${x.color}"/></marker>`).join('');
        const heads = cols.map(c => `<text class="rel-col" x="${PAD + c.nodes[0].col * (W + COL_GAP)}" y="${PAD + 12}">${c.online === undefined ? '' : `<tspan class="${c.online ? 'rel-on' : 'rel-off'}">● </tspan>`}${esc(c.title)}</text>`).join('');
        const paths = edges.map(e => {
            const a = nodes.get(e.from), b = nodes.get(e.to), group = pairs.get([e.from, e.to].sort().join('|')), shift = (group.indexOf(e) - (group.length - 1) / 2) * 7;
            const { d, mx, my } = edgePath(a, b, shift), k = KINDS[e.kind], n = e.items.length, wdt = 1.4 + Math.min(3, Math.log2(n));
            return `<g class="rel-edge${lit(e) ? '' : ' is-dim'}${e.key === focusEdge ? ' is-focus' : ''}" data-edge="${esc(e.key)}"><path class="rel-hit" d="${d}"/><path d="${d}" stroke="${k.color}" stroke-width="${wdt}" marker-end="url(#rel-arrow-${e.kind})"${e.kind === 'created' ? ' stroke-dasharray="4 4"' : ''}/>
              <text x="${mx}" y="${my - 5}" fill="${k.color}">${k.name}${n > 1 ? ` ${n}` : ''}</text></g>`;
        }).join('');
        const boxes = [...nodes.values()].map(n => {
            const dim = focusNode && n.id !== focusNode && !edges.some(e => (e.from === focusNode && e.to === n.id) || (e.to === focusNode && e.from === n.id));
            const tone = n.kind === 'entry' ? n.color : n.kind === 'local' ? 'oklch(58% 0.1 200)' : n.planner ? 'oklch(52% 0.12 255)' : 'oklch(60% 0.05 150)';
            const badge = n.kind === 'local' ? '本機' : n.planner ? '規劃者' : n.seat === 'service' ? '服務座位' : n.seat === 'arbiter' ? '驗收座位' : n.state && ['warn', 'err'].includes(n.state.cls) ? n.state.text : '';
            return `<g class="rel-node${dim ? ' is-dim' : ''}${n.id === focusNode ? ' is-focus' : ''}${n.gone ? ' is-gone' : ''}" data-node="${esc(n.id)}" transform="translate(${n.x} ${n.y})"><title>${esc(`${n.label}\n${n.sub}`)}</title>
              <rect width="${W}" height="${H}" rx="11"/><rect class="rel-tone" width="5" height="${H - 16}" x="7" y="8" rx="2.5" fill="${tone}"/>
              <text class="rel-name" x="19" y="18">${esc(n.label.length > 19 ? n.label.slice(0, 18) + '…' : n.label)}</text><text class="rel-sub" x="19" y="34">${esc(badge ? `${badge} · ` : '')}${esc((n.sub.length > 24 ? n.sub.slice(0, 23) + '…' : n.sub))}</text></g>`;
        }).join('');
        $('#rel-graph').innerHTML = nodes.size ? `<svg class="rel-svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="session 關係圖"><defs>${markers}</defs>${heads}${paths}${boxes}</svg>`
            : `<p class="pg-empty">${!data.tree ? '還在讀 session 樹…' : ui.mission !== 'all' ? '這個 mission 在這段時間裡沒有 session 之間的往來。' : '這段時間裡沒有往來。換一個時間範圍，或勾「也顯示沒有往來的 session」。'}</p>`;
        detail(nodes, edges, focusNode, focusEdge);
    }
    function detail(nodes, edges, focusNode, focusEdge) {
        const box = $('#rel-detail'), e = focusEdge && edges.find(x => x.key === focusEdge), n = focusNode && nodes.get(focusNode);
        if (!e && !n) { box.hidden = true; box.innerHTML = ''; return; }
        box.hidden = false;
        if (n) {
            const mine = edges.filter(x => x.from === n.id || x.to === n.id);
            const line = x => `<li><b style="color:${KINDS[x.kind].color}">${KINDS[x.kind].name}</b> ${x.from === n.id ? '→' : '←'} ${esc(nodes.get(x.from === n.id ? x.to : x.from).label)} <span class="muted">${x.items.length} 次 · ${esc(relTime(x.last))}</span></li>`;
            box.innerHTML = `<p class="rel-detail-head"><b>${esc(n.label)}</b> <span class="muted">${esc(n.sub)}${n.kind === 'local' ? (n.live ? ' · 在線' : ' · 不在線') : ''}</span></p>${mine.length ? `<ul>${mine.map(line).join('')}</ul>` : '<p class="muted">這段時間裡沒有往來。</p>'}`;
            return;
        }
        const k = KINDS[e.kind], items = [...e.items].sort((a, b) => (b.at ?? 0) - (a.at ?? 0)).slice(0, 12), byId = new Map(data.tasks.map(t => [t.id, t]));
        const row = it => {
            if (it.type === 'task') { const t = byId.get(it.id); return t ? `<li><button type="button" class="link" data-task="${esc(t.id)}">${esc(ctx.taskTitle(t))}</button> <span class="muted">${esc(STATE_NAMES[t.state] ?? t.state)} · ${esc(relTime(t.createdAt))}</span></li>` : ''; }
            if (it.type === 'ask') return `<li><button type="button" class="link" data-task="${esc(it.task)}">${esc(it.text)} 服務</button> <span class="muted">${esc(it.state)} · ${esc(relTime(it.at))}</span></li>`;
            if (it.type === 'created') return `<li><button type="button" class="link" data-session="${esc(it.id)}">建立</button> <span class="muted">${esc(relTime(it.at))}</span></li>`;
            if (it.type === 'helper') return `<li><button type="button" class="link" data-task="${esc(it.task)}">${esc(String(it.text).slice(0, 60))}</button> <span class="muted">${esc({ running: '進行中', done: '完成', failed: '失敗', canceled: '已取消' }[it.state] ?? it.state)} · ${esc(relTime(it.at))}</span></li>`;
            if (it.type === 'file') return `<li><b>${esc(it.text)}</b> <span class="muted">${it.size < 1048576 ? `${Math.max(1, Math.round(it.size / 1024))} KB` : `${(it.size / 1048576).toFixed(1)} MB`} · ${it.state === 'received' ? '已收' : '正在收'} · ${esc(relTime(it.at))}</span></li>`;
            return `<li><b>${it.kind === 'request' ? '請求' : '通知'}</b> ${esc(String(it.text).slice(0, 140))} <span class="muted">${esc(it.state ?? '')} · ${esc(relTime(it.at))}</span></li>`;
        };
        box.innerHTML = `<p class="rel-detail-head"><b style="color:${k.color}">${k.name}</b> ${esc(nodes.get(e.from).label)} → ${esc(nodes.get(e.to).label)} <span class="muted">${e.items.length} 次${e.items.length > items.length ? `，列出最近 ${items.length} 次` : ''}</span></p><ul>${items.map(row).join('')}</ul>`;
    }
    return { frame, bind, render };
}
