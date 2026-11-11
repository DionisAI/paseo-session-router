# Deployment and operating boundaries

## Supported topology

One owner, one active Controller process, local durable SQLite. It is not a distributed or multi-tenant service. Do not put the database/process lock on NFS. A separate OS-backed SQLite exclusive transaction prevents two Controllers from using the same directory and releases on actual process death; a lease TTL is not used as proof of remote job completion.

Place the Controller on an always-on machine. Keep SSH keys in its dedicated low-privilege service account. The Web app and entry bots do not need SSH keys. The bundled systemd units are templates: paths, service user, known_hosts, SSH aliases, Node path and storage permissions must match the target machine.

## Minimal live configuration

Start from `config/router.example.json`. The sample is **configuration, not discovered user infrastructure**. Replace placeholder hosts/domains/paths. A daemon mapping is exact cwd → project/workspace/mutationDomain. If two paths or two machines refer to the same mounted writable files, give them the same mutation domain. The Router does not remotely canonicalize mounts or prove that two paths are isolated.

The example uses `releasePolicy: on_turn_end`: after a native terminal turn event, the writer lock is released once a fresh observation shows the session idle (no active turn, not running, no pending permission). Under `manual`, every finished task keeps the lock until an operator runs `psr_release_mutation`; entry clients without admin scope (Grokbot/dot/Muse) cannot do that, so the domain stops after one task and queued tasks report `Waiting for writer release of finished task …`. Choose `manual` for a mapping only when a turn can end while a background job (for example a detached shell process) is still writing in that mutation domain.

`autoMap: {projectId, releasePolicy, externalTurns?}` on a daemon makes every discovered session with an absolute cwd dispatchable without its own mapping. Its mutation domain is `auto:<hostId>:<cwd>`, so two sessions in the same checkout on one host serialize, while a worktree in another directory is a separate domain; give explicitly shared storage an explicit mapping (explicit mappings always win). The `auto:` prefix is reserved.

`externalTurns` decides what a turn started outside the Router (someone using the Paseo app, a `/goal` run) does to queued Router tasks: `pause` (default for explicit mappings) blocks dispatch until `psr_set_dispatch_mode` (worker) or `psr_resume_session` (any session) resumes it; `wait` (default for `autoMap`) treats the turn as busy and delivers queued tasks once it ends.

## Connecting daemons through the Paseo relay (recommended)

Run `paseo pair` on each machine and store the printed pairing link in the Controller's environment (`.env` or a secret manager), then set `"pairingEnv": "<VAR>"` on that daemon instead of `url`. The Router parses the link (offer v2: `serverId`, daemon public key, relay endpoint; unknown versions are refused) and connects to `wss://<relay>/ws?serverId=…&role=client&v=2` with E2EE to the pinned key — the same path the Paseo apps use. No inbound port, tunnel or SSH key is needed on either side, and NAT is fine. Identity is proven by the handshake (`e2ee:<serverId>:<key fingerprint>`); no identity probe is required. `npm run smoke:live` reports `transport: paseo-relay-e2ee`.

Treat a pairing link as the owner credential of that daemon. In Paseo 0.12.0 a relay client is admitted as owner without a credential when the daemon has no password, and also when it has one (`relayPasswordOptional` compatibility). Keep links out of configuration files and Git; replacing the daemon key on the Paseo side is what invalidates a leaked link. Traffic goes through the relay endpoint named in the link (Paseo's hosted relay by default).

## Identity and SSH setup

Pin each server's SSH host key through an authenticated administrative process. Never use `StrictHostKeyChecking=no`. Example identity file preparation on a known test machine:

```bash
mkdir -p ~/.config/psr
chmod 700 ~/.config/psr
printf '%s\n' 'gpu1-research-initial' > ~/.config/psr/research.identity
chmod 600 ~/.config/psr/research.identity
```

The matching configuration's `expectedValue` and `incarnation` are administrator-assigned identifiers, not secrets. The probe uses a **configured** executable and argument array, with no model-controlled command interpolation. Expected stdout is the exact identifier line. stdin carries a JSON request that a simple `cat` probe may ignore.

This checks an SSH-reachable administrator identity marker. It does **not cryptographically bind** the SDK WebSocket peer to that marker, does not inspect a provider account, and does not detect a malicious administrator who reuses the marker for a different daemon. Ensure the tunnel and probe address the same registered host/account. Rotate incarnation and marker when resetting the underlying daemon identity/state. Use additional endpoint authentication where the daemon requires it.

No probe means `unverified`: listing may work, dispatch stays disabled. Mismatch blocks dispatch and is visible in the UI.

An SSH probe is a full login (about 1.4 s from a workstation to a server in another region, in acceptance). Directory sync therefore reuses a probe result for `identityProbe.cacheMs` (default 60000; `0` probes every tick); every dispatch still probes afresh. To make each login cheap as well, give the service account an SSH `ControlMaster auto` / `ControlPersist` entry for the host, with a short `ControlPath` (macOS limits socket paths to 104 bytes).

## Real SDK boundary

The optional integration package pins `@getpaseo/client` 0.15.2, the version every daemon runs (0.12.0 until 2026-11-08). The fixture tests check our structural assumptions, not the package binary. Before changing the pin, install the new client outside the Router (`.state/sdk-0152/` has the scripts used for 0.15.2) and run it through the Router's adapter against a non-live daemon: connect and identity, list, create, a turn, history (compare it with the old client's on the same session), a permission request denied, a turn canceled, a file written and read back. Then swap `integrations/paseo/node_modules` and restart, keeping the old folder for a rollback (`.state/sdk-0152/swap-sdk.sh` does both and rolls back by itself if the daemons do not come back).

The adapter uses public list/ref/refresh/send/timeline/create methods. It does not invent RPCs. Cancelling a turn uses Paseo's cancel_agent_request (cancelAgentRun: interrupt the current run, wait for it to settle, otherwise turn_canceled); it never archives or kills the agent. The approval timeout (權限, default 2 hours) cancels turns left waiting for a permission answer. Provider permissions are never automatically approved.

A user timeline event must contain an explicit turn ID to correlate it with a queued task. Some provider/SDK shapes or projected histories may omit it or omit terminal events. In that case the task stays pending/unknown; a completed-looking assistant string and an idle state are not substituted as evidence. The operator can inspect Paseo and record an explicit outcome attestation. This limitation must be part of live acceptance; do not label the integration fully operational just because list/send work.

## Writer recovery

After a lost acknowledgement, retain the task and lock. Reconnect/read the exact session history. Never send the same prompt again merely because the Router timed out. Stop direct manual prompts to Router-managed sessions, or first pause the worker, deal with in-flight work, and resume explicitly.

`psr_attest_outcome` requires admin scope, an exact `ATTEST <taskId>` confirmation and independently verified evidence; it records operator evidence distinctly. `psr_release_mutation` requires a terminal task, idle/unreachable checks, exact `RELEASE <taskId>` and evidence that outside jobs/writers stopped. Neither is proof inferred from a timeout. The operator remains responsible for the truth of the attestation.

Restart order is discover → reconcile → observe → dispatch. Restarting the Router does not restart native agents. Demo remote state is in memory and should not be treated as a persistent provider service.

## Creation templates

Clients with the `create` scope can only start sessions from `templates`. Each names a daemon, an exact checkout that daemon maps, a `provider` as `provider/model` (for example `claude/claude-sonnet-5-5`; `paseo provider models claude` lists the ids) and a title; `description` tells planners what the sessions are for. `modeId` sets the provider permission mode of created sessions (Claude: `plan`, `default` = always ask, `acceptEdits`, `auto`, `bypassPermissions`). Without it Paseo uses the provider default, which for Claude is `auto` (a model classifier approves tool calls). Use `default` or `plan` on machines where a wrong command is costly, such as live trading hosts; approvals then wait in Paseo and the task shows `waiting_permission`.

Each creation record keeps who asked for the session (`createdBy`: the client, and for the planner its own session) and when. `psr_get_tree of=sessions` groups sessions by it: the planner with the sessions it created under it, one group per client, the Router's seats, `unrecorded` (created by a release that did not keep `createdBy`; they stay there) and `found` (sessions the Router discovered in Paseo but did not create). `psr_get_tree of=tasks` gives each mission with its parts and steps, built on the Router so every front-end sees the same tree. `psr_list_hosts` says per machine how many sessions run, wait for an answer or are offline, and each daemon's agent channel. The Router measures only its own machine (CPUs, load, available memory, swap): the one host whose daemons reach it at a loopback `agentChannel` URL, like `http://127.0.0.1:8787/mcp`. When none or several do, no machine is measured.

