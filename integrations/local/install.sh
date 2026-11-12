#!/bin/sh
# Connects this machine's local Claude Code and Codex sessions to the Paseo Session Router through the psr-local bridge.
# The machine credential comes on stdin, straight from psr_issue_local_credential, so it never shows on screen:
#   ssh <router> '<call psr_issue_local_credential>' | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["token"])' | sh install.sh https://<router>
# What it changes (backups next to each file, *.psr-bak):
#   ~/.config/psr/local.token (0600), local.json      the credential and the Router URL
#   ~/.local/share/psr/psr-local.mjs                  the bridge
#   ~/.local/share/psr/psr-xfer.mjs, ~/.local/bin/psr-xfer   files through the Router (psr-xfer send / receive)
#   Claude Code: user-scope MCP server "router"; "mcp__router" in ~/.claude/settings.json permissions.allow
#   Codex: [mcp_servers.router] in ~/.codex/config.toml with its tools approved
# No hooks are installed by default. Claude Code sessions get messages other sessions sent them between turns through the
# bridge (Claude Code's own inbox for its servers), and so do Codex sessions on the shared Codex daemon (codex --remote
# unix://, through codex queue). Other Codex sessions read theirs with psr_local_inbox, or get them between turns once you
# add the Codex hooks: sh install.sh --hooks (then review them once in Codex; until then they do not run).
# Undo everything with: sh install.sh --remove      (the hooks only: sh install.sh --remove-hooks)
# A newer bridge and hook only, keeping the credential and the agents' config: sh install.sh --update
set -eu
CONF="$HOME/.config/psr"; SHARE="$HOME/.local/share/psr"; HERE=$(cd "$(dirname "$0")" && pwd)
CLAUDE_SETTINGS="$HOME/.claude/settings.json"; CODEX_CONFIG="$HOME/.codex/config.toml"

