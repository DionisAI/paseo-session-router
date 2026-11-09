import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
const usage = `psr — one client for the shared Router API

  npm run psr -- hosts
  npm run psr -- sessions [search]
  npm run psr -- resolve '{"workerAlias":"eth-mm","workstreamId":"maker-fill-validation"}'
  npm run psr -- submit SESSION_REF "Your instruction" --key UNIQUE_REQUEST_KEY
  npm run psr -- task TASK_ID
  npm run psr -- wait TASK_ID [TIMEOUT_MS]
  npm run psr -- reply TASK_ID "Follow-up instruction" --key UNIQUE_REQUEST_KEY
  npm run psr -- messages [AFTER_SEQ] [TIMEOUT_MS]
  npm run psr -- tasks
  npm run psr -- cancel TASK_ID
  npm run psr -- topology
  npm run psr -- call TOOL_NAME '{"argument":"value"}'

Environment: PSR_URL=http://127.0.0.1:8787 and PSR_TOKEN (required).
A file may supply JSON arguments as @path.json. No SSH command interpolation.
`;
export async function callTool(name: string, args: unknown) { const token = process.env.PSR_TOKEN; if (!token)
    throw new Error('Set PSR_TOKEN; do not pass tokens as command-line arguments or URLs.'); const url = new URL(process.env.PSR_URL ?? 'http://127.0.0.1:8787'); if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    throw new Error('Use HTTPS for a non-loopback Router.'); const res = await fetch(new URL(`/v1/tools/${encodeURIComponent(name)}`, url), { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(args), signal: AbortSignal.timeout(70000) }); const result = await res.json() as any; if (!res.ok)
    throw new Error(`${result.code ?? res.status}: ${result.message ?? 'Request failed'}`); return result; }
async function main() { const a = process.argv.slice(2); const read = (s: string) => JSON.parse(s?.startsWith('@') ? readFileSync(s.slice(1), 'utf8') : s ?? '{}'); let out: unknown; switch (a[0]) {
    case 'hosts':
        out = await callTool('psr_list_hosts', {});
        break;
    case 'sessions':
        out = await callTool('psr_list_sessions', a[1] ? { query: a[1] } : {});
        break;
    case 'resolve':
        out = await callTool('psr_resolve_target', read(a[1]));
        break;
    case 'tasks':
        out = await callTool('psr_list_tasks', {});
        break;
    case 'task':
        out = await callTool('psr_get_task', { taskId: a[1] });
        break;
    case 'cancel':
        out = await callTool('psr_cancel_task', { taskId: a[1] });
        break;
    case 'wait':
        out = await callTool('psr_wait_task', { taskId: a[1], ...(a[2] ? { timeoutMs: Number(a[2]) } : {}) });
        break;
    case 'messages':
        out = await callTool('psr_wait_messages', { ...(a[1] ? { after: Number(a[1]) } : {}), ...(a[2] ? { timeoutMs: Number(a[2]) } : {}) });
        break;
    case 'reply': {
        if (!a[1] || !a[2])
            throw new Error('reply requires TASK_ID and prompt');
        const keyAt = a.indexOf('--key');
        const key = keyAt >= 0 ? a[keyAt + 1] : randomUUID();
        console.error(`Idempotency key: ${key} — retain it for retries.`);
        out = await callTool('psr_reply_task', { taskId: a[1], prompt: a[2], idempotencyKey: key });
        break;
    }
    case 'topology':
        out = await callTool('psr_get_topology', {});
        break;
    case 'submit': {
        if (!a[1] || !a[2])
            throw new Error('submit requires SESSION_REF and prompt');
        const keyAt = a.indexOf('--key');
        const key = keyAt >= 0 ? a[keyAt + 1] : randomUUID();
        console.error(`Idempotency key: ${key} — retain it for retries.`);
        const route = await callTool('psr_resolve_target', { sessionRef: a[1] });
        if (route.status !== 'resolved')
            throw new Error(JSON.stringify(route));
        out = await callTool('psr_submit_task', { routeTicket: route.routeTicket, prompt: a[2], idempotencyKey: key, busyPolicy: 'queue' });
        break;
    }
    case 'call':
        out = await callTool(a[1], read(a[2]));
        break;
    default:
        console.log(usage);
        return;
} console.log(JSON.stringify(out, null, 2)); }
if (process.argv[1]?.endsWith('/cli.js') || process.argv[1]?.endsWith('/cli.ts'))
    main().catch(e => { console.error(e.message); process.exitCode = 1; });
