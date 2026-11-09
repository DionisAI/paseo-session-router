#!/bin/sh
# Installs the psr command and the agent guide from the Router this computer reaches over the tailnet,
# then stores this computer's Router credential in a 0600 header file. Read it before running it.
#   curl -fsSL https://<router>/integrations/cloud-shell/install.sh -o psr-install.sh && PSR_URL=https://<router> sh psr-install.sh
# The Router's address is saved next to the credential, so psr needs no PSR_URL afterwards.
set -eu
URL="${PSR_URL:-}"
[ -n "$URL" ] || { echo "Set PSR_URL to your Router, e.g. PSR_URL=https://router.example.ts.net sh psr-install.sh" >&2; exit 2; }
case "$URL" in https://*) ;; *) echo "PSR_URL must be https://…" >&2; exit 2 ;; esac
command -v curl >/dev/null || { echo "curl is required" >&2; exit 1; }
mkdir -p "$HOME/bin" "$HOME/.config/psr"
chmod 700 "$HOME/.config/psr"
(umask 077; printf '%s\n' "$URL" > "$HOME/.config/psr/url")
curl -fsSL --proto =https "$URL/integrations/cloud-shell/psr" -o "$HOME/bin/psr"
chmod 755 "$HOME/bin/psr"
curl -fsSL --proto =https "$URL/integrations/cloud-shell/AGENT.md" -o "$HOME/.config/psr/AGENT.md"
if [ -t 0 ]; then
    printf 'Router token for this computer (input hidden): '
    stty -echo; read -r token; stty echo; echo
else
    read -r token
fi
[ -n "$token" ] || { echo "No token given; nothing stored." >&2; exit 1; }
(umask 077; printf 'Authorization: Bearer %s\n' "$token" > "$HOME/.config/psr/auth-header")
unset token
echo "Installed $HOME/bin/psr and $HOME/.config/psr/AGENT.md"
case ":$PATH:" in *":$HOME/bin:"*) ;; *) echo "Add \$HOME/bin to PATH, or call $HOME/bin/psr" ;; esac
PSR_URL="$URL" "$HOME/bin/psr" psr_list_hosts
echo
