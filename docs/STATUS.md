# Implementation status — 0.3.0

## Tested deployment

Since October 2026 one Router has run on a Linux server (a systemd user service, reachable only over a tailnet through `tailscale serve`) and driven six Paseo daemons: a macOS workstation (the Paseo app) and five Linux servers (systemd user services that start at boot). Every daemon is reached through the Paseo relay with end-to-end encryption to the daemon key pinned from its pairing link; none is reached over SSH. Three of the servers are owner-only hosts, where every approval goes to the owner; one of them trades live and is kept to paper trading by its owner. Paseo 0.15.2 runs on every machine and the Router uses the 0.15.2 SDK. The servers are tagged tailnet nodes that can reach nothing but the Router's HTTPS port.

## Verified on real machines

- **Paseo adapter:** directory listing across all six daemons, template creation, send, turn correlation and results (a 66-chunk streamed reply byte-identical to Paseo's timeline), FIFO queueing (a busy session is never interrupted), permission wait, allow and deny, out-of-band pause and resume, cross-host routing without cross-talk, turns to sessions Paseo 0.15 reports as `closed`, and cancellation of the current turn (through the daemon client's `cancelAgent`, also used by a front-end). A provider quota message, or a login that stopped working, ends a turn as a normal reply and is reported as `failed` with that notice.
- **Agent channel:** `observed` and `http`: mid-turn progress and questions with the controller's answer as the next turn; `psr_ask` services; the mission forum, across machines; shared resources for Paseo sessions; files (`psr_send_file`, `psr_receive_file`).
- **Local sessions (psr-local bridge 7):** Claude Code, the Codex CLI and Codex threads on the Codex daemon join from their repository or directory; branch forums; messages between sessions delivered between turns and never during one (Claude to Claude, Claude and Codex through hooks, Codex through `codex queue`); shared resource queues (an editor on the workstation, a GPU); new tools without a restart in Claude Code.
- **File transfers:** a 5 MB file from the workstation (`psr-xfer`) to a Paseo session on a Linux server and back, byte-identical; 100 MB over HTTP locally with the Router using about 20 MB of memory.
- **Policy:** levels L0–L4 and who answers each; owner-only hosts, where only the owner sends work to a session whose actions the owner does not approve (`OWNER_ONLY_TARGET`); front-end ceilings; the planner running on the Router's machine.
- **Console:** the 3D overview and the machines, tasks, relations and policy views against the live fleet: provider logins (`psr_check_logins`), creating sessions from templates, resuming a paused session, local sessions and their messages, machine credentials, shared resources and file transfer records.

## Not yet accepted end to end

- **Front-end platforms.** Grokbot, dot and Muse each have their own scoped credential, exercised over HTTP and MCP. The platforms themselves are `not_tested`: their accounts, connector import, OAuth and mobile write permissions.
- **A reboot.** The Linux daemons are set to start at boot and their stop and start were tested, but no machine has been rebooted to prove it. On macOS the Paseo app must be among the login items.

## Known limits

- **Files into a Paseo session** go as UTF-8 text when they are text up to 1 MB, otherwise as base64 parts the session joins with the command it is given (the 0.12 SDK could not write binary; the 0.15.2 SDK can, but direct binary writes are not switched on).
- **Codex** sessions see tools added to the Router only after a restart (Codex's `mcp_tool_list_changed` is off).
- **Logins:** the Router reads Claude's login and its expiry from Paseo's diagnostic; Codex reports no login there, so a Codex login that stopped working shows only when a turn fails. Claude logins made with `/login` on a server last about a month and must be renewed on that machine.
- **Agents do not start sessions:** the owner, the planner (for goals) and front-ends with `create` do. A Paseo session and a local session have no direct channel; the forum of a mission is for Paseo sessions, a branch forum for local ones.
- **Identity** is the daemon key pinned from the pairing link; an SSH-tunnelled daemon (none in use) relies on an administrator-configured marker.
- **Timeline recovery** is conservative: no turn id or terminal evidence means unresolved, never inferred complete.
- **Sessions on owner-only hosts** use the provider login stored on that machine; a Claude subscription login made there lasts about a month. `psr-login` (a small script the owner keeps with their ssh details) renews it from the owner's terminal; the console shows the command.

## Explicit changes from the design

1. Native TypeScript backend + built-in SQLite; no runtime dependency for the core. Compiled distribution is included.
2. Web uses native JS/CSS (and a vendored three.js for the 3D overview) instead of React/React Flow. Typed topology is independent of presentation. Layout positions are session-local, not persisted preferences.
3. MCP is a minimal tested stateless tools-only implementation, not the official SDK. Version 2025-06-18 only. No OAuth server, no subscriptions/resources/sampling, no claim of official/vendor conformance certification.
4. Directory observation uses full bounded polling; active-task timelines are subscribed. No token-level permanent mirror.
5. Query matching covers configured role/title/path and explicit bindings. It does not index Frontier text automatically or maintain semantic vector search/routing-context conversations.
6. Frontier is either local authoritative state or an external CAS bridge. No second independent master. The included JSON bridge is functional but is not a native adapter to the user's prior worklog package.
7. Files move only as one-time-code transfers through the Router (60 minutes at most, up to 100 MB); no folder synchronization or URL fetching. Artifact references on a handoff still require a configured trusted verifier.
8. No push into the front-ends' chats; they read updates and their inbox. Local sessions get messages pushed between their turns.
9. Single-owner/single-controller; no HA, shared-NFS SQLite or multiple tenants. Existing v0.1 data is not auto-migrated.
10. Native subagent edges are shown only if the adapter receives verifiable parent metadata; hidden provider-private subagents are not guessed.
11. Bounded graph responses ask for narrower filters when truncated instead of pretending an incomplete graph is complete.
12. Deployment files are examples. The live machines' configuration (hosts, daemons, templates, credentials) lives in `router.local.json` and `.env` on the Router host, outside this package.
