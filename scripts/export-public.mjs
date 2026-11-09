// Copies what is published from this working tree into a new, empty folder, then checks the copy before anyone runs git init
// in it. Only the paths listed in INCLUDE go; build output, test output, local tooling and every deployment's private files
// never do. Nothing is deleted anywhere.
//   node scripts/export-public.mjs <new folder> [--deny <patterns file>]
// --deny names a file of regular expressions, one per line (# starts a comment): your own host names, addresses, user names.
// Keep that file private (it lists what must not be published). Every text file of the copy is searched for them, and the
// copy is scanned with gitleaks when it is installed. Exit status 1 when anything is found; the copy stays for you to inspect.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

const INCLUDE = ['README.md', 'README.zh-TW.md', 'SECURITY.md', 'CONTRIBUTING.md', 'LICENSE', 'package.json', 'package-lock.json',
    'tsconfig.json', '.gitignore', '.dockerignore', '.gitleaks.toml', '.env.example', '.github', 'config', 'deploy', 'docs',
    'integrations', 'scripts', 'skills', 'src', 'tests', 'tools/package.json', 'tools/package-lock.json', 'web'];
const SKIP = new Set(['node_modules', '.DS_Store']);
const TEXT = /\.(ts|js|mjs|cjs|json|md|txt|html|css|sh|py|toml|ya?ml|service|example|d\.ts|map)$|(^|\/)(psr|Caddyfile[^/]*|Dockerfile|LICENSE|\.[a-z]+ignore|\.env\.example)$/;

const args = process.argv.slice(2), at = args.indexOf('--deny');
const denyFile = at >= 0 ? args.splice(at, 2)[1] : null, target = args[0];
if (!target || args.length !== 1 || (at >= 0 && !denyFile)) { console.error('usage: node scripts/export-public.mjs <new folder> [--deny <patterns file>]'); process.exit(2); }
const out = resolve(target), here = resolve('.');
if (!existsSync(join(here, 'src/core.ts'))) { console.error('run this in the repository root'); process.exit(2); }
if (out === here || out.startsWith(here + sep)) { console.error('the copy must be outside this working tree'); process.exit(2); }
if (existsSync(out) && readdirSync(out).length) { console.error(`${out} exists and is not empty: give a new folder`); process.exit(2); }

// 1. copy
mkdirSync(out, { recursive: true });
for (const p of INCLUDE) {
    if (!existsSync(p)) { console.error(`missing ${p}`); process.exit(2); }
    cpSync(p, join(out, p), { recursive: true, filter: src => !SKIP.has(src.split(sep).at(-1)) });
}
const files = [];
const walk = dir => { for (const e of readdirSync(dir, { withFileTypes: true })) { const f = join(dir, e.name); e.isDirectory() ? walk(f) : files.push(f); } };
walk(out);
const bytes = files.reduce((n, f) => n + statSync(f).size, 0);
console.log(`copied ${files.length} files (${(bytes / 1048576).toFixed(1)} MB) to ${out}`);

// 2. your own identifiers: file, line and which pattern (the match itself is not printed)
let problems = 0;
if (denyFile) {
    const patterns = readFileSync(denyFile, 'utf8').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#')).map(l => new RegExp(l, 'i'));
    const unchecked = [];
    for (const f of files) {
        const rel = relative(out, f);
        if (!TEXT.test(rel)) { unchecked.push(rel); continue; }
        readFileSync(f, 'utf8').split('\n').forEach((line, i) => patterns.forEach((re, n) => { if (re.test(line)) { problems++; console.log(`  deny pattern #${n + 1}: ${rel}:${i + 1}`); } }));
    }
    console.log(`checked ${files.length - unchecked.length} text files against ${patterns.length} patterns: ${problems} found`);
    if (unchecked.length) console.log(`not text, look at these yourself (images show what they show): ${unchecked.filter(f => !f.startsWith(`web${sep}vendor`)).join(', ') || 'only the vendored three.js'}`);
} else console.log('no --deny file: your own host names, addresses and user names were NOT checked');

// 3. secrets
const g = spawnSync('gitleaks', ['dir', out, '--no-banner', '--redact', '--config', join(out, '.gitleaks.toml')], { encoding: 'utf8' });
if (g.error) console.log('gitleaks is not installed: secrets were NOT scanned (CI scans every push)');
else { const found = g.status !== 0; if (found) problems++; console.log(`gitleaks: ${found ? 'FOUND something:\n' + (g.stdout + g.stderr).trim() : 'no leaks found'}`); }

console.log(problems ? '\nNOT ready: fix the findings in the working tree and export again into a new folder.' : `\nready: cd ${out} && git init && git add . && git status`);
process.exit(problems ? 1 : 0);
