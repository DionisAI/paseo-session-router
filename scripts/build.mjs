import {existsSync, rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const compiler = existsSync('tools/node_modules/typescript/bin/tsc') ? [process.execPath, 'tools/node_modules/typescript/bin/tsc'] : ['tsc'];
const result = spawnSync(compiler[0], [...compiler.slice(1), '-p', 'tsconfig.json'], {stdio:'inherit'});
if(result.error) console.error('Install development tools with npm run install:dev. The included dist/ runs without npm dependencies.');
process.exit(result.status ?? 1);