python_edit() { python3 -I - "$@"; }
claude_allow() { # $1 add|remove
    [ -f "$CLAUDE_SETTINGS" ] || { [ "$1" = add ] && printf '{}\n' > "$CLAUDE_SETTINGS"; } || return 0
    cp "$CLAUDE_SETTINGS" "$CLAUDE_SETTINGS.psr-bak"
    python_edit "$CLAUDE_SETTINGS" "$1" <<'EOF'
import json, sys
path, mode = sys.argv[1], sys.argv[2]
data = json.load(open(path))
allow = data.setdefault('permissions', {}).setdefault('allow', [])
if mode == 'add' and 'mcp__router' not in allow: allow.append('mcp__router')
if mode == 'remove' and 'mcp__router' in allow: allow.remove('mcp__router')
open(path, 'w').write(json.dumps(data, indent=2, ensure_ascii=False) + '\n')
EOF
}
codex_server() { # $1 add|remove, $2 node, $3 bridge
    [ -f "$CODEX_CONFIG" ] || { [ "$1" = add ] && : > "$CODEX_CONFIG"; } || return 0
    cp "$CODEX_CONFIG" "$CODEX_CONFIG.psr-bak"
    python_edit "$CODEX_CONFIG" "$@" <<'EOF'
import re, sys
try: import tomllib
except ImportError: tomllib = None  # Python before 3.11 (Ubuntu 22.04 has 3.10): written without the parse check below
path, mode = sys.argv[1], sys.argv[2]
text = open(path).read()
# drop an earlier [mcp_servers.router] table (and its subtables), then add ours
text = re.sub(r'(?ms)^\[mcp_servers\.router(\.[^\]]*)?\]\n.*?(?=^\[|\Z)', '', text).rstrip('\n') + '\n'
if mode == 'add':
    node, bridge = sys.argv[3], sys.argv[4]
    q = lambda s: '"' + s.replace('\\', '\\\\').replace('"', '\\"') + '"'
    text += f'\n[mcp_servers.router]\ncommand = {q(node)}\nargs = [{q(bridge)}]\ndefault_tools_approval_mode = "approve"\n'
if tomllib: tomllib.loads(text)  # refuse to write a config Codex could not read
else: print('  (this python3 is older than 3.11: the Codex config was not parsed before writing; the backup is next to it)')
open(path, 'w').write(text)
EOF
}
codex_hooks() { # $1 add|remove, $2 node, $3 hook script. Our hook groups are found by their command (psr-hook.mjs), never by
    # comments: Codex rewrites config.toml when a hook is reviewed. They go at the end, after every existing group, so the
    # review records of the hooks already there (keyed by event and position) stay as they are.
    [ -f "$CODEX_CONFIG" ] || { [ "$1" = add ] && : > "$CODEX_CONFIG"; } || return 0
    cp "$CODEX_CONFIG" "$CODEX_CONFIG.psr-bak"
    python_edit "$CODEX_CONFIG" "$@" <<'EOF'
import re, sys
try: import tomllib
except ImportError: tomllib = None  # Python before 3.11 (Ubuntu 22.04 has 3.10): written without the parse check below
path, mode = sys.argv[1], sys.argv[2]
EVENTS = ('SessionStart', 'UserPromptSubmit', 'Stop')
header = re.compile(r'^\s*(\[\[?)\s*([^\]]+?)\s*\]\]?\s*(#.*)?$')
blocks, cur = [], [None, None, []]  # [kind '[' or '[[', table name, lines]
for line in open(path).read().splitlines(keepends=True):
    m = header.match(line)
    if m: blocks.append(cur); cur = [m.group(1), m.group(2), [line]]
    else: cur[2].append(line)
blocks.append(cur)
ours = lambda b: any('psr-hook.mjs' in l for l in b[2] if not l.lstrip().startswith('#'))
kept, i = [], 0
while i < len(blocks):
    b = blocks[i]
    event = next((e for e in EVENTS if b[0] == '[[' and b[1] == f'hooks.{e}'), None)
    if not event: kept.append(b); i += 1; continue
    j = i + 1
    while j < len(blocks) and blocks[j][0] == '[[' and blocks[j][1] == f'hooks.{event}.hooks': j += 1
    subs = blocks[i + 1:j]
    left = [x for x in subs if not ours(x)]
    if left or not subs: kept.append(b); kept.extend(left)  # a group of ours goes whole; anything else keeps its other hooks
    i = j
text = ''.join(''.join(b[2]) for b in kept).rstrip('\n') + '\n'
if mode == 'add':
    node, hook = sys.argv[3], sys.argv[4]
    q = lambda s: '"' + s.replace('\\', '\\\\').replace('"', '\\"') + '"'
    sh = lambda s: "'" + s.replace("'", "'\\''") + "'"
    for e in EVENTS:
        text += f'\n[[hooks.{e}]]\n# psr-local: messages from other sessions, between turns only (integrations/local/install.sh --hooks)\n\n[[hooks.{e}.hooks]]\ncommand = {q(sh(node) + " " + sh(hook) + " " + e)}\ntimeout = 5\ntype = "command"\n'
if tomllib:
    data = tomllib.loads(text)  # refuse to write a config Codex could not read
    found = [e for e in EVENTS for g in data.get('hooks', {}).get(e, []) for h in g.get('hooks', []) if 'psr-hook.mjs' in h.get('command', '')]
else:  # without a parser: our hooks by their command lines, which end in the event's name
    found = [e for e in EVENTS for l in text.splitlines() if l.startswith('command = ') and 'psr-hook.mjs' in l and l.rstrip().endswith(f' {e}"')]
    print('  (this python3 is older than 3.11: the Codex config was not parsed before writing; the backup is next to it)')
assert found == (list(EVENTS) if mode == 'add' else []), found
open(path, 'w').write(text)
EOF
}

XFER_CMD="$HOME/.local/bin/psr-xfer"
xfer_cmd() { # $1 node: the psr-xfer command (send / receive files through the Router), never over a command of another program
    mkdir -p "$SHARE" "$(dirname "$XFER_CMD")"; cp "$HERE/psr-xfer.mjs" "$SHARE/psr-xfer.mjs"
    if [ -e "$XFER_CMD" ] && ! grep -q 'psr-xfer.mjs' "$XFER_CMD"; then echo "$XFER_CMD belongs to something else: not replaced (run psr-xfer as: $1 $SHARE/psr-xfer.mjs)"; return 0; fi
    printf '#!/bin/sh\nexec "%s" "%s" "$@"\n' "$1" "$SHARE/psr-xfer.mjs" > "$XFER_CMD"; chmod 755 "$XFER_CMD"
    case ":$PATH:" in *":$(dirname "$XFER_CMD"):"*) echo "psr-xfer: $XFER_CMD (psr-xfer send <file or folder> / psr-xfer receive <code>)" ;; *) echo "psr-xfer: $XFER_CMD (add $(dirname "$XFER_CMD") to PATH to run it as psr-xfer)" ;; esac
}
if [ "${1:-}" = "--update" ]; then
    [ -s "$CONF/local.token" ] && [ -s "$CONF/local.json" ] || { echo "psr-local is not installed here: run the full install first" >&2; exit 2; }
    NODE=$(command -v node) || { echo "node (18 or newer) is required" >&2; exit 1; }
    mkdir -p "$SHARE"; cp "$HERE/psr-local.mjs" "$SHARE/psr-local.mjs"; cp "$HERE/psr-hook.mjs" "$SHARE/psr-hook.mjs"
    xfer_cmd "$NODE"
    echo "psr-local bridge and hook updated in $SHARE (sessions started from now on use the bridge; running ones keep the old one)"
    exit 0
