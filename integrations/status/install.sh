#!/bin/sh
# Installs psr-stat, the reporter that tells the Paseo Session Router how this machine is doing (CPU, load, memory, swap,
# disk space; nothing else: see psr-stat.py), and starts it as a service of the user who runs this. No root is needed.
# The machine's status credential comes on stdin, straight from psr_issue_stat_credential, so it never shows on screen:
#   <the Router's psr_issue_stat_credential for this host, its token only> | sh install.sh https://<router>
# The credential can report this machine's figures and do nothing else, and the Router sends nothing back through it.
# What it writes:
#   ~/.config/psr/stat.token (0600), stat.json          the credential and the Router's address
#   ~/.local/share/psr/psr-stat.py                      the reporter (python3, standard library only)
#   Linux: ~/.config/systemd/user/psr-stat.service      started now and at every boot (with lingering, see below)
#   macOS: ~/Library/LaunchAgents/local.psr.stat.plist  started now and at every login
# The reporter is the copy next to this file when this file sits in a folder that is yours alone (a checkout); otherwise it
# is fetched from the Router. An install that fails changes nothing: one that already works here keeps working.
# --no-start after the address: write the files only (to look at them first); it then says how to start.
# Undo everything: sh install.sh --remove      (then revoke the credential on the Router: psr_revoke_stat_credential)
#   --remove --no-stop: delete the files only and leave the service manager alone.
set -eu
CONF="$HOME/.config/psr"; SHARE="$HOME/.local/share/psr"; HERE=$(cd "$(dirname "$0")" && pwd)
UNIT="$HOME/.config/systemd/user/psr-stat.service"; LABEL=local.psr.stat; PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
TOKEN="$CONF/stat.token"; ADDRESS="$CONF/stat.json"; SCRIPT="$SHARE/psr-stat.py"
OS=$(uname -s)
user_systemd() { command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; }

if [ "${1:-}" = "--remove" ]; then
    if [ "${2:-}" != "--no-stop" ]; then
        if [ "$OS" = Darwin ]; then launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
        elif user_systemd; then systemctl --user disable --now psr-stat.service >/dev/null 2>&1 || true; fi
    fi
    rm -f "$UNIT" "$PLIST" "$SCRIPT" "$SCRIPT.new" "$SCRIPT.prev" "$TOKEN" "$TOKEN.prev" "$ADDRESS" "$ADDRESS.prev"
    if [ "${2:-}" != "--no-stop" ] && [ "$OS" != Darwin ] && user_systemd; then systemctl --user daemon-reload >/dev/null 2>&1 || true; fi
    echo "Removed psr-stat. Revoke this machine's status credential on the Router with psr_revoke_stat_credential."
    exit 0
fi

URL="${1:?Usage: <status credential on stdin> | sh install.sh https://<router> [--no-start]   (or: sh install.sh --remove)}"
URL=${URL%/}
START=yes; [ "${2:-}" = "--no-start" ] && START=no
case "$OS" in Linux|Darwin) ;; *) echo "psr-stat measures Linux and macOS only (this is $OS)" >&2; exit 2 ;; esac
# the system's own python3 where there is one that runs (it stays when a version manager's goes); else the one on PATH
new_enough() { [ -n "$1" ] && [ -x "$1" ] && "$1" -I -c 'import sys; sys.exit(0 if sys.version_info >= (3, 6) else 1)' >/dev/null 2>&1; }
PY=""
if [ "$OS" = Linux ] && new_enough /usr/bin/python3; then PY=/usr/bin/python3
else found=$(command -v python3 2>/dev/null || true); if new_enough "$found"; then PY=$found; fi; fi
[ -n "$PY" ] || { echo "python3 (3.6 or newer) is required" >&2; exit 1; }
# the Router's address is a host and maybe a port: https, or http for this machine itself
"$PY" -I -c 'import re, sys; sys.exit(0 if re.match(r"^(https://[A-Za-z0-9.-]+(:\d+)?|http://(127\.0\.0\.1|localhost)(:\d+)?)$", sys.argv[1]) else 1)' "$URL" \
    || { echo "The Router address must be https://<host>[:port] and nothing more" >&2; exit 2; }
# these paths go into a service file: plain characters only
"$PY" -I -c 'import re, sys; sys.exit(0 if all(re.match(r"^[A-Za-z0-9_./@+ -]+$", a) for a in sys.argv[1:]) else 1)' "$HOME" "$PY" \
    || { echo "The home folder or the path of python3 has characters a service file cannot carry: not installed" >&2; exit 2; }

token=""
if [ ! -t 0 ]; then read -r token || true; fi
case "$token" in psrs_?*) ;; *) echo "stdin did not carry a psrs_ status credential; nothing stored" >&2; exit 2 ;; esac
mkdir -p "$CONF" "$SHARE"; chmod 700 "$CONF"

# the reporter, first as a file on the side: checked before anything that works is replaced
rm -f "$SCRIPT.new"
if [ -f "$HERE/psr-stat.py" ] && "$PY" -I -c 'import os, sys; st = os.stat(sys.argv[1]); sys.exit(0 if st.st_uid in (os.getuid(), 0) and not st.st_mode & 0o022 else 1)' "$HERE"; then
    cp "$HERE/psr-stat.py" "$SCRIPT.new"
