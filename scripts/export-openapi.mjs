import { writeFileSync } from 'node:fs';
import { openapi, TOOLS } from '../dist/src/tools.js';
writeFileSync('docs/openapi.json',JSON.stringify(openapi('https://router.example.com'),null,2)+'\n');
writeFileSync('docs/tool-catalog.json',JSON.stringify(TOOLS,null,2)+'\n');
console.log(`Exported ${TOOLS.length} tool contracts.`);
