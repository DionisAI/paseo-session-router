# Contributing

Thanks for helping. For anything larger than a small fix, open an issue first so we can agree on the approach.

## Setup

```bash
npm run install:dev   # TypeScript and Node types, into tools/
npm run build
npm test
npm run demo          # a simulated fleet at http://127.0.0.1:8787
```

Node.js 22.16 or later. Browser tests are optional (`npm run test:ui`, Python Playwright).

## What a change needs

- **Tests.** Every change in behaviour comes with a test. The demo adapter (`src/demo-adapter.ts`) simulates daemons and sessions; `tests/helpers.ts` builds a Router around it.
- **No new runtime dependencies.** The core runs on Node.js alone (built-in SQLite, HTTP and crypto). Discuss any dependency in an issue first.
- **The console stays plain.** Plain JavaScript and CSS in `web/`, scripts from the same origin only, no inline event handlers (the Content Security Policy blocks them), no CDN.
- **Tool contracts in sync.** When you add or change a tool, run `node scripts/export-openapi.mjs` and commit `docs/openapi.json` and `docs/tool-catalog.json`; CI checks them.
- **Match the code around you**: naming, comment style and the way errors are raised (`assert(condition, CODE, message, status)`).

## Never commit real deployment details

No real host names, IP addresses, user names, tokens, pairing links or screenshots of a real fleet in code, tests, docs or issues. Use `example.com`, `example.ts.net`, `gpu1`, `/home/agent`. Fake credentials that test the Router's masking are written split (`'sk_' + '…'`), so secret scanners do not flag them; CI runs gitleaks.

## Security problems

Report them privately as described in [SECURITY.md](SECURITY.md), not in an issue.

## License

By contributing you agree that your contributions are licensed under the MIT License of this repository.