else
    # never a file somebody else could have put next to this one (in /tmp, say): the Router's own, straight, no redirect
    "$PY" -I -c 'import sys, urllib.request as u
no_redirect = type("NoRedirect", (u.HTTPRedirectHandler,), {"redirect_request": lambda *a, **k: None})
data = u.build_opener(u.ProxyHandler({}), no_redirect).open(sys.argv[1], timeout=20).read()
open(sys.argv[2], "wb").write(data)' "$URL/integrations/status/psr-stat.py" "$SCRIPT.new" 2>/dev/null \
        || { rm -f "$SCRIPT.new"; echo "Could not fetch the reporter from $URL: nothing was changed" >&2; exit 1; }
fi
"$PY" -I "$SCRIPT.new" --once --print >/dev/null 2>&1 || { rm -f "$SCRIPT.new"; echo "The reporter cannot measure this machine with $PY: nothing was changed" >&2; exit 1; }

# from here the new install replaces the old one; what was there is kept aside until the new one has reported
HAD=no; [ -f "$SCRIPT" ] && HAD=yes
for f in "$TOKEN" "$ADDRESS" "$SCRIPT"; do if [ -f "$f" ]; then cp -p "$f" "$f.prev"; else rm -f "$f.prev"; fi; done
undo() {
    for f in "$TOKEN" "$ADDRESS" "$SCRIPT"; do if [ -f "$f.prev" ]; then mv -f "$f.prev" "$f"; else rm -f "$f"; fi; done
    if [ "$HAD" = no ]; then rm -f "$UNIT" "$PLIST"; fi
}
(umask 077; printf '%s\n' "$token" > "$TOKEN"); unset token
chmod 600 "$TOKEN"
(umask 077; printf '{"url":"%s"}\n' "$URL" > "$ADDRESS")
mv -f "$SCRIPT.new" "$SCRIPT"; chmod 644 "$SCRIPT"

if [ "$OS" = Darwin ]; then
    mkdir -p "$(dirname "$PLIST")"
    cat > "$PLIST" <<PLIST_END
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$PY</string><string>-I</string><string>$SCRIPT</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>60</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>/dev/null</string>
  <key>StandardErrorPath</key><string>/dev/null</string>
</dict></plist>
PLIST_END
else
    mkdir -p "$(dirname "$UNIT")"
    cat > "$UNIT" <<UNIT_END
[Unit]
Description=psr-stat: this machine's status for the Paseo Session Router
After=network-online.target

[Service]
ExecStart="$PY" -I "$SCRIPT"
Restart=on-failure
RestartSec=60
Nice=10

[Install]
WantedBy=default.target
UNIT_END
fi

if [ "$START" = no ]; then
    rm -f "$TOKEN.prev" "$ADDRESS.prev" "$SCRIPT.prev"
    echo "psr-stat installed for $URL, not started (--no-start)."
    if [ "$OS" = Darwin ]; then echo "Start it: launchctl bootstrap gui/$(id -u) \"$PLIST\""; else echo "Start it: systemctl --user daemon-reload && systemctl --user enable --now psr-stat.service"; fi
    exit 0
fi

# one report now, so that a wrong address or a refused credential shows here and not in a silent service
if "$PY" -I "$SCRIPT" --once; then echo "First report accepted by $URL"
else undo; echo "The first report did not go through (see above): nothing was changed." >&2; exit 1; fi
rm -f "$TOKEN.prev" "$ADDRESS.prev" "$SCRIPT.prev"
if [ "$OS" = Darwin ]; then
    launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
    launchctl bootstrap "gui/$(id -u)" "$PLIST" || { echo "launchctl could not start it; start it by hand: launchctl bootstrap gui/$(id -u) \"$PLIST\"" >&2; exit 1; }
    echo "psr-stat is running (launchd, $LABEL): it reports once a minute, from every login on."
elif user_systemd; then
    systemctl --user daemon-reload
    systemctl --user enable --now psr-stat.service >/dev/null 2>&1 || { echo "systemd could not start it: systemctl --user status psr-stat.service" >&2; exit 1; }
    systemctl --user restart psr-stat.service >/dev/null 2>&1 || true
    echo "psr-stat is running (systemd user service psr-stat): it reports once a minute."
    # a user service stops when its user has no session left, unless the user lingers
    me=$(id -un)
    if [ "$(loginctl show-user "$me" -p Linger --value 2>/dev/null)" != yes ]; then
        loginctl enable-linger "$me" >/dev/null 2>&1 || true
        if [ "$(loginctl show-user "$me" -p Linger --value 2>/dev/null)" = yes ]; then echo "Lingering switched on for $me, so it keeps running after you log out and starts at boot."
        else echo "NOTE: it will stop when $me logs out. To keep it running and start it at boot: sudo loginctl enable-linger $me"; fi
    fi
else
    echo "No systemd user session here: the service file is written but not started." >&2
    echo "Run it some other way, for example from cron once a minute: * * * * * \"$PY\" -I \"$SCRIPT\" --once" >&2
    exit 1
fi
