// 機器 and 任務 as side panels over the same 3D world: the list you work in sits on the left, the scene stays behind it
// and flies to whatever you pick. 機器 looks from machines down to their sessions; 任務 lists missions (one user goal,
// possibly many sessions) with their steps, and the 歷史 filter opens what the greenhouse keeps.

import { createRelations } from '/relations.js';

// ---------- 登入: each provider's login on a machine, from the Router's last check (psr_check_logins) read against now ----------
const PROVIDER_NAMES = { claude: 'Claude', codex: 'Codex' };
export const providerName = p => PROVIDER_NAMES[p] ?? p;
const day = ms => new Date(ms).toLocaleDateString('zh-TW', { month: 'numeric', day: 'numeric' });
const daysLeft = ms => Math.max(0, Math.ceil((ms - Date.now()) / 86400000));
/** [text, cls]: err means the owner must log in again on that machine, warn soon, muted that the Router cannot tell. */
export function loginState(l) {
    switch (l.state) {
        case 'ok': return [l.expiresAt ? `已登入 · ${day(l.expiresAt)} 到期` : '已登入', 'run'];
        case 'expiring': return [`${daysLeft(l.expiresAt)} 天後到期（${day(l.expiresAt)}）`, 'warn'];
        case 'expired': return ['登入已過期', 'err'];
        case 'logged_out': return ['沒有登入', 'err'];
        case 'failed': return ['最近一輪登入失敗', 'err'];
        case 'unverified': return ['可用 · 看不出登入狀態', 'muted'];
        case 'unknown': return ['檢查失敗', 'muted'];
        default: return ['還沒檢查', 'muted'];
    }
}
/** The logins of a machine that need the owner, one line per provider: for its card. */
export function loginAlerts(logins) {
    const seen = new Map();
    for (const l of logins ?? []) {
        const [, cls] = loginState(l);
        if (cls !== 'err' && cls !== 'warn') continue;
        const text = cls === 'err' ? `${providerName(l.provider)} 要重新登入` : `${providerName(l.provider)} ${daysLeft(l.expiresAt)} 天後到期`;
        if (!seen.has(l.provider) || cls === 'err') seen.set(l.provider, [text, cls]);
    }
    return [...seen.values()];
}
export function createViews(page, ctx) {
    const { esc, provider, nameOf, clientName, clientColor, sessionState, taskTitle, relTime, STATE_NAMES, ATTENTION, PEN, missions, missionWord, MISSION_STATE, taskCls, partState, serviceColor } = ctx;
    const SCOPE_NAMES = { read: '看進度', goal: '下目標', plan: '批准方案', submit: '直接派工', cancel: '取消任務', handoff: '交接', create: '建 session', approve: '批准權限請求', frontier: '工作筆記', bind: '綁定 worker' };
    const TARGET_SCOPES = ['read', 'goal', 'plan'];
    const DAY = 86400000;
    const ui = { view: 'overview', host: 'all', sessionFilter: 'all', sessionQ: '', missionFilter: 'all', client: 'all', taskHost: 'all', taskQ: '', toggled: new Set() };
    let data = null, built = null;
    const $ = s => page.querySelector(s);
    const relations = createRelations(page, ctx);
    // Live updates arrive often: never rebuild the field someone is typing in or a dropdown they have open.
    const typing = () => page.contains(document.activeElement) && document.activeElement.matches('input, textarea');
    const choosing = () => page.contains(document.activeElement) && document.activeElement.matches('select');

    function show(v) { ui.view = v; built = null; render(); }
    function update(d) { data = d; render(); }
    function showHistory() { ui.missionFilter = 'history'; ui.client = 'all'; ui.taskHost = 'all'; built = null; render(); }
    function render() {
        if (!data || ui.view === 'overview') return;
        if (built !== ui.view) { page.innerHTML = ui.view === 'machines' ? machinesFrame() : ui.view === 'policy' ? policyFrame() : ui.view === 'relations' ? relations.frame() : tasksFrame(); built = ui.view; policySig = null; if (ui.view === 'relations') relations.bind(); else bindFrame(); }
        if (ui.view === 'machines') { renderHosts(); renderSessions(); } else if (ui.view === 'policy') renderPolicy(); else if (ui.view === 'relations') relations.render(data); else { renderTaskChips(); renderMissions(); }
        markSelected();
    }
    function markSelected() {
        const sel = ctx.selected();
        page.querySelectorAll('[data-pick]').forEach(el => el.classList.toggle('is-selected', !!sel && el.dataset.pick === `${sel.kind}:${sel.id}`));
    }
    const hostLabel = id => data.hosts.hosts.find(h => h.id === id)?.label ?? id;
    const locals = () => (data.tree?.groups ?? []).flatMap(g => g.members ?? []);
    const online = id => data.hosts.daemons.filter(d => d.hostId === id).some(d => d.connection === 'online');
    const chip = (key, label, n, on) => `<button type="button" class="pg-chip${on ? ' is-on' : ''}" data-chip="${key}">${esc(label)}${n === null ? '' : `<span>${n}</span>`}</button>`;

    // ---------- 機器: machine → sessions ----------
    function machinesFrame() {
        return `<section class="pg-panel pg-machines" aria-label="機器與 session">
          <header class="pg-head"><h2>機器</h2><span id="pg-host-count"></span>${ctx.isAdmin() ? '<button type="button" class="park-btn ghost" id="pg-resources" title="共用資源：誰拿著、誰在排隊">資源</button>' : ''}${ctx.isAdmin() ? '<button type="button" class="park-btn ghost" id="pg-peers" title="本機 session 之間的請求和通知；超過上限的會停下來等你放行">訊息</button>' : ''}${ctx.isAdmin() ? '<button type="button" class="park-btn ghost" id="pg-check-logins" title="問每台機器的 Paseo：Claude 和 Codex 有沒有登入、什麼時候到期">檢查登入</button>' : ''}<input id="pg-session-q" type="search" placeholder="搜尋 session、目錄、模型" value="${esc(ui.sessionQ)}"></header>
          <div id="pg-host-list" class="pg-hosts"></div>
          <p class="pg-group pg-session-title" id="pg-session-title"></p><div id="pg-session-chips" class="pg-chips"></div>
          <div id="pg-session-list" class="pg-scroll"></div></section>`;
    }
    function renderHosts() {
        if (typing()) return;
        const hosts = data.hosts.hosts;
        $('#pg-host-count').textContent = `${hosts.length} 台`;
        const pb = $('#pg-peers'), held = data.peers?.held ?? 0;
        if (pb) { pb.textContent = held ? `訊息 · ${held} 等你放行` : '訊息'; pb.classList.toggle('is-alert', held > 0); }
        const rb = $('#pg-resources'), rs = data.resources?.resources ?? [], waiting = rs.reduce((n, r) => n + r.waiting.length, 0);
        if (rb) { rb.textContent = waiting ? `資源 · ${waiting} 排隊` : `資源${rs.length ? ` ${rs.length}` : ''}`; rb.classList.toggle('is-alert', waiting > 0); }
        const card = h => {
            const ss = data.sessions.filter(s => s.hostId === h.id), st = ss.map(sessionState);
            const run = st.filter(x => x.cls === 'run').length, warn = st.filter(x => x.cls === 'warn' || x.cls === 'err').length, up = online(h.id);
            return `<div class="h-card" data-pick="host:${esc(h.id)}" data-host="${esc(h.id)}" tabindex="0" role="button" title="${esc(h.description ?? '')}">
              <div class="h-line"><i style="--c:${up ? '#3a9a5b' : '#9aa0a6'}"></i><b>${esc(h.label)}</b>${ctx.canEdit() ? `<button type="button" class="roster-rename always" title="改名" aria-label="改名 ${esc(h.label)}" data-rename="${esc(h.id)}">${PEN}</button>` : ''}</div>
              <p class="h-stats"><span>${up ? `${ss.length} 個 session` : '離線'}</span>${h.localSessions?.open ? `<span>${h.localSessions.open} 個本機${h.localSessions.live < h.localSessions.open ? `（${h.localSessions.live} 在線）` : ''}</span>` : ''}${run ? `<span class="state-run">${run} 運行中</span>` : ''}${warn ? `<span class="state-warn">${warn} 需留意</span>` : ''}${loginAlerts(h.logins).map(([text, cls]) => `<span class="h-login state-${cls}">${esc(text)}</span>`).join('')}</p></div>`;
        };
        $('#pg-host-list').innerHTML = `<div class="h-card h-all" data-host="all" tabindex="0" role="button"><div class="h-line"><b>全部機器</b></div><p class="h-stats"><span>${data.sessions.length} 個 session</span></p></div>${hosts.map(card).join('')}`;
        $('#pg-host-list').querySelectorAll('[data-host]').forEach(el => {
            el.classList.toggle('is-current', ui.host === el.dataset.host);
            el.onclick = (e) => { if (e.target.closest('[data-rename]')) return; ui.host = el.dataset.host; if (ui.host !== 'all') ctx.select({ kind: 'host', id: ui.host }); render(); };
            el.onkeydown = (e) => { if (e.key === 'Enter') el.click(); };
        });
        $('#pg-host-list').querySelectorAll('[data-rename]').forEach(b => b.onclick = (e) => {
            e.stopPropagation(); const h = hosts.find(x => x.id === b.dataset.rename);
            ctx.renameInPlace(b.closest('.h-line'), { kind: 'host', id: h.id, name: h.label, original: h.configLabel }, () => render());
        });
    }
    function sessionMatches(s) {
        const st = sessionState(s), q = ui.sessionQ.trim().toLowerCase();
        const byState = ui.sessionFilter === 'all' || (ui.sessionFilter === 'run' && st.cls === 'run') || (ui.sessionFilter === 'warn' && ['warn', 'err', 'off'].includes(st.cls)) || (ui.sessionFilter === 'idle' && ['idle', 'queue'].includes(st.cls));
        return byState && (!q || `${nameOf(s)} ${s.title} ${s.cwd} ${s.provider} ${s.worker?.alias ?? ''}`.toLowerCase().includes(q));
    }
    function renderSessions() {
        const inHost = data.sessions.filter(s => ui.host === 'all' || s.hostId === ui.host), st = inHost.map(sessionState);
        $('#pg-session-title').textContent = ui.host === 'all' ? '全部 session' : `${hostLabel(ui.host)} 的 session`;
        $('#pg-session-chips').innerHTML = chip('all', '全部', inHost.length, ui.sessionFilter === 'all') + chip('run', '運行中', st.filter(x => x.cls === 'run').length, ui.sessionFilter === 'run')
            + chip('warn', '需留意', st.filter(x => ['warn', 'err', 'off'].includes(x.cls)).length, ui.sessionFilter === 'warn') + chip('idle', '待命', st.filter(x => ['idle', 'queue'].includes(x.cls)).length, ui.sessionFilter === 'idle');
        $('#pg-session-chips').querySelectorAll('[data-chip]').forEach(b => b.onclick = () => { ui.sessionFilter = b.dataset.chip; render(); });
        if (typing() && document.activeElement.id !== 'pg-session-q') return;
        const q = ui.sessionQ.trim().toLowerCase(), localsOf = id => ['all', 'run'].includes(ui.sessionFilter) ? locals().filter(m => m.hostId === id && (ui.sessionFilter === 'all' || m.live) && (!q || `${m.name} ${m.cwd ?? ''} ${m.repo ?? ''} ${m.branch ?? ''} ${m.provider} ${m.status ?? ''}`.toLowerCase().includes(q))) : [];
        const groups = (ui.host === 'all' ? data.hosts.hosts.map(h => h.id) : [ui.host]).map(id => [id, inHost.filter(s => s.hostId === id && sessionMatches(s)), localsOf(id)]).filter(([, ss, ls]) => ss.length || ls.length);
        const row = s => {
            const st = sessionState(s), last = data.tasks.filter(t => t.target === s.id).at(-1), model = String(s.provider ?? '').split('/')[1];
            return `<button type="button" class="s-item" data-pick="session:${esc(s.id)}" data-session="${esc(s.id)}">
              <i class="mark" style="--c:${provider(s).roof}" title="${esc(provider(s).name)}"></i>
              <span class="s-main"><b>${esc(nameOf(s))}</b><span class="s-sub">${s.seat?.role === 'service' ? `服務座位 ${esc(s.seat.service)} · ` : ''}${esc(s.cwd ?? '')}${model ? ` · ${esc(model)}` : ''}</span>
                ${last ? `<span class="s-last"><i style="--c:${clientColor(last.originKind)}"></i>${esc(clientName(last.originKind))}：${esc(taskTitle(last).slice(0, 60))} · ${esc(STATE_NAMES[last.state] ?? last.state)} · ${esc(relTime(last.updatedAt))}</span>` : ''}</span>
              ${s.providerLimit ? `<span class="s-state state-warn" title="${esc(s.providerLimit.notice)}">${s.providerLimit.kind === 'login' ? '登入失效' : '額度用完'}</span>` : st.cls === 'idle' ? '<span class="s-state muted">待命</span>' : `<span class="s-state state-${st.cls}">${esc(st.text)}</span>`}</button>`;
        };
        const localRow = m => `<button type="button" class="s-item" data-pick="local:${esc(m.memberId)}" data-local="${esc(m.memberId)}">
              <i class="mark" style="--c:${provider({ provider: m.provider }).roof}" title="本機 ${esc(m.provider)}"></i>
              <span class="s-main"><b>${esc(m.name)}</b><span class="s-sub">本機 · ${esc(m.branch ? `${m.repo ?? ''}@${m.branch}` : m.cwd ?? '')}</span>${m.status ? `<span class="s-last">「${esc(m.status.slice(0, 60))}」 · ${esc(relTime(m.statusAt))}</span>` : ''}</span>
              <span class="s-state ${m.live ? 'state-run' : 'muted'}">${m.live ? '在線' : '沒回應'}</span></button>`;
        $('#pg-session-list').innerHTML = groups.length ? groups.map(([id, ss, ls]) => `${ui.host === 'all' ? `<p class="pg-group"><i style="--c:${online(id) ? '#3a9a5b' : '#9aa0a6'}"></i>${esc(hostLabel(id))}<span>${ss.length + ls.length}</span></p>` : ''}${ss.map(row).join('')}${ls.length && ss.length ? '<p class="pg-sub-group">本機 session</p>' : ''}${ls.map(localRow).join('')}`).join('')
            : `<p class="pg-empty">${inHost.length ? '沒有符合篩選的 session。' : '這台還沒有 session。用 Muse 或在這台的 Paseo 裡建立 agent 後會出現在這裡。'}</p>`;
        $('#pg-session-list').querySelectorAll('[data-session]').forEach(b => b.onclick = () => { ctx.select({ kind: 'session', id: b.dataset.session }); markSelected(); });
        $('#pg-session-list').querySelectorAll('[data-local]').forEach(b => b.onclick = () => { ctx.select({ kind: 'local', id: b.dataset.local }); markSelected(); });
    }

    // ---------- 任務: missions and their steps ----------
    function tasksFrame() {
        return `<section class="pg-panel pg-tasks" aria-label="任務">
          <header class="pg-head"><h2>任務</h2>${ctx.isAdmin() ? '<span></span><button type="button" class="park-btn ghost" id="pg-transfers" title="經 Router 送的檔案（不顯示口令）">檔案</button>' : ''}<input id="pg-task-q" type="search" placeholder="搜尋任務、指令、結果、session" value="${esc(ui.taskQ)}"></header>
          ${ctx.can('goal') ? `<form id="pg-goal" class="pg-goal"><textarea name="text" rows="2" required placeholder="交給規劃者一個目標，用你自己的話…"></textarea><div class="pg-goal-row"><input name="title" maxlength="120" placeholder="簡短名稱（可選）"><button type="submit" class="park-btn primary">交給規劃者</button></div><p class="pg-goal-note" id="pg-goal-note"></p></form>` : ''}
          <div class="pg-selects"><select id="pg-task-client" aria-label="入口"></select><select id="pg-task-host" aria-label="機器"></select></div>
          <div id="pg-task-chips" class="pg-chips"></div><div id="pg-task-tree" class="pg-scroll"></div></section>`;
    }
    const recent = m => Date.now() - m.updatedAt < DAY;
    const FILTERS = [['all', '全部', () => true], ['need', '需要你', m => m.state === 'need' || m.state === 'fail'], ['run', '進行中', m => m.state === 'run'], ['queue', '排隊', m => m.state === 'queue' || m.state === 'plan'],
        ['done', '24 小時內完成', m => ['done', 'cancel'].includes(m.state) && recent(m)], ['history', '歷史', m => ['done', 'cancel'].includes(m.state) && !recent(m)]];
    function missionMatches(m) {
        const q = ui.taskQ.trim().toLowerCase();
        const text = () => `${m.name} ${m.key} ${m.steps.map(t => { const s = data.sessions.find(x => x.id === t.target); return `${t.prompt} ${t.resultSummary ?? ''} ${s ? nameOf(s) : ''} ${t.id}`; }).join(' ')}`.toLowerCase();
        return FILTERS.find(f => f[0] === ui.missionFilter)[2](m) && (ui.client === 'all' || m.steps.some(t => t.originKind === ui.client)) && (ui.taskHost === 'all' || m.hosts.includes(ui.taskHost)) && (!q || text().includes(q));
    }
    function renderTaskChips() {
        const ms = missions(), chips = $('#pg-task-chips'), fb = $('#pg-transfers'), fs = data.transfers?.transfers ?? [], waitingFiles = fs.filter(t => t.state === 'pending').length;
        if (fb) { fb.textContent = waitingFiles ? `檔案 · ${waitingFiles} 等人收` : `檔案${fs.length ? ` ${fs.length}` : ''}`; fb.classList.toggle('is-alert', waitingFiles > 0); }
        chips.innerHTML = FILTERS.map(([k, label, f]) => chip(k, label, ms.filter(f).length, ui.missionFilter === k)).join('');
        chips.querySelectorAll('[data-chip]').forEach(b => b.onclick = () => { ui.missionFilter = b.dataset.chip; render(); });
        if (typing() || choosing()) return;
        const clients = [...new Set(data.tasks.map(t => t.originKind))];
        $('#pg-task-client').innerHTML = `<option value="all">全部入口</option>${clients.map(k => `<option value="${esc(k)}"${ui.client === k ? ' selected' : ''}>${esc(clientName(k))}</option>`).join('')}`;
        $('#pg-task-host').innerHTML = `<option value="all">全部機器</option>${data.hosts.hosts.map(h => `<option value="${esc(h.id)}"${ui.taskHost === h.id ? ' selected' : ''}>${esc(h.label)}</option>`).join('')}`;
    }
    function renderMissions() {
        if (typing() && document.activeElement.id !== 'pg-task-q') return;
        const shown = missions().filter(missionMatches);
        // A task on its own is shown as a single row; a mission with several steps opens into its step tree.
        const step = (t, depth, kids) => {
            const s = data.sessions.find(x => x.id === t.target), children = kids.get(t.id) ?? [], kind = t.routerTurn === 'service' ? '服務' : t.retryOf ? '重試' : t.dependencyId ? '交接' : t.replyToTaskId ? '回覆' : '';
            return `<div class="t-node" style="--depth:${depth}"><button type="button" class="t-row" data-pick="task:${esc(t.id)}" data-task="${esc(t.id)}"><span class="t-toggle"></span><i class="t-dot state-${taskCls(t.state)}"></i>
                <span class="t-main"><b>${kind ? `<em class="t-kind">${kind}</em>` : ''}${esc(taskTitle(t))}</b><span class="t-sub"><i style="--c:${clientColor(t.originKind)}"></i>${esc(clientName(t.originKind))} → ${esc(s ? nameOf(s) : t.target)} · ${esc(hostLabel(t.hostId))}</span></span>
                <span class="t-state state-${taskCls(t.state)}">${esc(STATE_NAMES[t.state] ?? t.state)}</span><span class="t-time">${esc(relTime(t.updatedAt))}</span></button>
              ${children.map(c => step(c, depth + 1, kids)).join('')}</div>`;
        };
        // A named part (子任務) is a row of its own with its chains under it; chains without a part follow the parts.
        const part = (b, kids) => {
            const st = partState(b), cls = taskCls(st), done = b.steps.filter(t => t.state === 'completed').length;
            return `<div class="t-node t-part" style="--depth:1"><div class="t-row"><span class="t-toggle"></span><i class="t-dot state-${cls}"></i>
                <span class="t-main"><b><em class="t-kind">子任務</em>${esc(b.part)}</b><span class="t-sub">${b.steps.length} 步 · ${new Set(b.steps.map(t => t.hostId)).size} 台機器</span></span>
                <span class="t-state state-${cls}">${esc(STATE_NAMES[st] ?? st)}<small>${done}/${b.steps.length}</small></span><span class="t-time">${esc(relTime(Math.max(...b.steps.map(t => t.updatedAt))))}</span></div>
              ${b.roots.map(t => step(t, 2, kids)).join('')}</div>`;
        };
        const mission = m => {
            const kids = m.kids, loose = m.branches.filter(b => !b.part).flatMap(b => b.roots);
            if (m.total === 1 && !m.goal) return step(m.steps[0], 0, kids); // a goal always keeps its own row: it is what the user asked for
            const open = (!['done', 'cancel'].includes(m.state)) !== ui.toggled.has(m.key), cls = MISSION_STATE[m.state][1];
            return `<div class="t-node t-mission" style="--depth:0"><button type="button" class="t-row" data-pick="mission:${esc(m.key)}" data-mission="${esc(m.key)}">
                <span class="t-toggle" data-toggle="${esc(m.key)}" role="button" aria-label="${open ? '收起' : '展開'}步驟">${open ? '▾' : '▸'}</span><i class="t-dot state-${cls}"></i>
                <span class="t-main"><b>${esc(m.name)}</b><span class="t-sub"><i style="--c:${clientColor(m.origin)}"></i>${esc(clientName(m.origin))} 發起 · ${m.parts.length ? `${m.parts.length} 個子任務 · ` : ''}${m.total} 步 · ${m.hosts.length} 台機器</span></span>
                <span class="t-state state-${cls}">${esc(missionWord(m))}<small>${m.done}/${m.total}</small></span><span class="t-time">${esc(relTime(m.updatedAt))}</span></button>
              ${open ? m.parts.map(b => part(b, kids)).join('') + loose.map(t => step(t, 1, kids)).join('') : ''}</div>`;
        };
        const empty = ui.missionFilter === 'history' ? '溫室裡還沒有東西。完成超過 24 小時的任務會移到這裡。' : missions().length ? '沒有符合篩選的任務。' : '還沒有任務。Muse、Grokbot 或在機器視角裡給 session 派任務後，會出現在這裡。';
        $('#pg-task-tree').innerHTML = shown.length ? shown.map(mission).join('') : `<p class="pg-empty">${empty}</p>`;
        $('#pg-task-tree').querySelectorAll('[data-task], [data-mission]').forEach(b => b.onclick = (e) => {
            const tg = e.target.closest('[data-toggle]');
            if (tg) { ui.toggled.has(tg.dataset.toggle) ? ui.toggled.delete(tg.dataset.toggle) : ui.toggled.add(tg.dataset.toggle); return render(); }
            ctx.select(b.dataset.mission ? { kind: 'mission', id: b.dataset.mission } : { kind: 'task', id: b.dataset.task }); markSelected();
        });
    }

    // ---------- 權限: who answers which level, the rules behind the levels, front-end ceilings, the planner ----------
    let policySig = null;
    function policyFrame() {
        return `<section class="pg-panel pg-policy" aria-label="權限"><header class="pg-head"><h2>權限</h2><span id="pg-policy-by"></span></header><div id="pg-policy" class="pg-scroll"></div></section>`;
    }
    const lv = (id, text) => `<span class="lv lv-${esc(id)}">${esc(id)}${text ? ` ${esc(text)}` : ''}</span>`;
    function renderPolicy() {
        const pol = data.policy, box = $('#pg-policy');
        if (!pol) { box.innerHTML = '<p class="pg-empty">讀不到權限設定。</p>'; return; }
        if (box.contains(document.activeElement) && document.activeElement.matches('input:not([type=checkbox]), textarea, select')) return; // an edit in progress
        if (box.querySelector('form[data-dirty]')) return; // a service being written keeps its unsaved boxes and ticks
        const templates = pol.planner.templates ?? [], sig = JSON.stringify([pol, ctx.isAdmin(), (data.asks ?? []).filter(a => a.state === 'running').map(a => a.id)]);
        if (sig === policySig) return; policySig = sig;
        const admin = ctx.isAdmin(), pl = pol.planner, dis = admin ? '' : ' disabled';
        $('#pg-policy-by').textContent = pol.updatedAt ? `${clientName(pol.by)} · ${relTime(pol.updatedAt)}` : '預設';
        const plannerState = !pl.session ? '還沒建立' : !pl.session.present ? 'session 不在了' : !pl.enabled ? '已停用' : pl.session.busy ? '思考中' : '待命';
        const planner = `<section class="pol-card"><h3>規劃者 <span class="pol-state ${pl.enabled && pl.session?.present ? 'state-run' : 'muted'}">${esc(plannerState)}</span></h3>
            ${pl.session ? `<p class="pol-line">${esc(pl.session.name)} · ${esc(ctx.hostLabel(pl.session.hostId))}</p><p class="pol-line muted">待處理事件 ${pl.pendingEvents} · 最近一小時喚醒 ${pl.turnsLastHour}/${pl.maxTurnsPerHour} 次${pl.lastFeedAt ? ` · 上次 ${esc(relTime(pl.lastFeedAt))}` : ''}</p>${pl.outdated ? `<p class="pol-line state-warn">這個規劃者是用舊版指令建的（第 ${Number(pl.toolsetVersion)} 版，現在是第 ${Number(pl.currentToolset)} 版）；按下面的「重建」換成新版。</p>` : ''}`
                : '<p class="pol-line muted">選一個 Claude 模板建立。它只拿到 Router 的工具，沒有 shell、檔案和網頁；Router 有事件時才喚醒它。</p>'}
            ${admin && pl.session ? `<form class="pol-form" data-form="planner"><label>喚醒間隔<select name="batchMs">${[[30000, '30 秒'], [60000, '1 分鐘'], [120000, '2 分鐘'], [300000, '5 分鐘']].map(([v, l]) => `<option value="${v}"${pl.batchMs === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
                <label>每小時最多<input type="number" name="max" min="1" max="120" value="${pl.maxTurnsPerHour}"></label><label class="check"><input type="checkbox" name="enabled"${pl.enabled ? ' checked' : ''}> 啟用</label><button type="submit" class="park-btn">儲存</button></form>` : ''}
            ${admin ? (templates.length ? `<form class="pol-form" data-form="setup"><label>${pl.session ? '換成新的規劃者' : '用這個模板建立'}<select name="template">${templates.map(t => `<option value="${esc(t.id)}"${t.id === pl.templateId ? ' selected' : ''}>${esc(t.title)} · ${esc(t.provider)}</option>`).join('')}</select></label><button type="submit" class="park-btn${pl.session ? '' : ' primary'}">${pl.session ? '重建' : '建立規劃者'}</button></form>` : '<p class="pol-line muted">設定檔裡還沒有能跑規劃者的 Claude 模板（seat 模板不算）。規劃者經本機網址連回 Router，所以模板要放在 Router 這台機器上。</p>') : ''}</section>`;
        const vf = pol.verification;
        const verify = vf ? `<section class="pol-card"><h3>獨立驗收</h3><p class="pol-line muted">任務帶 verify 時，做完後由同一台機器上的另一個驗收 session 照標準檢查，結果寫進任務的驗收欄；它只能讀那個任務自己目錄裡的東西、跑設定好的命令（只認寫出來的路徑；機器用戶自己 ~/.claude 裡預先放行的工具不經過 Router）。設定檔用 psr_set_policy，驗收 session 用 psr_create_session（role arbiter）建立。</p>
            ${vf.profiles.length ? vf.profiles.map(x => `<div class="rule-row"><b>${esc(x.id)}</b><span>${esc(x.note ?? '')}${x.commands?.length ? ` · 可執行：${esc(x.commands.join(' | '))}` : ''}${x.verifier ? ' · 先跑機械驗證器' : ''}</span></div>`).join('') : '<p class="pol-line muted">還沒有驗收設定檔。</p>'}
            <h4>驗收 session</h4>${vf.seats.length ? vf.seats.map(x => { const problem = x.revoked ? '已撤銷' : !x.present ? '不在了' : x.credentialExpired ? '憑證過期，重建一個' : !x.profileExists ? '設定檔已刪除' : ''; return `<p class="pol-line${problem ? ' muted' : ''}">${esc(x.name)}${x.hostId ? ` · ${esc(ctx.hostLabel(x.hostId))}` : ''} · ${esc(x.profileId ?? '')}${problem ? ` · ${problem}` : x.busy ? ' · 驗收中' : ''}</p>`; }).join('') : '<p class="pol-line muted">還沒有。</p>'}
            ${admin ? `<label class="check"><input type="checkbox" data-gate${vf.requireForGoalDone ? ' checked' : ''}> 還在驗收的目標不能結案</label>` : ''}</section>` : '';
        const ttl = pol.approvalTimeoutMs ?? 0, ttlChoices = [[1800000, '30 分鐘'], [3600000, '1 小時'], [7200000, '2 小時'], [21600000, '6 小時'], [86400000, '24 小時'], [0, '不自動取消']];
        const levels = `<section class="pol-card"><h3>誰能批准</h3><p class="pol-line muted">你（總控臺）永遠能批准任何等級；L4 只有你。前臺只能批自己派的任務。</p>
            <form class="pol-form" data-form="ttl"><label>等審批超過這麼久，自動取消那一輪<select name="ttl"${dis}>${ttlChoices.map(([v, l]) => `<option value="${v}"${ttl === v ? ' selected' : ''}>${l}</option>`).join('')}${ttlChoices.some(([v]) => v === ttl) ? '' : `<option value="${ttl}" selected>${Math.round(ttl / 60000)} 分鐘</option>`}</select></label></form>
            ${pol.levels.map(l => `<div class="lv-row">${lv(l.id)}<div class="lv-main"><b>${esc(l.name)}</b><small>${esc(l.description)}</small></div>
              ${l.locked ? '<span class="lv-only">只有你</span>' : `<div class="lv-who">${[['planner', '規劃者'], ['frontend', '前臺']].map(([k, n]) => `<label class="check"><input type="checkbox" data-approver="${k}" data-level="${esc(l.id)}"${l.approvers.includes(k) ? ' checked' : ''}${dis}> ${n}</label>`).join('')}</div>`}</div>`).join('')}</section>`;
        const rules = `<section class="pol-card"><h3>等級怎麼判</h3><p class="pol-line muted">按確切的命令或檔案路徑判斷：一串命令按最危險的一步算，認不出來的一律算 L4；你加的規則優先於內建規則，但憑證、金鑰永遠是 L4。</p>
            <form class="pol-form pol-test" data-form="test"><input name="cmd" placeholder="試一條命令，例如 nvm install 22 或 cat .env"><button type="submit" class="park-btn">判斷</button></form><p id="pg-test-out" class="pol-line"></p>
            <h4>你加的規則</h4>${pol.rules.length ? pol.rules.map(r => `<div class="rule-row">${lv(r.level)}<code>${esc(r.pattern)}</code><span>${esc(r.note ?? '')}</span>${admin ? `<button type="button" class="park-btn ghost" data-rule-del="${esc(r.id)}" title="刪除">✕</button>` : ''}</div>`).join('') : '<p class="pol-line muted">還沒有。在權限請求上點「以後這條命令算…」也能直接加。</p>'}
            ${admin ? `<form class="pol-form" data-form="rule"><select name="level">${pol.levels.map(l => `<option value="${esc(l.id)}">${esc(l.id)} ${esc(l.name)}</option>`).join('')}</select><input name="pattern" required placeholder="正規表達式，例如 ^python3 /home/ubuntu/strategy/"><input name="note" maxlength="120" placeholder="說明（可選）"><button type="submit" class="park-btn">加規則</button></form>` : ''}
            <details class="task-more"><summary>內建規則（${pol.builtinRules.length} 條）</summary>${pol.builtinRules.map(r => `<div class="rule-row${r.enabled ? '' : ' is-off'}">${lv(r.level)}<span>${esc(r.note ?? r.id)}</span><code title="${esc(r.pattern)}">${esc(r.id)}</code>${admin ? `<label class="check"><input type="checkbox" data-builtin="${esc(r.id)}"${r.enabled ? ' checked' : ''}> 啟用</label>` : ''}</div>`).join('')}</details></section>`;
        const fronts = `<section class="pol-card"><h3>前臺權限</h3><p class="pol-line muted">你設上限；規劃者只能在上限內收緊或恢復，不能放寬。建議的上限是：下目標、批准方案、看進度。</p>
            ${pol.frontends.map(c => { const ceiling = c.ceiling ?? c.configScopes.filter(x => pol.scopeChoices.includes(x)); return `<form class="pol-front" data-form="ceiling" data-client="${esc(c.clientId)}"><p class="pol-front-head"><i style="--c:${clientColor(c.entryKind)}"></i><b>${esc(clientName(c.clientId))}</b><span class="muted">${c.ceiling ? '' : '用設定檔'}${c.grant ? ` · 規劃者目前開放：${esc(c.grant.map(x => SCOPE_NAMES[x] ?? x).join('、') || '無')}` : ''}</span></p>
              <div class="pol-scopes">${pol.scopeChoices.map(x => `<label class="check${TARGET_SCOPES.includes(x) ? ' is-target' : ''}"><input type="checkbox" name="scope" value="${esc(x)}"${ceiling.includes(x) ? ' checked' : ''}${dis}> ${esc(SCOPE_NAMES[x] ?? x)}</label>`).join('')}</div>
              ${admin ? `<div class="task-actions"><button type="submit" class="park-btn">儲存上限</button><button type="button" class="park-btn ghost" data-preset="${esc(c.clientId)}">設成建議上限</button>${c.ceiling ? `<button type="button" class="park-btn ghost" data-reset="${esc(c.clientId)}">改回設定檔</button>` : ''}</div>` : ''}</form>`; }).join('')}</section>`;
        box.innerHTML = planner + verify + servicesCard(pol, admin) + levels + rules + fronts;
        const save = async (args, done) => { try { await ctx.act('psr_set_policy', args); ctx.toast(done); } catch (err) { ctx.toast(err.message, true); policySig = null; render(); } };
        bindServices(box, pol);
        const ttlForm = box.querySelector('form[data-form="ttl"]'); if (ttlForm) ttlForm.ttl.onchange = () => { ttlForm.ttl.blur(); save({ approvalTimeoutMs: Number(ttlForm.ttl.value) }, Number(ttlForm.ttl.value) ? '審批逾時已更新' : '已關閉審批逾時'); };
        const gate = box.querySelector('[data-gate]'); if (gate) gate.onchange = () => save({ verification: { requireForGoalDone: gate.checked } }, gate.checked ? '還在驗收的目標不能結案' : '已關閉驗收關卡');
        box.querySelectorAll('[data-approver]').forEach(c => c.onchange = () => { const l = c.dataset.level, who = [...box.querySelectorAll(`[data-approver][data-level="${l}"]`)].filter(x => x.checked).map(x => x.dataset.approver); save({ approvers: { [l]: who } }, `${l} 的批准人已更新`); });
        box.querySelectorAll('[data-builtin]').forEach(c => c.onchange = () => save({ disabled: [...box.querySelectorAll('[data-builtin]')].filter(x => !x.checked).map(x => x.dataset.builtin) }, '內建規則已更新'));
        box.querySelectorAll('[data-rule-del]').forEach(b => b.onclick = () => save({ rules: pol.rules.filter(r => r.id !== b.dataset.ruleDel) }, '規則已刪除'));
        box.querySelectorAll('[data-preset]').forEach(b => b.onclick = () => save({ ceilings: { [b.dataset.preset]: TARGET_SCOPES } }, `${clientName(b.dataset.preset)} 已設成建議上限`));
        box.querySelectorAll('[data-reset]').forEach(b => b.onclick = () => save({ ceilings: { [b.dataset.reset]: null } }, `${clientName(b.dataset.reset)} 改回設定檔`));
        box.querySelectorAll('form[data-form]').forEach(f => f.onsubmit = async (e) => {
            e.preventDefault(); const kind = f.dataset.form;
            if (kind === 'test') { const out = $('#pg-test-out'); try { const r = await ctx.read('psr_classify_permission', { tool: 'Bash', detail: f.cmd.value.trim() || ' ' }); out.innerHTML = `${lv(r.level, r.levelName)} ${esc(r.ruleId ? `規則 ${r.ruleId}` : '認不出來，按最高級處理')} · 可批：你${r.approvers.includes('planner') ? '、規劃者' : ''}${r.approvers.includes('frontend') ? '、前臺' : ''}`; } catch (err) { out.textContent = err.message; } return; }
            if (kind === 'rule') { const rule = { id: `r${Date.now().toString(36)}`, level: f.level.value, pattern: f.pattern.value.trim(), ...(f.note.value.trim() ? { note: f.note.value.trim() } : {}) }; f.querySelector('[type=submit]').blur(); return save({ rules: [...pol.rules, rule] }, '規則已加入'); }
            if (kind === 'ceiling') return save({ ceilings: { [f.dataset.client]: [...f.querySelectorAll('input[name=scope]:checked')].map(x => x.value) } }, `${clientName(f.dataset.client)} 的上限已儲存`);
            if (kind === 'service') return saveService(f, pol);
            if (kind === 'delivery') return saveA2A({ deliveryMax: Number(f.elements.namedItem('deliveryMax').value) }, '待送回覆的上限已更新', f);
            if (kind === 'planner') return save({ planner: { enabled: f.enabled.checked, batchMs: Number(f.batchMs.value), maxTurnsPerHour: Number(f.max.value) } }, '規劃者設定已儲存');
            if (kind === 'setup') { if (pl.session && !confirm('建立新的規劃者後，舊的規劃者 session 不再能用 Router 的工具。繼續？')) return; const btn = f.querySelector('[type=submit]'); btn.disabled = true;
                try { await ctx.act('psr_setup_planner', { templateId: f.template.value, idempotencyKey: crypto.randomUUID() }); ctx.toast('規劃者已建立並啟用'); } catch (err) { ctx.toast(err.message, true); } finally { btn.disabled = false; policySig = null; render(); } }
        });
    }

    // ---------- 權限 › 服務呼叫: services agents may call with psr_ask, their seats, and answers waiting to be delivered ----------
    const AUTO_ALLOW = { none: '都等你批', L0: 'L0 讀檔、讀命令和指定的命令', L1: 'L1 再加上改它自己目錄裡的檔（它自己的 agent 和 git 設定除外）' };
    const polOpen = new Set(); // edit forms the owner opened stay open across live redraws
    const lines = v => String(v ?? '').split('\n').map(x => x.trim()).filter(Boolean);
    function serviceForm(x, all) {
        const n = x?.name ?? '', hosts = data.hosts.hosts, others = all.filter(y => y.name !== n), callers = x?.callers ?? [];
        const box = (name, value, label, on) => `<label class="check"><input type="checkbox" name="${name}" value="${esc(value)}"${on ? ' checked' : ''}> ${esc(label)}</label>`;
        return `<form class="svc-form" data-form="service" data-name="${esc(n)}">
            <label>名稱<input name="name" required maxlength="40" pattern="[a-z0-9][a-z0-9\\-]{0,39}" value="${esc(n)}" placeholder="例如 market-data（小寫字母、數字、-）"${n ? ' readonly' : ''}></label>
            <label>說明（呼叫方和座位都看得到）<textarea name="description" rows="2" maxlength="1000" placeholder="這個服務回答什麼、它的資料在哪">${esc(x?.description ?? '')}</textarea></label>
            <fieldset><legend>誰能叫它</legend>${box('callers', '*', '所有機器', callers.includes('*'))}${hosts.map(h => box('callers', h.id, h.label, callers.includes(h.id))).join('')}</fieldset>
            ${others.length ? `<fieldset><legend>它回答時可以再叫</legend>${others.map(y => box('mayCall', y.name, y.name, x?.mayCall?.includes(y.name))).join('')}</fieldset>` : ''}
            <label>Router 在它的輪裡自己批什麼<select name="autoAllow">${Object.entries(AUTO_ALLOW).map(([k, l]) => `<option value="${k}"${(x?.autoAllow ?? 'none') === k ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
            <label>另外可讀的目錄（每行一個絕對路徑）<textarea name="reads" rows="2" placeholder="/srv/datastore">${esc((x?.reads ?? []).join('\n'))}</textarea></label>
            <label>可跑的命令（每行一條，照寫的放行）<textarea name="commands" rows="2" placeholder="python3 /opt/tools/where.py --list">${esc((x?.commands ?? []).join('\n'))}</textarea></label>
            <div class="svc-nums"><label>排隊上限<input type="number" name="queueMax" min="1" max="20" required value="${x?.queueMax ?? 5}"></label><label>時限（分）<input type="number" name="ttlMin" min="5" max="1440" required value="${x?.ttlMin ?? 60}"></label><label>同步等（秒）<input type="number" name="waitSec" min="30" max="3600" required value="${x?.waitSec ?? 600}"></label></div>
            <label class="check"><input type="checkbox" name="enabled"${x?.enabled === false ? '' : ' checked'}> 營業中</label>
            <div class="task-actions"><button type="submit" class="park-btn primary">${n ? '儲存' : '新增服務'}</button></div></form>`;
    }
    function servicesCard(pol, admin) {
        const a2a = pol.a2a; if (!a2a || (!a2a.services.length && !admin)) return ''; // an older Router, or nothing to show yet
        const seats = a2a.seats ?? [], queues = a2a.queues ?? { services: [], callers: [] }, asks = data.asks ?? [], hostName = id => id ? ctx.hostLabel(id) : '—';
        const named = (ref, fallback) => { const s = data.sessions.find(x => x.id === ref); return s ? nameOf(s) : fallback ?? ref; }; // the name the rest of the console shows
        const usable = y => y.present && !y.revoked && !y.credentialExpired;
        const row = x => {
            const q = queues.services.find(y => y.service === x.name) ?? { queued: 0, running: 0, waitingApproval: 0 }, n = seats.filter(y => y.service === x.name && usable(y)).length;
            const callers = x.callers.includes('*') ? '所有機器' : x.callers.map(hostName).join('、') || '還沒有（誰都不能叫）';
            return `<div class="svc-row" data-service="${esc(x.name)}"><p class="svc-head"><i style="--c:${serviceColor(x.name)}"></i><b>${esc(x.name)}</b><span class="pol-state ${x.enabled ? 'state-run' : 'muted'}">${x.enabled ? '營業中' : '已停用'}</span>
                <span class="svc-q">座位 ${n} · 排隊 ${q.queued}/${x.queueMax}${q.running ? ` · 回答中 ${q.running}` : ''}${q.waitingApproval ? ` · <b class="state-warn">${q.waitingApproval} 等你批</b>` : ''}</span></p>
              ${x.description ? `<p class="pol-line">${esc(x.description)}</p>` : ''}
              <p class="pol-line muted">誰能叫：${esc(callers)}${x.mayCall.length ? ` · 可再叫 ${esc(x.mayCall.join('、'))}` : ''} · Router 自己批：${esc(AUTO_ALLOW[x.autoAllow] ?? x.autoAllow)} · 時限 ${x.ttlMin} 分 · 同步等 ${x.waitSec} 秒</p>
              ${x.reads.length || x.commands.length ? `<p class="pol-line muted svc-code">${x.reads.length ? `可讀 <code>${esc(x.reads.join('  '))}</code>` : ''}${x.reads.length && x.commands.length ? ' · ' : ''}${x.commands.length ? `可跑 <code>${esc(x.commands.join(' | '))}</code>` : ''}</p>` : ''}
              ${admin ? `<div class="svc-actions"><button type="button" class="park-btn ghost" data-svc-toggle="${esc(x.name)}">${x.enabled ? '停用' : '啟用'}</button>${q.queued ? `<button type="button" class="park-btn ghost" data-svc-clear="${esc(x.name)}">清空排隊 ${q.queued}</button>` : ''}<button type="button" class="park-btn ghost" data-svc-del="${esc(x.name)}">刪除</button></div>
                <details class="task-more" data-open-key="svc:${esc(x.name)}"><summary>編輯 ${esc(x.name)}</summary>${serviceForm(x, a2a.services)}</details>` : ''}</div>`;
        };
        const seat = y => {
            const problem = y.revoked ? '已撤銷' : !y.present ? '不在了' : y.credentialExpired ? '憑證過期，重建一個' : !y.serviceExists ? '服務已刪除' : '', a = y.currentAsk && asks.find(z => z.id === y.currentAsk);
            const now = problem ? esc(problem) : y.waitingApproval ? '<b class="state-warn">等你批</b>' : y.currentAsk ? `回答 <code>${esc(y.currentAsk)}</code>${a ? `（${esc(named(a.callerSession, a.callerName))} 問的）` : ''}` : y.busy ? '忙' : '空閒';
            return `<p class="pol-line${problem ? ' muted' : ''}"><button type="button" class="link" data-seat="${esc(y.sessionRef)}">${esc(named(y.sessionRef, y.name))}</button> · ${esc(hostName(y.hostId))} · ${esc(y.service ?? '')} · ${now}${y.queue ? ` · 排隊 ${y.queue}` : ''}</p>`;
        };
        const waiting = queues.callers.filter(c => c.undelivered || c.pending);
        return `<section class="pol-card svc-card" data-card="a2a"><h3>服務呼叫 <span class="pol-state muted">${a2a.services.length} 個服務</span></h3>
            <p class="pol-line muted">agent 用 psr_ask 叫另一台機器上的服務座位幫忙，像呼叫一個工具：等得到就在呼叫裡拿回覆，等不到回覆會在它下一輪開頭送到。誰能叫、Router 在服務輪裡自己批什麼、排隊上限和時限都在這裡設；其餘的請求等你批。</p>
            ${a2a.services.map(row).join('') || '<p class="pol-line muted">還沒有服務。</p>'}
            ${admin ? `<details class="task-more" data-open-key="svc:"><summary>新增服務</summary>${serviceForm(null, a2a.services)}</details>` : ''}
            <h4>座位 · ${seats.length}</h4>${seats.map(seat).join('') || '<p class="pol-line muted">還沒有座位。用 psr_create_session（role service）在座位模板上建立，每個座位模板放一個座位；要你人工審批的機器上不放座位。</p>'}
            ${waiting.length ? `<h4>等著送回的回覆</h4>${waiting.map(c => `<div class="svc-caller"><span><button type="button" class="link" data-seat="${esc(c.sessionRef)}">${esc(named(c.sessionRef, c.name))}</button> · ${esc(hostName(c.hostId))}${c.undelivered ? ` · 待送 ${c.undelivered}` : ''}${c.pending ? ` · 還在等 ${c.pending}` : ''}</span>${admin && c.undelivered ? `<button type="button" class="park-btn ghost" data-clear-caller="${esc(c.sessionRef)}">清掉待送的回覆</button>` : ''}</div>`).join('')}` : ''}
            ${admin ? `<form class="pol-form" data-form="delivery"><label>每個 session 最多留幾則待送的回覆<input type="number" name="deliveryMax" min="1" max="20" required value="${a2a.deliveryMax}"></label><button type="submit" class="park-btn">儲存</button></form>` : `<p class="pol-line muted">每個 session 最多留 ${a2a.deliveryMax} 則待送的回覆。</p>`}</section>`;
    }
    async function saveA2A(a2a, done, f = null) {
        const btn = f?.querySelector('[type=submit]'); if (btn) btn.disabled = true;
        try { await ctx.act('psr_set_policy', { a2a }); if (f) { delete f.dataset.dirty; polOpen.delete(f.closest('details')?.dataset.openKey); } ctx.toast(done); }
        catch (err) { ctx.toast(err.message, true); } // a refused form keeps what was typed
        finally { if (btn) btn.disabled = false; }
        policySig = null; render();
    }
    function saveService(f, pol) {
        const v = n => f.elements.namedItem(n), ticks = n => [...f.querySelectorAll(`input[name=${n}]:checked`)].map(x => x.value), orig = f.dataset.name, all = pol.a2a.services;
        const svc = { name: v('name').value.trim(), description: v('description').value.trim(), enabled: v('enabled').checked, callers: ticks('callers'), mayCall: ticks('mayCall'), autoAllow: v('autoAllow').value,
            reads: lines(v('reads').value), commands: lines(v('commands').value), queueMax: Number(v('queueMax').value), ttlMin: Number(v('ttlMin').value), waitSec: Number(v('waitSec').value) };
        if (!orig && all.some(x => x.name === svc.name)) return ctx.toast(`已經有叫 ${svc.name} 的服務`, true);
        return saveA2A({ services: orig ? all.map(x => x.name === orig ? svc : x) : [...all, svc] }, orig ? `${svc.name} 已儲存` : `已新增服務 ${svc.name}`, f);
    }
    function bindServices(box, pol) {
        const card = box.querySelector('[data-card="a2a"]'); if (!card) return;
        const all = pol.a2a.services, act = async (b, name, args, done) => { b.disabled = true; try { const r = await ctx.act(name, args); ctx.toast(done(r)); } catch (err) { ctx.toast(err.message, true); b.disabled = false; } };
        card.querySelectorAll('details[data-open-key]').forEach(dd => { dd.open = polOpen.has(dd.dataset.openKey); dd.ontoggle = () => { if (dd.open) polOpen.add(dd.dataset.openKey); else polOpen.delete(dd.dataset.openKey); }; });
        card.querySelectorAll('form[data-form="service"]').forEach(f => f.addEventListener('input', () => { f.dataset.dirty = '1'; }));
        card.querySelectorAll('[data-seat]').forEach(b => b.onclick = () => ctx.select({ kind: 'session', id: b.dataset.seat }));
        card.querySelectorAll('[data-svc-toggle]').forEach(b => b.onclick = () => { const n = b.dataset.svcToggle, on = all.find(x => x.name === n)?.enabled;
            if (on && !confirm(`停用 ${n}？排隊中的呼叫會失敗，正在回答的會答完。`)) return; saveA2A({ services: all.map(x => x.name === n ? { ...x, enabled: !on } : x) }, on ? `${n} 已停用` : `${n} 已啟用`); });
        card.querySelectorAll('[data-svc-del]').forEach(b => b.onclick = () => { const n = b.dataset.svcDel;
            if (!confirm(`刪除服務 ${n}？排隊中的呼叫會失敗，它的座位留著但不再接呼叫。`)) return; saveA2A({ services: all.filter(x => x.name !== n).map(x => ({ ...x, mayCall: x.mayCall.filter(m => m !== n) })) }, `已刪除服務 ${n}`); });
        card.querySelectorAll('[data-svc-clear]').forEach(b => b.onclick = () => { const n = b.dataset.svcClear;
            if (confirm(`取消 ${n} 排隊中、還沒有座位接的呼叫？呼叫方會收到「已取消」。`)) act(b, 'psr_clear_asks', { service: n }, r => `已取消 ${r.cleared} 個排隊中的呼叫`); });
        card.querySelectorAll('[data-clear-caller]').forEach(b => b.onclick = () => { if (confirm('丟掉這個 session 還沒送到的服務回覆？它不會再收到這些回覆。')) act(b, 'psr_clear_asks', { sessionRef: b.dataset.clearCaller }, r => `已清掉 ${r.cleared} 則待送的回覆`); });
    }

    function bindFrame() {
        const q = $('#pg-session-q'); if (q) q.oninput = () => { ui.sessionQ = q.value; renderSessions(); markSelected(); };
        const pb = $('#pg-peers'); if (pb) pb.onclick = () => ctx.select({ kind: 'peers', id: 'all' });
        const rb = $('#pg-resources'); if (rb) rb.onclick = () => ctx.select({ kind: 'resources', id: 'all' });
        const fb = $('#pg-transfers'); if (fb) fb.onclick = () => ctx.select({ kind: 'transfers', id: 'all' });
        const lc = $('#pg-check-logins');
        if (lc) lc.onclick = async () => { lc.disabled = true; lc.textContent = '檢查中…';
            try { const r = await ctx.act('psr_check_logins', {}); ctx.toast(`已問過 ${r.checked} 個在線的 Paseo；選一台機器看登入詳情`); }
            catch (err) { ctx.toast(err.message, true); } finally { lc.disabled = false; lc.textContent = '檢查登入'; } };
        const tq = $('#pg-task-q'); if (tq) tq.oninput = () => { ui.taskQ = tq.value; renderMissions(); markSelected(); };
        const c = $('#pg-task-client'); if (c) c.onchange = () => { ui.client = c.value; render(); };
        const h = $('#pg-task-host'); if (h) h.onchange = () => { ui.taskHost = h.value; render(); };
        const g = $('#pg-goal');
        if (g) {
            const pl = data.policy?.planner; $('#pg-goal-note').textContent = !pl?.session ? '規劃者還沒建立：到「權限」設置。目標會先記下，規劃者上線後處理。' : !pl.enabled ? '規劃者目前停用：目標會先記下。' : '';
            g.onsubmit = async (e) => { e.preventDefault(); const text = g.text.value.trim(); if (!text) return; const btn = g.querySelector('[type=submit]'); btn.disabled = true;
                try { const goal = await ctx.act('psr_submit_goal', { text, ...(g.title.value.trim() ? { title: g.title.value.trim() } : {}), idempotencyKey: crypto.randomUUID() }); g.reset(); ctx.toast('已交給規劃者'); ctx.select({ kind: 'mission', id: goal.id }); }
                catch (err) { ctx.toast(err.message, true); } finally { btn.disabled = false; } };
        }
    }
    return { show, update, markSelected, showHistory };
}
