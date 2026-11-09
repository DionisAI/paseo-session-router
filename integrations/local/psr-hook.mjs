#!/usr/bin/env node
// psr-hook: the Codex hook that hands a thread the messages other sessions sent it (requests and replies, see the Router's
// psr_local_send), only between turns: when a turn ends (Stop: the thread goes on with them), when the user sends the next
// prompt (UserPromptSubmit) and when a thread starts or resumes (SessionStart). Never a tool-use hook, so never mid-turn.
// It asks the Router with this machine's credential for what is waiting for this thread (the thread its psr-local bridge
// reported). Anything wrong (not set up, Router unreachable, no messages) and it says nothing: a hook never stands in the
// thread's way. No dependencies; Node 18 or newer. Codex runs it as: node psr-hook.mjs <event>, the hook input on stdin.
import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';

const EVENTS = ['Stop', 'UserPromptSubmit', 'SessionStart'];
const THREAD = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const quiet = () => process.exit(0);

let input = {};
try { input = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { /* no usable input */ }
const event = EVENTS.includes(input.hook_event_name) ? input.hook_event_name : process.argv[2];
const threadId = [input.session_id, process.env.CODEX_THREAD_ID].find(t => typeof t === 'string' && THREAD.test(t));
if (!EVENTS.includes(event) || !threadId) quiet();

// the same rule as the bridge: an agent's own home folder and everything below it (but its worktrees) is no project, and
// its background threads never joined, so there is nothing to ask for
const real = p => { try { return realpathSync(p); } catch { return resolve(p); } };
const cwd = typeof input.cwd === 'string' && input.cwd.startsWith('/') ? real(input.cwd) : null;
const below = (home, path) => { const rest = path === home ? [] : path.startsWith(home + sep) ? path.slice(home.length + 1).split(sep) : null; return rest !== null && !(rest[0] === 'worktrees' && rest.length >= 2); };
if (cwd) {
    const parts = cwd.split(sep), i = parts.findIndex(x => x === '.codex' || x === '.claude');
    if ((i >= 0 && below(parts.slice(0, i + 1).join(sep), cwd)) || [process.env.CODEX_HOME, process.env.CLAUDE_CONFIG_DIR].some(h => h && below(real(h), cwd))) quiet();
}

let url, token;
try {
    const dir = process.env.PSR_LOCAL_DIR || join(homedir(), '.config', 'psr');
    url = new URL('/local/hook', JSON.parse(readFileSync(join(dir, 'local.json'), 'utf8')).url);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) quiet();
    token = readFileSync(join(dir, 'local.token'), 'utf8').trim();
    if (!token.startsWith('psrl_')) quiet();
} catch { quiet(); }

let text = null;
try {
    const r = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'user-agent': 'codex (psr-hook/1)' }, body: JSON.stringify({ threadId, event }), signal: AbortSignal.timeout(3000) });
    if (r.status === 200) { const d = await r.json(); if (typeof d?.text === 'string' && d.text) text = d.text; }
} catch { /* the Router is unreachable: the messages wait */ }
if (!text) quiet();
// Stop: the thread goes on with the messages (once: they are delivered now, so the next Stop finds none);
// the others: the messages travel with the user's prompt, or open the thread
process.stdout.write(JSON.stringify(event === 'Stop' ? { decision: 'block', reason: text } : { hookSpecificOutput: { hookEventName: event, additionalContext: text } }));
process.exit(0);
