// 總控臺 shell: sign-in, the shared data load, the live event stream and toasts. Every view (3D overview, machines,
// tasks) is drawn by park.js from the same snapshot, so there is one state and one set of actions.
const $ = s => document.querySelector(s);
let token = sessionStorage.getItem('psr-token') ?? '', identity = null, snapshot = null, sessions = [], tasks = [], hostInfo = null, messages = [], permissions = [], policy = null, goals = [], asks = [];
let park = null, parkLoading = null, stream = null, toastTimer;
// Templates change only with the Router's config (or a rename): read them at connect and at most once a minute after that.
let templates = null, templatesAt = 0;
// Local sessions and who created what (psr_get_tree) and the messages between local sessions (psr_peer_messages, owner only)
// change less often than tasks: read at connect, right after one of your actions, and otherwise at most every 10 s.
let tree = null, peers = null, resources = null, transfers = null, extrasAt = 0, extrasDue = true;
const isAdmin = () => !!identity?.scopes?.includes('admin');
function toast(message, error = false) { const t = $('#toast'); t.textContent = message; t.className = error ? 'error' : ''; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => t.hidden = true, 6500); }
async function request(path, args) { const res = await fetch(path, { method: args === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}`, ...(args === undefined ? {} : { 'content-type': 'application/json' }) }, ...(args === undefined ? {} : { body: JSON.stringify(args) }) }); const data = await res.json(); if (!res.ok)
    throw new Error(`${data.code}: ${data.message}`); return data; }
const tool = (name, args = {}) => request(`/v1/tools/${name}`, args);
const savedView = () => { try { return localStorage.getItem('psr-view') ?? 'overview'; } catch { return 'overview'; } };
let pendingView = null; // a view chosen while the 3D module is still loading is applied once it is ready
document.querySelectorAll('[data-view]').forEach(b => b.onclick = () => { pendingView = b.dataset.view; });
async function connect() { identity = await request('/v1/whoami'); sessionStorage.setItem('psr-token', token); $('#login').hidden = true; await showPark(); await load(true); }
async function showPark() {
    $('#park').hidden = false;
    if (!park) {
        // The 3D engine (~2 MB, cached for good after the first visit) loads only once someone signs in.
        parkLoading ??= import('/park.js');
        const { createPark } = await parkLoading.catch(e => { toast('總控臺載入失敗：' + e.message, true); throw e; });
        if (park) return;
        park = createPark($('#park'), {
            toast,
            read: (name, args) => tool(name, args),
            weather: () => request('/v1/weather'),
            act: async (name, args) => { const r = await tool(name, args); extrasDue = true; await load(); return r; },
            annotate: async (args) => { await tool('psr_annotate', args); await load(); },
            respondPermission: async (args) => { await tool('psr_respond_permission', args); await load(); },
            viewChanged: v => { try { localStorage.setItem('psr-view', v); } catch { /* per-viewer convenience only */ } },
        });
        park.setStreamState(...parkLive);
        park.setView(pendingView ?? savedView());
        document.querySelectorAll('[data-park]').forEach(b => b.onclick = () => { const a = b.dataset.park; if (a === 'roster') return $('#park').classList.toggle('show-roster'); if (a === 'tasks') return park.setView('tasks'); const r = park.action(a); if (a === 'labels' || a === 'pixel') b.setAttribute('aria-pressed', String(r)); });
    }
    const mode = $('#park-mode'); mode.textContent = identity?.mode === 'demo' ? '模擬環境' : ''; mode.title = identity?.mode === 'demo' ? '主機與結果都是測試數據，不執行任何模型或命令' : '';
    if (snapshot) park.update(parkData());
}
// The Router's own wake-up turns for the planner are not user work: they show under the Router, not in the task garden.
const parkData = () => ({ identity, hosts: hostInfo, sessions, tasks: tasks.filter(t => !t.system), plannerTurns: tasks.filter(t => t.system), messages, permissions, policy, goals, asks, templates, tree, peers, resources, transfers });
let parkLive = ['連線中', false]; // the park may finish loading after the stream connects
const setLive = (text, ok) => { parkLive = [text, ok]; park?.setStreamState(text, ok); };
$('#login-form').addEventListener('submit', async (e) => { e.preventDefault(); token = $('#token').value.trim(); $('#login-error').textContent = ''; try {
    await connect();
}
catch (err) {
    $('#login-error').textContent = err.message;
} });
$('#logout').onclick = () => { stream?.abort(); stream = null; sessionStorage.removeItem('psr-token'); token = ''; identity = null; $('#park').hidden = true; $('#login').hidden = false; $('#token').value = ''; };
// One refresh at a time. A caller that arrives while one is running gets the next refresh, started right after it, so an
// action that awaits load() always sees data fetched after the action itself.
let inflight = null, queued = null, queuedReconnect = false, lastLoad = 0, refreshTimer = null;
function load(reconnect = false) {
    if (inflight) { queuedReconnect ||= reconnect; return queued ??= inflight.then(() => { const r = queuedReconnect; queued = null; queuedReconnect = false; return load(r); }); }
    clearTimeout(refreshTimer); refreshTimer = null; lastLoad = Date.now(); // this load covers any change reported before it
    inflight = fetchAll(reconnect).finally(() => { inflight = null; });
    return inflight;
}
// The Router rewrites every session on each tick, so the stream reports changes about once a second; a load per report
// would be 9 tool calls a second against the entry's 600-a-minute limit (shared by every tab on this token). Reported
// changes wait until REFRESH_GAP_MS after the last load and fold into one refresh; actions still load at once.
const REFRESH_GAP_MS = 3000;
function refresh() { refreshTimer ??= setTimeout(() => { refreshTimer = null; if (token)
    void load(); }, Math.max(0, lastLoad + REFRESH_GAP_MS - Date.now())); }
async function fetchAll(reconnect) {
    try {
        const extras = reconnect || extrasDue || Date.now() - extrasAt > 10000; extrasDue = false;
        const [top, ss, tt, hh, mm, pp, po, gg, aa, tl, tr, pm, rs, tf] = await Promise.all([tool('psr_get_topology', {}), tool('psr_list_sessions', { limit: 200 }), tool('psr_list_tasks', {}), tool('psr_list_hosts'), tool('psr_wait_messages', { all: true, timeoutMs: 0 }).catch(() => ({ messages: [] })), tool('psr_list_permissions').catch(() => ({ permissions: [] })), tool('psr_get_policy').catch(() => null), tool('psr_list_goals', { limit: 200 }).catch(() => ({ goals: [] })), tool('psr_list_asks', { limit: 200 }).catch(() => ({ asks: [] })), reconnect || !templates || Date.now() - templatesAt > 60000 ? tool('psr_list_templates').catch(() => null) : null,
            extras ? tool('psr_get_tree', { of: 'sessions' }).catch(() => null) : null, extras && isAdmin() ? tool('psr_peer_messages', { state: 'all', limit: 200 }).catch(() => null) : null, extras && isAdmin() ? tool('psr_list_resources').catch(() => null) : null, extras && isAdmin() ? tool('psr_list_transfers').catch(() => null) : null]);
        snapshot = top; sessions = ss.sessions; tasks = tt.tasks; hostInfo = hh; messages = mm.messages; permissions = pp.permissions; policy = po; goals = gg.goals; asks = aa.asks ?? []; if (tl) { templates = tl; templatesAt = Date.now(); } if (extras) { if (tr) tree = tr; if (pm || !isAdmin()) peers = pm; if (rs || !isAdmin()) resources = rs; if (tf || !isAdmin()) transfers = tf; extrasAt = Date.now(); }
        park?.update(parkData());
        if (reconnect || !stream)
            startStream(top.streamCursor);
    }
    catch (e) {
        toast(e.message, true);
        setLive('連線異常', false);
    }
}
async function startStream(cursor) { stream?.abort(); const controller = new AbortController(); stream = controller; setLive('即時', true); try {
    const response = await fetch('/v1/events?' + new URLSearchParams({ after: cursor }), { headers: { authorization: `Bearer ${token}` }, signal: controller.signal });
    if (!response.ok)
        throw new Error('Event stream unavailable');
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let buffer = '';
    while (!controller.signal.aborted) {
        const { done, value } = await reader.read();
        if (done)
            break;
        buffer += decoder.decode(value, { stream: true });
        let end;
        while ((end = buffer.indexOf('\n\n')) !== -1) {
            const block = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            if (block.startsWith(':'))
                continue;
            const event = block.match(/^event: (.+)$/m)?.[1];
            const payload = block.match(/^data: (.+)$/m)?.[1];
            if (!payload)
                continue;
            const data = JSON.parse(payload);
            if (event === 'resync_required') {
                await load(true);
                return;
            }
            if (event === 'changes' && data.events.length)
                refresh();
        }
    }
    if (!controller.signal.aborted) {
        stream = null;
        setLive('重新連線中', false);
        setTimeout(() => { if (token)
            load(true); }, 1500);
    }
}
catch (e) {
    if (controller.signal.aborted)
        return;
    stream = null;
    setLive('重新連線中', false);
    setTimeout(() => { if (token)
        load(true); }, 2000);
} }
if (token)
    connect().catch(() => { sessionStorage.removeItem('psr-token'); $('#login').hidden = false; $('#park').hidden = true; });