## Permission approvals and levels

A session whose permission mode asks before a command shows its task as `waiting_permission`. The Router gives each request a level from the exact command or file path: L0 read-only, L1 edits inside the session's checkout, L2 installs and running programs, L3 services and the system (sudo, files outside the checkout), L4 trading and secrets, and anything it does not recognise. `psr_list_permissions` returns the command, its level, the rule that set it, who may answer and whether the caller may. The owner (an admin client: the console, the CLI) can always answer; who else may answer each level (the planner, front-ends for turns they assigned) is set in the console's 權限 view or with `psr_set_policy`. L4 stays the owner's. Hosts with `"humanApproval": true` accept only the owner. One answer covers one request once and never widens the session's standing permissions; the decision and its level are kept on the task (`approvals`).

**Owner-only hosts and modes that do not ask the owner.** On a host with `humanApproval` only the owner answers requests, which protects nothing when a session never sends one: Claude `auto` (a classifier approves), `acceptEdits` and `bypassPermissions`, Codex `auto-review` (a reviewer subagent approves) and `full-access` (never asks). So on such a host only the owner (an admin client) sends work to a session in such a mode, or in a mode the Router does not know. Everyone else (front-ends such as Grokbot and Muse, the planner, the Router's resource turns in their name) is refused with `OWNER_ONLY_TARGET`, and may send work only to sessions whose requests reach the owner: Claude `default` or `plan`, Codex `auto` or `read-only` (`OWNER_APPROVAL_MODES` in `src/config.ts`; Codex `auto` still runs commands without asking inside its workspace sandbox, with no network). The check is made when a task is submitted (replies and handoffs too), again when it is dispatched, and once more against the mode the daemon reports right before sending: a task queued before the session was switched to such a mode waits (its blocker says why) until the mode changes back or the task is canceled. The Router's own seat turns keep their own rule (seats must run in `default` or `plan`).

Owner rules (`{id, level, pattern, note}`, a regular expression matched against one simple command, or against "tool detail" for other tools) take precedence over the built-in rules, except that the built-in `secret` rule keeps credentials and keys at L4 unless it is switched off. Put the paths of anything that trades (strategy directories, order tools) in an L4 rule: a script's contents are not inspected, only how it is started.

## The planner

The Router can run its own planner: one Claude session it creates from a template and wakes when something happens. Add an exact checkout for it on the daemon of the machine it should run on, and a Claude template with a mode that asks before acting:

```json
{ "id": "router-planner", "daemonId": "router-paseo", "cwd": "/home/agent/psr-planner", "provider": "claude/claude-sonnet-5", "modeId": "default", "title": "規劃者", "description": "Router 的規劃者" }
```

Then create it in the console (權限 → 規劃者) or with `psr_setup_planner`. It runs only on a Claude template that is not a seat. If some of those are on a daemon whose sessions reach the Router at the planner's URL (an http `agentChannel` with exactly that URL, as on the Router's own machine), only those can host it: the console lists just them and `psr_setup_planner` refuses the rest. Otherwise every such template is offered. The session gets the planner instructions as its system prompt, the Router's planner tools over MCP at `planner.mcpUrl` (default `http://127.0.0.1:<port>/mcp`, so put the planner on the Router's machine or give it a tunnel) with a credential valid only for this session, and Claude's built-in Bash, file and web tools switched off. Paseo does not persist that switch-off across daemon restarts, so the mode that asks before acting is the second guard, and the Router never lets the planner answer its own session's requests. Creating a new planner revokes the previous one's credential. Front-ends hand it goals (`psr_submit_goal`); their scopes are the owner's ceiling (`psr_set_policy` `ceilings`) narrowed by what the planner grants (`psr_set_access`). The suggested ceiling for a front-end is `["read", "goal", "plan"]`.

A planner session sees only the tools of the toolset it was created with: tools a later release adds (for now `psr_get_tree`, which comes with toolset 6) stay hidden from it, because Paseo would ask before each call and the planner cannot answer its own requests. Re-create the planner (重建) when the console says it is outdated.

On a small machine, make the planner's processes the first the kernel stops under memory pressure, not the Router (for example raise `oom_score_adj` of the Paseo daemon that runs it).

## Independent acceptance (arbiter seats)

A task can ask to be checked after it completes (`verify` on `psr_submit_task` / `psr_handoff`, goal work only). The check runs in an arbiter seat: a separate session that only the Router sends work to, on the same machine as the task (a seat elsewhere cannot see its files, so a check never moves to another machine, and `verify` is refused where no seat of that profile exists). Give each machine that should check its own work a seat template with its own exact checkout and mutation domain, an asking mode, and an agent channel on that daemon:

```json
{ "cwd": "/home/agent/psr-judge", "projectId": "ops", "workspaceId": "judge-router", "mutationDomainId": "judge-router", "releasePolicy": "on_turn_end" }
{ "id": "judge-router", "daemonId": "router-paseo", "cwd": "/home/agent/psr-judge", "provider": "claude/claude-opus-5-5", "modeId": "default", "seat": true, "title": "驗收（router-host）" }
```

Config validation refuses a seat template whose mode does not ask before acting (`default` or `plan`), whose checkout or domain is shared, whose checkout is `/`, a top-level directory or a whole home directory (a seat reads its own directory by bare file names), or whose daemon has no `agentChannel`. Then define a profile (`psr_set_policy` with `verification.profiles`, for example `{ "id": "node-check", "commands": ["node -v", "npm -v"] }`) and create one seat per machine as the owner: `psr_create_session` with `role: "arbiter"` and `profileId`. A seat template holds one live seat (a second is refused with `SEAT_TEMPLATE`, since both would share one mutation domain); retire the old seat with `psr_revoke_agent_channel` before recreating it. The Router answers the seat's permission requests itself: read tools and single plain read commands are allowed only on paths inside the checked task's checkout and, by bare file name, in the seat's own directory (never /proc, /dev or /sys, never secret-looking paths), the profile's exact command lines are allowed as written, and everything else, including MCP tools, is denied without stopping the turn. Paths are judged as written: a symlink inside the checkout that points elsewhere is not caught. `verify` (and moving a checked task) is refused when the task's session runs in `/`, a top-level directory or a whole home directory, since that is no checkout to limit reads to. Verdict notes and evidence are masked on a best-effort basis before they are stored (NAME=value for key, token, secret and password names, bearer and basic auth, passwords in URLs, signed tokens and long opaque strings not already visible on the task); this is not a guarantee, so the prompt also tells the arbiter never to copy secret values. A Claude seat is created without Edit, Write, WebFetch, WebSearch, Task and similar tools; Paseo forgets that list when its daemon restarts, so the Router's answers are the real limit. Seats load the daemon user's own `~/.claude` settings: before seating a machine, check that user's `permissions.allow`, hooks and MCP servers, since a tool that user settings allow never asks and so never reaches the Router. On hosts marked `humanApproval` the Router answers nothing and the owner decides. A profile may also name a `verifier` (`command` an absolute path, `args`, `timeoutMs`) that the Router runs itself before any arbiter turn, with JSON on stdin and only PATH, HOME and LANG in its environment: exit 0 passes it on to the arbiter, 1 fails the task, 2 means malformed input. Dispatch to a seat stops if its Paseo mode was switched to one that does not ask first.

## Agent message channel

`agentChannel` on a daemon gives template-created sessions an MCP server named `psr` with `psr_post_message` preapproved (and, on the http channel, `psr_ask` and the mission forum tools `psr_forum_read`/`psr_forum_post`; see the next sections). Paseo accepts MCP servers only at creation, so sessions created directly in Paseo have no channel.

