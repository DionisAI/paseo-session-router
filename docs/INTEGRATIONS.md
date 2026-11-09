# Entry integration and acceptance

## One API, independent credentials

Grokbot / dot / Muse are server-configured client identities belonging to one owner. `originKind` is derived from the authenticated credential, never from a prompt or caller-supplied field. HTTP, MCP, Web and CLI use the same command handlers. Every client has separately revocable credentials and event cursors.

Public URL examples below are placeholders, not deployed services. Configure `publicOrigin` and a real HTTPS proxy before remote access. A private SSH network between Router and agents does not guarantee that a cloud bot can reach Router.

## HTTP connector

Base URL example: `https://router.example.com`. Headers:

```http
Authorization: Bearer <this-entry-token>
Content-Type: application/json
```

Import or implement `docs/openapi.json` only if the actual client supports that contract. `GET /openapi.json` on a running Router serves the same schema under authentication. Some connectors cannot fetch an authenticated schema automatically; provide the local schema file, not a public link with a token query string.

Example write request, after obtaining a real route ticket:

```json
{
  "routeTicket": "the-actual-ticket-for-this-client",
  "prompt": "Read the test repository README and reply with a one-line summary. Do not modify files.",
  "idempotencyKey": "acceptance-client-20261020-001",
  "busyPolicy": "queue"
}
```

Send to `POST /v1/tools/psr_submit_task`. Retrying the same user intent uses the same key. A route ticket from Grokbot cannot be submitted using dot's credential.

## Remote MCP (stateless JSON responses)

Endpoint: `/mcp`. Supported version: **2025-06-18**. Requests must accept `application/json, text/event-stream`; successful requests use JSON responses. The one exception is `psr_ask` called with an agent's session credential, which answers with `text/event-stream`: progress notifications on the call's `progressToken`, then the result. No MCP GET stream is advertised. The UI's `/v1/events` stream is a separate API.

```bash
curl -sS "$PSR_URL/mcp" \
  -H "Authorization: Bearer $PSR_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"acceptance","version":"1"}}}'
```

After initialization send `notifications/initialized`, then `tools/list` and `tools/call`. The implementation deliberately supports only its advertised tools surface. Lifecycle notification requests receive 202. Calls without IDs cannot be used to hide a write. All management tool responses report result data or structured errors; a successful JSON-RPC exchange is not necessarily a successful task.

There is **no OAuth authorization server or OAuth resource-server JWT validation** in this package. If an actual platform insists on OAuth, deploy a separately reviewed gateway or use a supported authorized computer/stdio/CLI path. A gateway must authenticate the actual owner/client, enforce scopes, and replace its external authorization token with the correct restricted internal credential. Do not add a proxy that blindly accepts arbitrary tokens. A basic TLS proxy alone does not add OAuth.

## Command/stdio MCP

On a trusted machine with Node and the project:

```json
{
  "command": "node",
  "args": ["/absolute/path/paseo-session-router/dist/src/mcp-stdio.js"],
  "env": {
    "PSR_URL": "https://router.example.com",
    "PSR_TOKEN": "inject-this-client-secret-via-your-secret-manager"
  }
}
```

This is a generic command-MCP configuration shape, not a claim about a particular platform's import UI. No SSH keys are needed on this client machine. The bridge prints JSON-RPC only on stdout.

## Real-account acceptance checklist (each platform separately)

1. Record the actual product, account/workspace, entry surface (mobile/desktop/routine), authentication method and required tools.
2. List hosts/sessions; confirm the expected scope. A read-only account must not advertise writes as operational.
3. Resolve one exact **test** session, submit an explicitly approved harmless prompt once and retain its task ID/key.
4. Read the same task from another entry. Observe the real matching turn result, not just accepted/idle.
5. Confirm ambiguous routing, busy queueing and unsupported actions return clear errors.
6. Revoke this client's credential; verify it loses access while existing work and other clients remain available.
7. Only then record that individual platform/action as tested. No platform write was exercised during this package's local build.

`skills/session-control.md` is the common operating instruction; platform files add only entry differences. Backend authorization does not rely on skill compliance.

## Notifications

Read task/update tools are implemented. `ack_updates` acknowledges consumption only; it never claims the human received a message. Provider-specific push-to-chat and scheduled routines are not configured or tested. The task's `notificationState` stays `not_configured` in this release.