fi
if [ "${1:-}" = "--hooks" ]; then
    [ -s "$CONF/local.token" ] && [ -s "$CONF/local.json" ] || { echo "psr-local is not installed here: run the full install first" >&2; exit 2; }
    [ -d "$HOME/.codex" ] || { echo "Codex not found: nothing to do" >&2; exit 2; }
    NODE=$(command -v node) || { echo "node (18 or newer) is required" >&2; exit 1; }
    mkdir -p "$SHARE"; cp "$HERE/psr-hook.mjs" "$SHARE/psr-hook.mjs"
    codex_hooks add "$NODE" "$SHARE/psr-hook.mjs"
    echo "Codex: SessionStart, UserPromptSubmit and Stop hooks added to $CODEX_CONFIG (backup: config.toml.psr-bak)."
    echo "They run only after you review them once in Codex (it asks about new hooks); restart Codex sessions to pick them up."
    exit 0
fi
if [ "${1:-}" = "--remove-hooks" ]; then
    codex_hooks remove
    rm -f "$SHARE/psr-hook.mjs"
    echo "Removed the psr-local Codex hooks."
    exit 0
fi
if [ "${1:-}" = "--remove" ]; then
    command -v claude >/dev/null && claude mcp remove --scope user router >/dev/null 2>&1 || true
    claude_allow remove
    codex_server remove
    codex_hooks remove
    [ -e "$XFER_CMD" ] && grep -q 'psr-xfer.mjs' "$XFER_CMD" && rm -f "$XFER_CMD"
    rm -f "$SHARE/psr-local.mjs" "$SHARE/psr-hook.mjs" "$SHARE/psr-xfer.mjs" "$CONF/local.token" "$CONF/local.json" "$CONF/tools.json" "$CONF/start.json"
    echo "Removed psr-local. Revoke this machine's credential on the Router with psr_revoke_local_credential."
    exit 0
fi

URL="${1:?Usage: <credential on stdin> | sh install.sh https://<router>   (or: sh install.sh --update | --hooks | --remove-hooks | --remove)}"
case "$URL" in https://*|http://127.0.0.1*|http://localhost*) ;; *) echo "The Router URL must use https" >&2; exit 2 ;; esac
NODE=$(command -v node) || { echo "node (18 or newer) is required" >&2; exit 1; }
"$NODE" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)' || { echo "node 18 or newer is required" >&2; exit 1; }
mkdir -p "$CONF" "$SHARE"; chmod 700 "$CONF"
if [ ! -t 0 ]; then
    read -r token || true
    case "${token:-}" in psrl_*) (umask 077; printf '%s\n' "$token" > "$CONF/local.token") ;; *) echo "stdin did not carry a psrl_ machine credential; nothing stored" >&2; exit 2 ;; esac
    unset token
fi
[ -s "$CONF/local.token" ] || { echo "No credential: pipe one in (see the top of this file)" >&2; exit 2; }
chmod 600 "$CONF/local.token"
(umask 077; printf '{"url":"%s"}\n' "$URL" > "$CONF/local.json")
cp "$HERE/psr-local.mjs" "$SHARE/psr-local.mjs"; cp "$HERE/psr-hook.mjs" "$SHARE/psr-hook.mjs"
xfer_cmd "$NODE"

if command -v claude >/dev/null; then
    claude mcp remove --scope user router >/dev/null 2>&1 || true
    claude mcp add --scope user router -- "$NODE" "$SHARE/psr-local.mjs" >/dev/null
    claude_allow add
    echo "Claude Code: MCP server 'router' added for all projects (new sessions pick it up)"
else echo "Claude Code not found: skipped"; fi
if [ -d "$HOME/.codex" ]; then
    codex_server add "$NODE" "$SHARE/psr-local.mjs"
    echo "Codex: [mcp_servers.router] added (new sessions pick it up). For messages between turns: sh install.sh --hooks"
else echo "Codex not found: skipped"; fi
echo "psr-local installed for $URL"