- `{"mode": "observed"}` (default when no `url` is set): the tool is a dependency-free stdio stub run with Node on the agent's own host (`nodeCommand`, default `node`, must be on the Paseo daemon's PATH there). It validates and acknowledges; the call itself (name and input) is recorded in the Paseo timeline, which the Router already observes over its daemon connection, and becomes an inbox message for the client that assigned the turn. The agent needs no route, port or credential back to the Controller. Messages are attributed only within a Router-assigned turn and deduplicated by the provider call ID, so live delivery and history replay deliver once.
- `{"url": ".../mcp", "tokenTtlMs"?}` (http): the agent calls the Router MCP directly with a per-session credential (`psra_…`) in its Authorization header, stored by Paseo with the agent's configuration on that host. It can post messages, call services (`psr_ask`) and use its mission's forum as that session and nothing else, expires after `tokenTtlMs` (default 30 days) and `psr_revoke_agent_channel` revokes it. The URL must reach the Controller from that host (loopback on the Controller itself, an SSH reverse forward, or the Controller's public HTTPS origin).

Messages are bounded (4 KiB each, 30 per minute per session, 100 per task, 2000 retained) and untrusted: entry clients read them with `psr_wait_messages` and must treat the text as data.

## Agent as a service (psr_ask)

`psr_ask` lets an agent use another agent like a tool. It sends a request to a named service and usually gets the answer back in the same call, for example asking the data machine which file holds what. Several agents working on parts of one task should coordinate through the mission forum (below), not through `psr_ask`. Only service seats answer: sessions created from a seat template with `role: "service"`, which only the Router sends work to. Each request becomes a Router turn on the least recently used free seat of that service. A busy seat is never interrupted; requests wait in the service's queue in order. Front-ends cannot call `psr_ask`; it is for agents during a turn the Router sent them.

**1. Put the callers on the http channel.** The observed stub only acknowledges a call, so it cannot bring an answer back. On each daemon whose sessions should call services, replace `{"mode": "observed"}` with:

```json
"agentChannel": { "mode": "http", "url": "https://router.example.ts.net/mcp" }
```

Use that URL on tailnet hosts, and `"url": "http://127.0.0.1:8787/mcp"` on the Router's own host. Plain http is accepted only on loopback. `mode` wins over `url`: if you leave `"mode": "observed"` in place, the url is ignored. A tailnet host must reach the Router's name on port 443. Allow that in the tailnet policy, and on a host started with `--accept-dns=false`, add an `/etc/hosts` line for the name. Check the config (`set -a; . ./.env; node -e "import('./dist/src/config.js').then(m=>m.loadConfig('router.local.json'))"`) and restart the Router.

Then recreate the callers. Paseo takes MCP servers only when it creates an agent, so sessions created before the switch keep the stdio stub. They keep working as before: the Router still reads their `psr_post_message` calls from the timeline, and a service seat created without a Router MCP is not told it may call `psr_ask`. But they have no `psr_ask` and no forum. Create new sessions from the same templates (`psr_create_session`) for those, and archive the old ones when you like. Existing arbiter seats keep working, since their verdicts are still read from the timeline.

Each creation record keeps the channel its session was created with (`channel`: `observed`, `http`, `planner` or `none`), and that decides how the Router reads it, whatever the daemon is set to later. A session created on http is never read from the timeline, so switching a daemon back to observed does not deliver its messages twice (it loses `psr_ask` and the forum). Records written before this field existed are stamped once, at the first start of the release that added it, from the config of that start (meta `creationChannelBackfill` holds the modes it used). So deploy that release and restart before changing any daemon's channel, and check the meta's modes before you edit `agentChannel`: a first start with an already changed config stamps the old stub sessions `http` for good, and putting the config back does not undo it. If you roll back to an older release before changing channels and it creates sessions, set that meta to `''` (config unchanged) before starting the newer release again; records already stamped are skipped. A session with no creation record (one made in Paseo, or a creation whose outcome was lost) follows its daemon's mode. An http credential expires after `tokenTtlMs` (default 30 days); after that, recreate the session or configure a longer value.

Callers are not given a list of services. Name the service in the task prompt; the planner can read the list with `psr_get_policy` (`a2a.services`). A call is refused unless the caller is running a Router turn (`NO_ACTIVE_TASK`) and its host is in the service's `callers` (`CALL_DENIED`). On a `humanApproval` host, a session may call only while it runs in `default` or `plan` mode.

**2. Add a seat template.** Service seats follow the same rules as arbiter seats: `seat: true`, a mode that asks first, a checkout and mutation domain of their own, `releasePolicy: "on_turn_end"`, no `workerId`, and an `agentChannel` on the daemon:

```json
{ "cwd": "/home/ubuntu/psr-data-svc", "projectId": "svc", "workspaceId": "data-svc-data-host", "mutationDomainId": "data-svc-data-host", "releasePolicy": "on_turn_end" }
{ "id": "data-svc-data-host", "daemonId": "data-host-paseo", "cwd": "/home/ubuntu/psr-data-svc", "provider": "claude/claude-sonnet-5-5", "modeId": "default", "seat": true, "title": "數據服務（data-host）" }
```

The seat answers in its final message (at most 8 KB; secret-looking values are masked on a best-effort basis, as in verdicts), so its own daemon needs the http channel only if the service has a `mayCall` list and should call other services itself. A service seat is never placed on a `humanApproval` host: `psr_create_session` refuses with `SERVICE_HOST`. Unlike an arbiter seat, a Claude service seat keeps Claude's built-in tools. Its asking mode and the Router's answers are the only limit. As with arbiter seats, check the daemon user's own `~/.claude` settings first: a tool those settings allow never asks, so it never reaches the Router.

**3. Define the service** as the owner, in the console (權限 → 服務呼叫) or with the CLI: `npm run psr -- call psr_set_policy @a2a.json`.

```json
{ "a2a": { "deliveryMax": 5, "services": [
  { "name": "data", "description": "Datasets on data-host: which file holds what, its columns and date range, and how to read it.",
    "callers": ["router-host", "workstation"], "mayCall": [], "autoAllow": "L0",
    "reads": ["/home/ubuntu/datasets"], "commands": ["df -h /home/ubuntu/datasets"],
    "queueMax": 5, "ttlMin": 60, "waitSec": 600 } ] } }
```

- `services` replaces the whole list (at most 16). `deliveryMax` (1–20, default 5) is how many undelivered answers each caller session keeps. Either may be sent alone.
- `name`: a-z, 0-9 and `-`, starting with a letter or digit, at most 40 characters, unique. `description` (at most 1000 bytes) goes into the seat's prompt and into the prompt of service seats that may call this one.
- `enabled` (default true). A disabled service refuses calls (`SERVICE_DISABLED`) and fails its queued requests.
- `callers`: host ids, or `*`, whose sessions may call the service. `mayCall`: the services this service's seats may call. The call graph must be acyclic, and a chain may be at most 3 services long.
- `autoAllow`: `none` (the default), `L0` or `L1`; see below. `reads`: at most 8 absolute directories the seat may read besides its own checkout; `/`, top-level directories and whole home directories are refused. `commands`: at most 16 exact single-line commands, allowed as written.
- `queueMax` (1–20, default 5): requests waiting for a free seat. `ttlMin` (5–1440, default 60): each request's deadline, and how long an undelivered answer is kept. `waitSec` (30–3600, default 600): the longest synchronous hold for a Claude caller.

**4. Create the seat** as the owner (the service must already exist): `npm run psr -- call psr_create_session '{"templateId": "data-svc-data-host", "idempotencyKey": "seat-data-data-host-1", "role": "service", "service": "data"}'`. Each seat needs its own seat template, with its own checkout and mutation domain. A seat template holds one live seat: a second `psr_create_session` on it is refused with `SEAT_TEMPLATE`, because seats of one template would share one domain and could only run one at a time. To recreate a seat, for example after its credential expired, retire the old one with `psr_revoke_agent_channel` first. For more capacity, give each extra seat its own template; several seats of one service, each from its own template, share the service's queue.

**Permissions on service turns.** The Router answers a service turn's permission requests in code, by `autoAllow`. Requests for secrets are always denied, whether the secret-looking name is in the request itself or in the directory a command runs in (for example `cat config` run in `.aws`). Only the part of the path below the checkout or `reads` directory counts, so a checkout named like `/srv/secrets-sync` still works. `none` leaves everything to the owner. `L0` allows read tools and single plain read commands inside the seat's checkout and the `reads` directories, plus the exact `commands` when they run from the seat's checkout. A plain read command is one call of `ls`, `cat`, `head`, `tail`, `wc`, `grep`, `stat`, `file`, `du`, `df` or `pwd` with flags, paths and a grep pattern: no chains, pipes, redirections, wildcards, `$`, `~` or double quotes outside single quotes, and no option that reads file names from a file (`--files0-from`, `file -f`). The seat's prompt spells this out, since a chained read waits for the owner. Host rules are shown to the seat; one that names a place for outputs does not apply to answers, which go only in the seat's final message. `L1` also allows edits inside the seat's own checkout, except the seat's own agent and git configuration (`.claude/`, `.codex/`, `.git/`, `.mcp.json`, `CLAUDE.md`, `AGENTS.md` and similar). Those edits would change what the seat does for every later caller, so they wait for the owner. An edit is allowed only if every path in it is inside the checkout, judged by the built-in rules: an owner rule can rank an edit higher, but cannot make a path outside the checkout count as inside. Paseo shows at most 2000 characters of a request; a request cut there may name more than the Router can see, so it waits for the owner. `L1` together with `commands` that run the checkout's own code (`npm test`, `make`, `pytest`) still lets a caller's request run code the seat wrote; a list of blocked paths cannot close that, so give a service either edits or such commands, not both, unless you trust every caller. Anything else waits for the owner alone: the planner and front-ends cannot answer service turns (`psr_list_permissions` says `只有你能批（服務輪）`), and the wait counts toward the request's deadline. As for arbiter seats, paths are judged as written, so a symlink that points out of an allowed directory is not caught.

**Waiting and delivery.**

- How long a call holds:
  - A Claude caller that sends a progress token: up to the service's `waitSec`.
  - Codex (user agent `codex…`) and any caller without a progress token: at most 270 s.
  - REST `POST /v1/tools/psr_ask`: 45 s.
- When the hold ends first, the call returns `{"status": "queued", "askId", "note"}`. Once the caller's session is idle with nothing queued, the Router sends one reply task, `[Router] 服務回覆`, carrying every pending answer, in the name of the client that assigned the caller's turn.
- While a caller holds, its Paseo turn stays running. Its session and mutation domain stay busy, so other tasks for it wait.
- `queued` is a normal outcome, not a tool error (`isError` is false), so the caller should not retry.
- A call the caller cancels (`notifications/cancelled`, for example on Esc or the client's own timeout) ends at once with no result, as MCP requires. The same happens when the Router sees that the caller's turn is over while its call is still open (Codex sends no cancel). In both cases the answer goes to the queue and arrives as the next-turn reply.
- Holds live in memory. On a clean shutdown (SIGTERM, a deploy) the Router first ends every held call with the `queued` result. If the Router is killed instead, Claude gives up on the dropped call about 100 s later. Either way, answers that settle afterwards arrive as the next-turn reply.
- On a `humanApproval` host, queued answers are delivered only while the caller's session runs in `default` or `plan` mode. If the owner switches it to another mode, the answers wait, and `ttlMin` still counts.
- Limits: 3 asks per caller turn and 20 per hour per session. No cycles, and chains at most 3 deep.
- A full service queue refuses at once (`QUEUE_FULL`).
- At the deadline, a queued request times out and a running turn is canceled. A turn that already completed before the Router saw the deadline still counts as answered.
- When a request ends without an answer (deadline, failure, or the owner stopping its turn), the sub-requests its turn made that still wait for a seat are canceled too. Sub-requests already running finish their turn, and their answers are dropped.
- Undelivered answers are dropped in these cases:
  - after `ttlMin`;
  - when a newer answer on the same service and `topic` replaces them;
  - beyond `deliveryMax`, oldest first;
  - when the assigning client no longer exists.
- Watch and manage the queues:
  - `psr_list_asks` or `GET /v1/asks` shows each ask's state, chain, answer and delivery. Front-ends see only the asks made in turns they assigned.
  - `psr_get_policy` shows `a2a.seats` and `a2a.queues`.
  - `psr_clear_asks {"sessionRef"}` drops a caller's undelivered answers. `{"service"}` cancels the requests still waiting for a seat.
- Service turns are hidden from front-ends, like arbiter turns.

**Measured client limits** (2026-10-28, with a probe MCP server on a macOS workstation and on a Linux server; Claude Code 2.1.287 and 2.1.311 and Codex 0.164 and 0.165 behaved the same):

- Claude Code:
  - A tool call over http must get its first byte within 60 s, or it fails with "The operation timed out". The Router therefore answers an agent's `psr_ask` with `text/event-stream` at once.
  - After that, Claude needs a progress notification at least every 5 minutes; without one it aborted at about 300 s. The Router sends one every 20 s on the call's `progressToken`. With both, a 600 s hold returned normally.
- Codex: a hard 300 s limit per tool call. Progress does not extend it, and Codex sends no cancel when it gives up. The Router holds Codex callers at most 270 s.
- `tailscale serve` kept a streaming response open for 720 s. Node's `server.requestTimeout` covers only receiving the request, not a held response.

**Codex tool timeout (optional).** Paseo cannot pass a tool timeout to a Codex agent. Codex does merge the `psr` entry that Paseo sends with `[mcp_servers.psr]` in the daemon user's `~/.codex/config.toml` (or `$CODEX_HOME/config.toml`): Paseo's url and headers replace the placeholder's, and `tool_timeout_sec` is kept.

```toml
[mcp_servers.psr]
url = "http://127.0.0.1:9/psr-placeholder"
tool_timeout_sec = 600
```

- The placeholder's transport must match the channel: a `url` for the http channel. A stdio placeholder (`command = …`) merged with Paseo's http entry makes Codex's config fail to load ("url is not supported for stdio").
- Never add `enabled = false`: it survives the merge and switches the Router's `psr` server off in Paseo sessions.
- Plain Codex sessions on that host will probably also list a `psr` server that fails to start (inferred, not tested).
- The Router still holds Codex callers at most 270 s, so this does not lengthen holds. It matters for Codex builds older than 0.164, whose defaults were shorter (60 or 120 s). Codex sends no cancel and can keep the connection open. An answer written after Codex gave up can then be counted as delivered although the agent never saw it. On such a host, set `tool_timeout_sec` to at least 300.

## Local sessions (psr-local)

Claude Code and Codex sessions you start by hand on a machine (not through Paseo) can join the Router's coordination without hooks. Each machine gets one credential; each session starts a small stdio bridge, `integrations/local/psr-local.mjs`, which connects to the Router's `/mcp` for it.

**What a local session can do.**
- `psr_local_forum_read` and `psr_local_forum_post`: the forum of its repository and branch. Worktrees of one repository on one branch share it, on any machine. Without git, the forum is the session's directory on that machine. A session with no directory gets a forum of its own: the ChatGPT app's Codex starts the bridge in `/` for a thread without a project folder, and the Router treats `/` as no directory, so unrelated threads never meet there. The read also lists who else is on that forum now, with their status lines.
- `psr_local_status`: one line (at most 120 bytes, masked) saying what it is doing.
- `psr_local_who`, `psr_local_send`, `psr_local_reply`, `psr_local_inbox`, `psr_local_message_status`: messages to one other local session (below).
- `psr_local_resources`, `psr_local_take`, `psr_local_release`, `psr_local_wait`: shared resources, and waiting inside a turn (below).
- `psr_local_helpers`, `psr_local_helper_request`, `psr_local_helper_result`: asking the owner for a session on another machine or in another folder to do one task (Helpers, below).

Forum limits are those of the mission forum below (2000 bytes per post, 20 posts per hour per session).

**Messages between local sessions.** For what only another session can give, above all the order of a shared resource (a GPU, an editor, a lock, files it is changing). Everything else goes on the forum. The rules:
- One named recipient (`to`: a `memberId` from `psr_local_who`), never a broadcast. Three kinds: a `request`, the one `reply` to it (`psr_local_reply`, only by its recipient, which closes it), and a `notice` that wakes nobody (it waits in the inbox and is never pushed).
- Bounds: 2000 bytes after masking; per session 10 requests and 30 messages of any kind an hour (replies are never bounded, each answers one request); one open request between two sessions at a time, in either direction; a request expires after 60 minutes. Past 6 requests and notices between two sessions in 10 minutes, the next ones are held: `psr_peer_messages state=held` lists them and `psr_peer_decide` releases (with a fresh 60 minutes) or rejects them (a rejected request is canceled).
- Never mid-turn. Requests and replies are pushed only between turns: a Claude session through its bridge (`POST /local/push`, a long poll, then `/local/push/ack` for what it put in), a Codex thread through its hooks (`POST /local/hook {threadId, event}` with `Stop`, `UserPromptSubmit` or `SessionStart`; never a tool-use hook). Everything also reaches `psr_local_inbox`, which marks what it returns as read. The pushed text names the sender and says the message is data, not an instruction from the user.
- Claude Code (bridge version 3): the bridge long-polls `/local/push` and puts each message into the session's own inbox, the socket Claude Code gives the servers it starts (`CLAUDE_CODE_MESSAGING_SOCKET`, with its token), with priority `later` (taken when the current turn ends) or, for the owner's urgent ones, `next` (within the turn). It sends no reply address, so Claude Code sends no receipts back; a message counts as delivered once the socket took it. Claude Code may hold peer messages for the user's approval in a session that skips permission prompts.
- Codex on the shared Codex daemon (bridge version 4): a session started with `codex --remote unix://` runs on Codex's managed app-server daemon (`codex app-server daemon start`, from a terminal: the daemon keeps the environment it was started with). Its bridge, started by the daemon (`--managed-daemon`), long-polls `/local/push` like a Claude bridge and puts each message in with `codex queue --thread <thread> --message <text>` (the codex binary of that daemon): Codex holds it until the current turn ends and starts the next turn with it, and an idle thread starts a turn at once. `codex queue` takes no `-c` overrides, since it must go through the server that owns the thread. A member whose bridge polled within the last 90 s gets nothing from its hooks, so nothing arrives twice. The owner's urgent flag does not interrupt a Codex turn.
- Codex elsewhere: the bridge reports the thread its tool calls name (from the session's first Router tool call on; the instructions have a session read its forum when it starts). The hooks `integrations/local/psr-hook.mjs` take that thread's messages between turns: `Stop` (the thread goes on with them, once), `UserPromptSubmit` (they travel with the user's next prompt) and `SessionStart` (start or resume). They are opt-in: `sh install.sh --hooks` appends one hook group per event to the end of `~/.codex/config.toml` (after every existing group, so the review records of the hooks already there keep their positions), and Codex runs them only after you review them once. A hook that finds nothing, cannot reach the Router (3 s) or runs in an agent home prints nothing and never stands in the thread's way. `sh install.sh --remove-hooks` takes them out again (found by their command, not by comments, since Codex rewrites the file when a hook is reviewed). A thread that never calls a Router tool is never linked and reads its messages with `psr_local_inbox`.
- Restarts: every Claude bridge holds a long poll on the Router. On SIGTERM the Router answers all long polls at once, closes their connections as they go idle and cuts what is left after 3 s, so a restart stays well inside systemd's 30 s stop timeout; the bridges poll again once it is back.
- How a session takes messages (`psr_set_peer_mode`, owner only): `push` (default), `hold` (inbox only) or `off` (nobody may send to it; answers to its own requests still reach its inbox).
- The owner sends with `psr_peer_send`, without the sessions' bounds. Only the owner may mark a message `urgent`, which lets a Claude session take it within its current turn.
- A Codex thread is identified by the thread id its tool calls carry; a bridge that reports it (`X-Psr-Thread`) links its member to that thread. When the app restarts a thread's server, the new bridge replaces the old member and takes over what was on its way to it, its open requests and its mode. A hook finds the member by that thread id, and only with the same machine credential.
- Messages have no project or host on the Router, so they never show in other readers' update streams. Settled messages go a day after they expire.

**How the bridge identifies a session.**
- It runs in the session's real directory. Both Claude Code and Codex start stdio servers there, even when the agent's `PWD` is wrong (Claude Code launched from the desktop app has `PWD=/`).
- It reads the repository (origin name, else the common git directory) and branch itself, and sends them as `X-Psr-Cwd`, `X-Psr-Repo` and `X-Psr-Branch` on every request.
- On `initialize` the Router makes the session a member and returns its `Mcp-Session-Id`; every later request carries that id.
- The bridge pings every 2 minutes. When the agent stops it (`SIGTERM` from Codex, `SIGINT` from Claude Code) or its input closes, it sends `DELETE`.
- The Router closes a member silent for 30 minutes (the session died, or the machine slept). The bridge's next request then joins again on its own.
- A session in a checkout that the Router's own Paseo sessions use (an explicit `mappings` cwd on that host) is refused: those sessions already have a Router channel.
- A session in an agent's own home folder (`~/.codex`, `~/.claude`, or `CODEX_HOME` / `CLAUDE_CONFIG_DIR`) or anywhere below it never joins: the bridge stays out without contacting the Router and offers no tools. The ChatGPT app's Codex starts short background threads in `~/.codex` and `~/.codex/memories` (a git repository of its own), which would otherwise flash in and out of the session tree. Worktrees are projects and still join: `<home>/worktrees/<name>` (the Codex app's) and a repository's own `.claude/worktrees/<name>`. The Router refuses the same folders (`AGENT_HOME`), for older bridges.
- The bridge takes any 409 answer to its `initialize` as final for that session: it lists no tools and its tool calls say why, without asking again.

**Credential.** `psr_issue_local_credential {hostId}` (admin) returns a `psrl_` token once. It is valid for 365 days and is checked against its stored record on every request. `psr_revoke_local_credential` closes that machine's sessions at once. Owner-only (`humanApproval`) hosts get none. `psr_list_hosts` shows the owner each credential and its open sessions, and every reader each machine's `localSessions` (open, live). `psr_get_tree of=sessions` lists them in one `local:<host>` group per machine.

**Install on a machine.** From a checkout of this project, pipe the credential straight from the Router into the installer, so it never shows on screen:

```bash
ssh psr@<router-host> 'cd ~/paseo-session-router && set -a && . ./.env && set +a && curl -s -X POST -H "authorization: Bearer $PSR_CLI_TOKEN" -H "content-type: application/json" --data-binary "{\"hostId\":\"mac\"}" http://127.0.0.1:8787/v1/tools/psr_issue_local_credential' | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["token"])' | sh integrations/local/install.sh https://<router>
```

The installer writes `~/.config/psr/local.token` (0600) and `local.json`, copies the bridge to `~/.local/share/psr/`, adds the user-scope MCP server `router` to Claude Code (with `mcp__router` in `~/.claude/settings.json` permissions) and `[mcp_servers.router]` to `~/.codex/config.toml` (with `default_tools_approval_mode = "approve"`). It keeps a `*.psr-bak` copy of each file it edits and installs no hooks. Claude Code and the Codex CLI pick it up in new sessions only. The ChatGPT app's Codex reloads `config.toml` at once and starts the bridge for the threads already open, each in its project folder. `sh install.sh --remove` undoes it. `sh install.sh --update` copies a newer bridge only, keeping the credential and the agents' config; sessions started after that use it. The bridge runs on the `node` the installer found (an absolute path), so rerun the installer after removing that Node.

**New tools without a restart.** An agent reads the tool list once when it connects. Every Router answer to a machine credential carries `X-Psr-Tools`, a hash of the tool list local sessions see; a bridge of version 5 declares `tools.listChanged`, compares that hash with the list it last gave its agent, and when a deploy changed the list sends `notifications/tools/list_changed`, once per change, never before the agent's first list. It notices on its next request to the Router: a Claude bridge's long poll (at least every 50 s) or any bridge's ping (every 2 minutes). Claude Code then reads the list again. Codex does so only with its `mcp_tool_list_changed` feature, which is under development and off in 0.166, so a Codex session still needs a restart for new tools. A session that started while the Router was unreachable got the cached list and is told as soon as the Router answers. Sessions on older bridges need a restart.

**Fast start.** An agent may begin its first turn before its servers have started, and Codex then leaves a server that is still starting out of that turn; a join takes a second or two over the network. So a bridge of version 6 answers `initialize` at once with what the Router last answered an agent asking the same protocol version (kept in `~/.config/psr/start.json`, with the Router's instructions), answers `tools/list` from `tools.json` until its join is done, and joins in the background; anything else it is asked waits for the join. If the Router's tool list changed since, the version check above tells the agent once the join answers (Claude Code reads it again; Codex keeps the cached list until restarted). If the Router refuses the session (409), the agent is told the list changed and reads an empty one, and tool calls say why. The first session on a machine, and an agent asking a protocol version no earlier session asked, wait for the Router as before.

**When the Router cannot be reached,** the session still starts. With a fast start its instructions are the cached ones; otherwise they say the Router is unreachable. Either way its tools come from the last list the bridge saw and answer with an error saying the Router is unreachable and not to touch shared resources until it is back.

**Trust.** The credential can only join sessions on its own machine and use the local tools. Any process on that machine that can read `~/.config/psr/local.token` can do the same, and can take the messages of that machine's Codex threads through the hook endpoint, so treat the file like an SSH key.

### Shared resources

What only one session (or a few) should use at a time and the Router cannot see in use by itself, such as an editor or a GPU. Advisory: it replaces no lock on the machine, and works only because the session instructions say to take a resource before using it.

- **Register** (owner): `psr_set_resource {resourceId, slots?, description?, remindAfterMinutes?}`. The id is `<host>/<name>` with a configured host, e.g. `mac/unreal-editor`; `slots` (default 1, at most 16) is how many sessions may hold it at once; `remindAfterMinutes` (default 120, 5–1440) is when a holder others wait behind is reminded, once. Holding has no time limit: nothing is ever taken from a holder except by the owner. (The setting was called `holdMinutes`, which read like a limit; that name is still accepted, and records stored under it read the same.) Calling it again changes only what it names; more slots go to the line at once. `psr_list_resources`, `psr_remove_resource` (holders and waiters are told) and `psr_release_resource {resourceId, memberId}` (take it back from a session; it is told) are the owner's too. At most 50 resources.
- **Take and release** (local sessions): `psr_local_take {resource, note?}` makes the session a holder if a slot is free and nobody waits, otherwise puts it in line (at most 32 per resource); taking again changes nothing. `psr_local_release` gives it back or leaves the line. `psr_local_resources` lists every resource with its holders, its line and the caller's place (`you`: `holding`, `waiting` or `null`); `psr_local_who` shows what each session holds.
- **The line is the only order.** A holder's note, a message or a forum post reserves nothing, and the Router says so wherever a session might think otherwise: the resources list names the resources in use the caller is not in line for, the answer to a message sent to a holder says that the sender is not in line, and an empty inbox says how to wait instead of looking again.
- **Your turn**: when a slot frees, the first in line holds it and the Router tells it with a notice of its own, which (unlike other notices) is pushed between turns: a Claude session or a Codex thread on the Codex daemon wakes if idle, a hook-delivered Codex thread gets it at its next turn end or prompt.
- **Waiting inside a turn**: a session that must not end its turn (a `/goal` or a loop keeps re-prompting it) would otherwise look at its inbox and the resources over and over. `psr_local_wait` holds instead: up to 100 s per call, until a message arrives or a resource the session is in line for becomes its own, then answers what arrived (marking it read, as the inbox does) or `arrived: false`, and the session calls again. While a session waits nothing is pushed to it; the call answers it. It also shows once more, marked `pushedAt`, any unexpired message the bridge already put into the session's own queue: an agent shows those only after its turn, which a session that keeps waiting never ends. The call is an event stream with progress every 20 s. 100 s because Claude Code moves an MCP tool call still running after 120 s to the background and hands the turn back to the model (`CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS`), which would start the loop again; Codex cuts a tool call at 300 s. A call the agent cancels (`notifications/cancelled`) gets no result, and one whose connection closes first takes nothing: what arrived then goes the usual way, between turns. A newer wait of the same session ends an older one, which answers `superseded` and takes nothing. At most 48 sessions wait at once.
- **Ask the holder**: `psr_local_send {to: "resource:<id>"}` goes to whoever holds it (the longest holder when it has several slots), with the usual message bounds; the message says it came through that resource. The owner may do the same with `psr_peer_send`.
- **Freed automatically**: a session that ends (its bridge says goodbye, it is silent for 30 minutes, or its machine credential is revoked) gives back what it held and leaves every line. A Codex thread whose server restarts keeps what it held. After `remindAfterMinutes` with others waiting, the holder gets one reminder and keeps the resource.
- Ended claims go a day later. Resources and claims carry no project or host on the Router, so they do not show in other readers' update streams.
- **Paseo sessions** the Router dispatches take resources too, with `psr_resources`, `psr_take {resource, note?}` and `psr_release {resource}`. Only sessions on the http channel created after this version have them (the tools are preapproved at creation, as for the forum). `psr_take` works only during a turn the Router sent (`NO_ACTIVE_TASK` otherwise), and on an owner-only host only while the session asks before acting (`RESOURCE_DENIED`); `psr_release` works any time. A session in line ends its turn; when the resource is its own, the Router sends it a turn of its own: a reply to the task it waited in, in the name of whoever assigned that task, in the same mission. It waits behind the session's current and queued turns, so it never interrupts one, and is sent once (a session that sees with `psr_take` in its own turn that the resource is now its own gets no extra turn). In the same way a Paseo holder that others wait behind for `remindAfterMinutes` gets one short reminder turn, and one the owner takes a resource back from, or whose resource the owner removes, gets one turn saying so. A turn that cannot be sent within 30 minutes (the session's daemon offline, the assigning client gone) is given up, and a turn in line then passes to the next (`undeliverable`). A Paseo session that disappears, or whose channel is revoked, gives back what it held and leaves every line. Paseo holders take no messages: `psr_local_send` to `resource:<id>` held by one is refused (`HOLDER_TAKES_NO_MESSAGES`) with who holds it, since when and what for.

### Helpers (psr_local_helper_request)

A local session cannot create sessions or send tasks. When it needs work done where it cannot go itself (another machine, or another folder there), it asks the owner for a helper: a Paseo session the Router starts for that one task, whose result comes back to the session that asked. Nothing starts without the owner's approval: of that request, or given in advance by a standing rule.

- **Ask** (local sessions): `psr_local_helpers` lists what may be asked for: the templates (each a machine, model and permission mode, with its folder), the machines with their rules, and the session's own requests. `psr_local_helper_request {template, cwd?, task, purpose?}` records a request and returns at once. `task` (at most 8 KiB, masked like every agent text) is everything the helper will know; `purpose` is one line for the owner.
- **Folder**: without `cwd` the helper works in the template's folder. With `cwd` it works in that folder with the template's provider, model and mode, where the daemon has an `autoMap` (or the folder is a configured checkout); the session then gets that folder's mapping (project and mutation domain) like any session found there. Never `/`, a top-level directory, a whole home directory, an agent's own home (`~/.claude`, `~/.codex`; a worktree below one is fine), or a folder that is a seat's or the planner's. The Router does not check that the folder exists: a creation that fails ends the request.
- **Owner-only machines** (`humanApproval`): only a template whose session sends every approval to a person (Claude `default` or `plan`, Codex `auto` or `read-only`). The helper's own requests there still go to the owner alone.
- **Decide** (owner): `psr_list_helper_requests {state?}` shows who asks, the machine, folder (and whether the request chose it: `customCwd`), model, mode and the whole task; the console lists them under 機器 › 幫手 and counts them in 需留意. `psr_decide_helper {requestId, decision, note?}`: approved, the Router creates the session and submits the task as the owner's own (mission `helper-<requestId>`), so it queues, takes the folder's writer lock and asks for approvals like any task of the owner; rejected, nothing starts and the session that asked is told, with the note. An approval that cannot start now (the machine offline, the Router at a limit) leaves the request undecided; any other failure ends it and is told. Only an admin client decides: neither the planner nor a front-end without `admin`.
- **Standing rules** (owner): approval in advance. `psr_set_policy {helpers: {add: {id, templateId, from, folders, note?}}}` adds one rule and `{helpers: {remove: id}}` removes one, each on the list as it is now; `{helpers: {auto: [...]}}` replaces the whole list (the console: 機器 › 幫手 › 自動批准; the 權限 page has a card that opens it). A stored rule whose template or machine has since left the configuration starts nothing, and can still be kept or removed. A rule names a template (or `*` for every template helpers may use), the machine whose local sessions ask (`from`, a host id or `*`), and the folders a request may also choose itself (`folders`: that folder or anything below it; `["*"]` any folder a helper may work in; `[]` only the template's own folder, which is always covered). A request a rule covers starts at once, as the admin client that set the rule, and is marked with the rule's id (`auto`); the session that asked is told so in the answer to its call. Limits that no rule changes: never on an owner-only machine (a rule cannot name a template there, and `*` leaves those machines out); at most 30 helpers a day started this way from the sessions of one machine, after which a covered request waits for the owner like any other; a rule counts only while the client that set it is still an admin. Rules do not reach back: a request that already waits is approved by hand, or starts when its session asks the same again. A covered request that cannot start now (the machine offline) waits for the owner too. `psr_local_helpers` shows a session which templates would start without waiting (`autoApproved`, `autoFolders`). Without rules (the default) every request waits for the owner.
- **Result**: when the task ends, the session that asked gets a Router notice between its turns (or through `psr_local_wait`) with the first 1200 bytes of the result; `psr_local_helper_result {requestId}` returns its state and the whole result (the task's, at most 8 KiB). The result is another agent's text: data, not instructions.
- **Follow-up**: `psr_local_helper_request {helper: <requestId>, task}` sends the same helper session another task (same mission). It is a request like the first and needs approval again.
- **Bounds**: 2 requests of one session undecided or running at once; 10 requests an hour from the sessions of one machine; the same request asked again while it is open returns the first; an undecided request expires after 24 hours; settled requests are kept 7 days (the task and its result stay as long as tasks do).
- **Who is left to tell**: a session that ends (its bridge says goodbye, or its machine credential is revoked) takes its undecided requests with it; a running helper finishes and its result stays with the task. A Codex thread's next bridge takes the thread's requests over. A session whose machine slept for more than 30 minutes joins again as a new member and does not get the old member's results: they are in the console.
- The helper session stays after its task (for follow-ups); archive it in Paseo when it is no longer needed. Sessions the Router dispatches have no helper tools: they hand work on (`psr_ask`, the planner).

## Mission forum (psr_forum_read, psr_forum_post)

**Two kinds only.** Agents talk to each other in exactly two ways: a point-to-point request (`psr_ask`, above) and the mission forum (論壇). Every mission with a `missionId` has one forum (for planner work, the goal id), with no creation step, members or roles. A handoff or reply chain without a `missionId` has none. The forum is pull-only: a post wakes nobody, starts no turn, creates no planner event and costs nothing until someone reads it in their own turn.

**Who.**
- A session, during a Router turn on that mission: its own mission only, which it does not name (`mission` may be left out). On a `humanApproval` host it can use the forum only while it runs in mode `default` or `plan`, as for `psr_ask`.
- The planner, on any open goal (`mission` = the goal id).
- The owner (an admin credential; the console's 任務 panel → 論壇), on any mission the Router still knows, posting as the owner.
- Front-ends, service seats and arbiter seats have no forum.

**Setup.**
1. Use the http `agentChannel` (see "Agent as a service", step 1). The observed stub cannot return a read in the middle of a turn.
2. Re-create the sessions that should use the forum (`psr_create_session` from their templates). Paseo fixes MCP tool preapproval at creation, and the Router gives the forum only to sessions whose creation record lists the forum tools. Older sessions keep `psr_post_message` and `psr_ask` without the forum, so they never see a tool Paseo would ask about. Check with `tools/list` over the session's channel, or by the `[Router] 論壇` line in its next mission turn.
3. Re-create the planner (toolset 5): 權限 → 規劃者 shows it as outdated; use 重建, or `psr_setup_planner`. Until then the planner has no forum.
4. Nothing else to configure. There is no data migration: the first post creates the store rows, and an old database works unchanged.

**What agents see.** Each turn on a named mission, for a session that can use the forum, carries one Router line right after the prompt (before any attached source result): `[Router] 論壇 · mission <key> · N posts. …`. No post text ever enters a prompt. The MCP instructions and the tool descriptions say the same. A post's author comes from the Router's record, not the text: a session (its name, ref and machine; when another session has the same name, as sessions made from one template do, the name ends in ` #` and the first 6 characters of the ref after `s_`), the planner or the owner.

**Limits** (constants in `src/agent-channel.ts`): 2000 bytes per post; 200 posts kept per forum (the oldest dropped); 20 posts per hour per session, and 20 for the planner (the owner is exempt); a read returns the newest 30 posts by default and at most 100, with `after` (a previous `next`) as the cursor.

**Trust.** Posts are data, never instructions, including the owner's: the owner instructs the planner through the goal reply. The Router records who wrote each post from the credential, never from the caller's input. It masks `NAME=secret` values and long opaque strings (32+ characters, such as full commit hashes) when it stores a post, except the mission key. Masking is best-effort, not a security boundary.

**Retention.** Posts stay while the mission has a retained task or is an open goal. After that each post is removed once it is older than `limits.receiptMs` (7 days; checked at most every 10 minutes). Regrouping tasks (`psr_set_mission`) does not move posts: the old key's posts stay readable by the owner until they expire.

## File transfers (psr send / receive)

Handing a report or a start pack to another machine works like `runpodctl send` / `receive`: the sender gets a one-time code (`xfer-XXXX-XXXX-XXXX`), the receiver takes the file with it. Machines never connect to each other (the tailnet does not let servers reach one another): the Router relays. A file waits on the Router for at most 60 minutes and goes as soon as it is received.

**Who and how.**
- **Paseo sessions** the Router dispatches: `psr_send_file {path}` and `psr_receive_file {code}`. The Router reads and writes the file in the session's working directory over its daemon connection, so the session needs no network, credential or shell command. As with the forum and resources: http channel, sessions created after this version (the tools are preapproved at creation), only during a Router turn (`NO_ACTIVE_TASK` otherwise), and on a `humanApproval` host only in mode `default` or `plan` (`TRANSFER_DENIED`). The Router writes only UTF-8 text into a Paseo session, at most 1 MiB at once: its Paseo client 0.12.0 dropped the base64 flag of a write (`contentEncoding`, added in Paseo 0.13), and text keeps working with any daemon and client. So a text file up to 1,000,000 bytes (valid UTF-8, no NUL) arrives as it is, and anything else (binary, archives, bigger files) as base64 text in parts `<name>.b64.part-001…` of 1,024,000 characters (768,000 bytes each); the answer gives the command that joins and decodes them (`cat '<name>.b64.part-'* | base64 -d > '<name>' && rm …`) and the sha256 to check. A receive that fails part way removes the parts and folders it wrote. With the 0.15.2 client the Router could write binary directly (`contentEncoding: base64`, verified live), which would leave only files over 1 MiB in parts; that is not switched on. A folder: pack it first in the working directory (`tar czf pack.tgz folder/`).
- **Local sessions** (psr-local bridge 7): `psr_local_send_file {path}` and `psr_local_receive_file {code}`. The bridge reads and writes the files itself, inside the session's project (its git repository, else its directory; symlinks out of it are refused), and packs a folder as `<name>.tgz`. An older bridge passes these to the Router, which answers `BRIDGE_TOO_OLD`.
- **People** on a machine with the bridge installed: `psr-xfer send <file or folder>` and `psr-xfer receive <code> [folder]` (installed by `install.sh` as `~/.local/bin/psr-xfer`), with that machine's credential. The owner's own credential never has to leave the Router host.
- Files land in `psr-inbox/<code>/<name>` of the receiver's working directory or project (`psr-xfer receive`: the folder given, default here). Nothing is ever replaced.

**Received means confirmed.** A receiver downloads the file (`GET /v1/transfers/<code>`), checks its sha256, saves it, and only then confirms (`POST /v1/transfers/<code>/received`): the code is spent and the bytes go. A receiver that cannot keep the file (it exists already, the disk is full, the sha256 is wrong) gives it back (`…/release`) and the code works again at once; a download that breaks off gives it back by itself. While one receiver takes a file, another gets `TRANSFER_BUSY`; one that neither confirms nor gives it back within 10 minutes lets the code work again.

**Limits** (constants in `src/transfers.ts`): 100 MB per file; 2 GB of files waiting, together; the Router's disk keeps 2 GB free besides them; 30 files an hour per sender; codes expire after 60 minutes; records (no codes: only their sha256 is stored) are kept a day after a file is received or expires. Reads and writes over the Paseo relay go one at a time, since a whole file passes through the Router's memory.

**Credentials never travel.** The Router refuses (`SECRET_REFUSED`) a file whose path looks like a credential (`.env*` except `.env.example`, `*.pem`, `*.key`, `id_rsa`/`id_ed25519`, `credentials*`, anything under `.ssh`, `.aws`, `.claude`, `.codex`, `.paseo`, `~/.config/psr`) or whose content carries one (a private key, a Router credential, a Paseo pairing link, `sk-…`, GitHub, Slack, AWS and Google keys, `NAME_KEY=…` lines). A `.tar`, `.tgz` or `.tar.gz` is checked entry by entry, names and contents. Unlike the forum it refuses instead of masking, since a masked file is a broken one; it is narrower than the forum's masking, which would catch every hash in a report.

**HTTP** (machine credentials and the owner; the bytes stream to and from `<dataDir>/transfers`, mode 0600, never through the 64 KiB JSON reader): `POST /v1/transfers?name=<name>` with `application/octet-stream` (and `X-Psr-Size` when the body is chunked) returns the code; `GET /v1/transfers/<code>` returns the bytes with `X-Psr-Name`, `X-Psr-Sha256`, `X-Psr-Code` and `X-Psr-From`; `POST /v1/transfers/<code>/received` or `/release`. A bridge sends its `Mcp-Session-Id` so the record names the session. `psr_list_transfers` (owner) lists every file: name, size, sha256, sender, receiver, mission and state.

**Deploy.** Nothing to configure. Re-create the Paseo sessions that should send or receive files; run `install.sh --update` on each machine with the bridge (it also installs `psr-xfer`); Claude Code sessions see the new tools without a restart, Codex sessions after one.

## Provider logins (psr_check_logins)

Sessions on a machine stop working when the provider's login there runs out: a Claude subscription login made with `/login` on a server lasts about a month and cannot be renewed past that. `psr_check_logins` (admin; the console's 檢查登入 in 機器, and 重新檢查這台 in a machine's detail) asks every online daemon, or those of `hostId`, for Paseo's own provider diagnostic, Claude then Codex, about 3 s each. The Router keeps only whether the provider is logged in, the method, the plan, when the login expires, the version and the daemon's status: the report's account, organization and paths are dropped, and no credential passes through the Router. Offline daemons keep their last check.

`psr_list_hosts` gives each machine's `logins`, read against now: `ok`, `expiring` (within 7 days), `expired`, `logged_out`, `failed` (a turn there since the last check ended with a login error), `unverified` (Codex: its diagnostic reports no login, only that it is ready), `unknown` (the check failed) or `unchecked`. A turn whose whole reply is a login error (`Failed to authenticate…`, `Not logged in · Please run /login`) fails like a quota notice, and the session shows 登入失效 until a turn there completes or a check finds the login working again. To renew, the owner runs one command in their own terminal and the console only shows it (with a copy button) on a login that has run out or expires within 7 days: `psr-login <hostId> claude` runs `claude auth login --claudeai` on that machine as the user Paseo runs as (open the link, paste the code back into the terminal), `psr-login <hostId> codex` runs `codex login --device-auth` (open the link, enter the short code; no callback URL). Then check again. No code, link or token passes through the Router, and the Router has no way to run commands on the machines. `psr-login` holds this deployment's ssh details, so it lives with the owner (`.state/login/psr-login`, installed as `~/.local/bin/psr-login`); `psr-login --check` shows every machine is reachable with both CLIs, `--print` shows a command without running it. Server logins are renewed monthly by hand; long-lived setup tokens are not used.

## Authoritative external Frontier

A configured `frontierCommand` replaces local Frontier storage. Example using the included independent file primary:

```json
{
  "frontierCommand": {
    "command": "/usr/bin/python3",
    "args": ["/opt/paseo-session-router/scripts/frontier-file-bridge.py", "--root", "/var/lib/paseo-session-router/frontier-primary"],
    "timeoutMs": 5000
  }
}
```

Its request protocol is one JSON object:
- read: `{operation:"get", workspaceId, projectId, hostId}`;
- CAS: `{operation:"compare_and_swap", workspaceId, expectedRevision, next}`.

Reply is the validated Frontier object; nonzero exit is a failed command. The file bridge uses flock + a fixed temporary file + fsync + replace, stores no historical snapshots and has a 2,000-workspace registration bound. This is **not native worklog format**. A separate adapter must translate the existing worklog version's true ownership/CAS operations; do not overwrite its files with this helper.

## Artifact verifier

`artifactVerifier` uses the same administrator-defined executable/args pattern. It receives `{operation:"verify", artifact, target:{hostId,sessionRef,cwd}}`. Successful output must be `{accessVerified:true,targetSessionRef,evidence}`. The verifier must actually check from the target environment using trusted configuration. User-supplied URLs or paths must not cause unbounded network access or shell interpolation. No generic network-fetch verifier is shipped.

## HTTP exposure and credentials

Bind loopback and use an HTTPS reverse proxy with the exact `publicOrigin`. Only explicitly allowed Host/Origin values are accepted. Token credentials are >=32 bytes and per-client unique; create them with `scripts/generate-secrets.mjs`, store with mode0600, and inject through environment variables. Never check them into source or put them in URLs.

The browser stores the console token in sessionStorage for that tab; it is not an HttpOnly-cookie login. Serve the UI only on a trusted origin, keep CSP, and do not host untrusted scripts there. This is a single-owner operator console, not a shared SaaS authentication system. Revoking a credential is distinct from stopping its admitted tasks. Rotate a revoked client using a new registration ID/token and an explicit authorization decision rather than editing the DB casually.

## Console weather

The console's sky follows one place: its clock, its seasons and, with coordinates, its weather. Set it in the configuration:

```json
"weather": { "name": "Berlin", "timezone": "Europe/Berlin", "latitude": 52.52, "longitude": 13.405 }
```

- `name` is what the clock shows (1–40 characters); `timezone` is an IANA time zone; `latitude` and `longitude` come together or not at all. South of the equator the seasons turn six months.
- With coordinates, when a signed-in console asks (`GET /v1/weather`), the Router fetches the current weather from `https://api.open-meteo.com` at most once every 10 minutes and caches it, so every viewer sees the same sky; the request carries only those coordinates. Without outbound HTTPS to that host the console simply shows no weather.
- Without coordinates, the clock and seasons follow `timezone` and nothing is fetched.
- Without `weather` (the default, and the demo), the Router makes no outside request at all, and the console uses the viewer's own clock and shows no weather.

Any sky can be previewed in the console: `?sky=clear|cloudy|overcast|fog|drizzle|rain|snow|storm`, `?hour=0–24`, `?season=spring|summer|autumn|winter`.

## Storage and retention

Default 64 unfinished tasks, 200 ordinary terminal receipts / seven days, 10,000 outbox records / 24 hours. Live dependencies and held writer locks protect their task metadata; these protected records can temporarily exceed the ordinary receipt target and are bounded by the active-task and handoff budgets. Mission forum posts (at most 200 per forum) stay while their mission is live; after that each post is removed once it is older than `receiptMs` (see "Mission forum"). Full raw timelines are not mirrored. An expired event cursor forces resynchronization.

Every SQLite commit waits for the disk (`synchronous=FULL`), and the Router's request handling waits with it, so the Router avoids writes that carry nothing new. Directory sync (every tick, 2 s by default) keeps when it last saw each session and daemon in memory and writes their records only when something else about them changed, or once a minute to keep the stored time recent. Before this, an unchanged fleet of 23 sessions and 4 daemons cost about 9 writes a second, and on a slow, swapping disk requests stalled for seconds.

SQLite reuses freed pages; garbage collection is a logical bound, not a promise that the filesystem file immediately shrinks. The log collector/journald should have size and retention limits. The program does not log complete prompts or results; demo startup prints demo credentials for local use only. Back up SQLite through a consistent backup method or with the stopped service, not by copying a live WAL database file alone.

Files waiting to be received live in `<dataDir>/transfers` (see "File transfers"): at most 2 GB together, each gone once received or after 60 minutes, and bytes no record names (an upload cut off by a restart) go at the next check.

Do not automatically clean Paseo history on the assumption that Router retention also controls provider storage. It does not.
