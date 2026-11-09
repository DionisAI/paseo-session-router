import { createInterface } from 'node:readline';
/** Newline-delimited MCP stdio to the same authenticated /mcp endpoint; stdout is protocol-only. */
const token = process.env.PSR_TOKEN;
if (!token) {
    console.error('Set PSR_TOKEN.');
    process.exit(1);
}
const base = new URL(process.env.PSR_URL ?? 'http://127.0.0.1:8787');
if (base.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)) {
    console.error('Non-loopback Router requires HTTPS.');
    process.exit(1);
}
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
let pending = Promise.resolve();
lines.on('line', line => { pending = pending.then(async () => { if (!line.trim())
    return; let req: any; try {
    if (Buffer.byteLength(line) > 65536)
        throw new Error('Request too large');
    req = JSON.parse(line);
    const response = await fetch(new URL('/mcp', base), { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: line, signal: AbortSignal.timeout(70000) });
    if (response.status === 202)
        return;
    const data = await response.json();
    if (!response.ok)
        throw new Error(JSON.stringify(data));
    process.stdout.write(JSON.stringify(data) + '\n');
}
catch (e) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req?.id ?? null, error: { code: -32603, message: e instanceof Error ? e.message : 'Bridge failed' } }) + '\n');
} }); });
