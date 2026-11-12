#!/usr/bin/env bash
# Detached Generation — installer for the SERVER half of the extension.
#
# Usage:
#   bash install.sh [sillytavern-directory]
#
# It does three things:
#   1. copies server-plugin/ into <ST>/plugins/detached
#   2. sets enableServerPlugins: true in <ST>/config.yaml (backed up)
#   3. prints the restart command (it never restarts anything by itself)
#
# The browser half of the extension is installed separately, either through
# SillyTavern's UI (Extensions -> Install extension -> this repo's URL) or by
# copying the files in this repository into <ST>/data/<user>/extensions/sillytavern-detached-generation.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ST_DIR="${1:-}"

if [[ -z "$ST_DIR" ]]; then
    # Try to auto-detect a SillyTavern checkout in the current directory or above.
    candidate="$(pwd)"
    while [[ "$candidate" != "/" ]]; do
        if [[ -f "$candidate/server.js" && -d "$candidate/src" ]]; then
            ST_DIR="$candidate"
            break
        fi
        candidate="$(dirname "$candidate")"
    done
fi

if [[ -z "$ST_DIR" || ! -f "$ST_DIR/server.js" ]]; then
    echo "Could not find a SillyTavern installation."
    echo "Usage: bash install.sh /path/to/SillyTavern"
    exit 1
fi

ST_DIR="$(cd "$ST_DIR" && pwd)"
echo "==> SillyTavern: $ST_DIR"

# 1) server plugin
mkdir -p "$ST_DIR/plugins/detached"
cp -r "$REPO_DIR/server-plugin/." "$ST_DIR/plugins/detached/"
echo "==> installed server plugin -> $ST_DIR/plugins/detached"

# 2) enable server plugins in config.yaml
CONFIG="$ST_DIR/config.yaml"
if [[ -f "$CONFIG" ]]; then
    if grep -qE '^enableServerPlugins:[[:space:]]*true' "$CONFIG"; then
        echo "==> enableServerPlugins already true"
    else
        cp "$CONFIG" "$CONFIG.bak-detached-gen"
        sed -i -E 's/^enableServerPlugins:[[:space:]]*false/enableServerPlugins: true/' "$CONFIG"
        if ! grep -qE '^enableServerPlugins:[[:space:]]*true' "$CONFIG"; then
            # key not present at all -> append it
            printf '\n# Added by sillytavern-detached-generation installer\nenableServerPlugins: true\n' >> "$CONFIG"
        fi
        echo "==> set enableServerPlugins: true (backup: $CONFIG.bak-detached-gen)"
    fi
else
    echo "!! $CONFIG not found - set enableServerPlugins: true manually."
fi

cat <<'EOF'

==> DONE. Now:
    1. restart SillyTavern (server plugins are only loaded at boot):
         cd <ST_DIR> && npm start          # or: systemctl restart st.service
    2. install the browser half:
         Extensions -> Install extension -> https://github.com/JuliusNarvasa/sillytavern-detached-generation
       (or "Install for all users" if you are an admin)
    3. open Extensions -> Detached Generation -> enable "Detached mode"
    4. verify: the server log should print "1 server plugin(s) are currently loaded"

EOF
