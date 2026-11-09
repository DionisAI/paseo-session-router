import { randomBytes } from 'node:crypto';
import { openSync,writeFileSync,closeSync,chmodSync } from 'node:fs';
const target=process.argv[2]??'.env';
const fd=openSync(target,'wx',0o600);
try {writeFileSync(fd,['# Keep private. One credential per entry. Never commit this file.',...['WEB','GROKBOT','DOT','MUSE','CLI'].map(k=>`PSR_${k}_TOKEN=${randomBytes(32).toString('base64url')}`),''].join('\n'));} finally{closeSync(fd);}
chmodSync(target,0o600);console.log(`Created ${target} (0600). Existing files are never overwritten.`);
