# Security

## Reporting a vulnerability

Please report security problems privately through this repository's **Security → Report a vulnerability** (GitHub private vulnerability reporting). Do not open a public issue or pull request for them. Include the version, what you did, what happened, and the shape of your configuration (never real tokens, pairing links or host names you do not want published).

This is a small project maintained in spare time: reports are answered on a best-effort basis, usually within a week. Only the latest release receives fixes.

## What the Router can do, seen by an attacker

Read this before you deploy it.

- **A pairing link is owner access to a Paseo daemon.** The Router keeps one per connected machine (in `.env`). With it, a client can create agents on that machine, send them prompts, answer their permission requests, and read and write files in their working directories. In practice, **whoever controls the Router can run code on every machine connected to it**, through those agents.
- **The data directory is as sensitive as `.env`.** Its SQLite database holds the Router's signing secret, which signs route tickets and the credentials of the planner, of agent sessions and of local sessions. Anyone who can read the database can mint those credentials. The Router creates the directory with mode 0700; keep it that way, and back it up as you would back up secrets.
- **An admin token is the owner.** It can change policy, approve every level, create sessions anywhere, issue machine credentials and read every forum and message.

So the Router host, its `.env`, its data directory and the admin token are what you protect. Everything below follows from that.

## Built-in protections

- **Loopback by default.** The Router listens on `127.0.0.1`. Listening on any other address is refused unless the configuration says `"listenBeyondLoopback": true`, and it then prints a warning at every start.
- **One credential per entry.** The console, the CLI and each front-end (Grokbot, dot, Muse) have their own bearer token, compared in constant time, each limited by scopes, projects and hosts. Front-ends never get `admin`; the owner sets a ceiling for each, and the planner can only narrow it. Each entry is limited to 600 requests a minute; request bodies to 64 KiB.
- **Permission levels.** Every permission request an agent makes is classified by its exact command or path: L0 read, L1 edit its own checkout, L2 install and run, L3 services and system, L4 trading, credentials and anything unrecognized. A chain of commands counts as its most dangerous step. Who may approve each level is the owner's choice; L4 is always the owner's. An answer approves one request once and never widens the session's own mode.
- **Owner-only hosts.** A host marked `"humanApproval": true` (live trading, production) accepts approvals only from the owner, and only the owner may send work to a session there whose mode would not ask before acting.
- **Agents are untrusted.** Messages, forum posts, service answers, verdicts and transferred files are data, never instructions, and cannot authorize anything. Agents cannot create sessions. Arbiter and service seats are restricted in code to what their profile allows. Values that look like secrets are masked before they are stored; this is best effort.
- **Pinned daemon identity.** Over the Paseo relay, the Router connects end to end encrypted to the daemon key pinned from the pairing link; a different daemon cannot answer for it.
- **No remote shell, no login relay.** The Router never runs commands on the machines itself, and provider logins (Claude, Codex) never pass through it: they are renewed in the owner's own terminal.
- **Files** move only as one-time codes (only their hash is stored), at most 100 MB and 60 minutes, and files that look like credentials are refused by name, location and content.
- **Console.** Same-origin scripts only (`script-src 'self'`, no CDN), `frame-ancestors`/`X-Frame-Options: DENY`, `nosniff`, `no-referrer`; the token is kept in the tab's session storage.

## Deployment checklist

1. **Never expose the Router to the internet.** Keep it on loopback and reach it through a tailnet (for example `tailscale serve`), a VPN, or an authenticating reverse proxy with TLS (`deploy/Caddyfile.example`). In a container, the Router must listen on `0.0.0.0` inside it: set `"listenBeyondLoopback": true` and publish the port on `127.0.0.1` only (`-p 127.0.0.1:8787:8787`).
2. **Run it as its own unprivileged user.** `deploy/paseo-session-router.service` uses `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome=read-only` and `PrivateTmp`.
3. **Keep secrets out of files you share.** Create `.env` with `node scripts/generate-secrets.mjs .env` (mode 0600, never overwritten). Never commit `.env`, your `router.local.json` or the data directory.
4. **Give each front-end the least it needs.** A sensible ceiling is `read`, `goal` and `plan`: it hands goals to the planner and approves plans, and the planner does the rest.
5. **Mark dangerous machines owner-only** (`"humanApproval": true`) and run sessions there in modes that ask first (Claude `default` or `plan`, Codex `auto`).
6. **Rotate what leaks.** An entry token: generate a new one in `.env` and restart. An agent channel or a machine credential: revoke it from the console. A pairing link: rotate the daemon's key on that machine so the old link stops working.
7. **Keep Paseo, Node.js and the pinned Paseo SDK** (`integrations/paseo/package.json`) up to date; test an SDK upgrade on a non-critical daemon first.

## Known limits

- Single owner: there is no isolation between tenants, and every entry acts for the same owner.
- Secret masking is pattern-based and best effort.
- Writer locks only order the Router's own dispatch; someone using Paseo directly bypasses them (the Router pauses dispatch to a session used that way until the owner resumes it).
- Arbiter seat checks see only the paths written in a request: a symbolic link inside a checkout that points outside it is not caught, and tools pre-approved in a machine user's own `~/.claude` settings never reach the Router.
- The MCP endpoint is a minimal tools-only implementation without OAuth.
