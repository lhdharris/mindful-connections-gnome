#!/usr/bin/env bash
# update.sh — Deploy code changes without touching your settings
#
# Copies backend scripts and resources to the installed location.
# Does NOT reset state, wipe config, re-lock internet, or touch sudoers.
# Safe to run while the extension is active.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="$HOME/.local/share/mindful-connections"
EXT_SOURCE="$SCRIPT_DIR/gnome_extension"
SLEEP_HOOK_SRC="$SCRIPT_DIR/backend/on-sleep.sh"
SLEEP_HOOK_DST="/usr/lib/systemd/system-sleep/mindful-connections"

if [ ! -d "$INSTALL_DIR" ]; then
    echo "Error: $INSTALL_DIR not found — run install.sh first." >&2
    exit 1
fi

echo "=== Mindful Connections — Update ==="
echo ""

# 1. Backend Python scripts
echo "[1/3] Updating backend scripts..."
cp "$SCRIPT_DIR/backend/mindful_timer.py"     "$INSTALL_DIR/"
cp "$SCRIPT_DIR/backend/internet_controller.py" "$INSTALL_DIR/"
chmod +x "$INSTALL_DIR/mindful_timer.py" "$INSTALL_DIR/internet_controller.py"
cp -r "$SCRIPT_DIR/resources" "$INSTALL_DIR/"
echo "      Done: $INSTALL_DIR"

# 2. Sleep hook (requires sudo; skip if unchanged)
echo "[2/3] Checking sleep hook..."
NEW_HOOK="$(sed "s|__INSTALL_DIR__|$INSTALL_DIR|g" "$SLEEP_HOOK_SRC")"
CURRENT_HOOK="$(cat "$SLEEP_HOOK_DST" 2>/dev/null || true)"
if [ "$NEW_HOOK" != "$CURRENT_HOOK" ]; then
    echo "      Hook changed — updating (will prompt for sudo)..."
    echo "$NEW_HOOK" | sudo tee "$SLEEP_HOOK_DST" > /dev/null
    sudo chmod 755 "$SLEEP_HOOK_DST"
    echo "      Updated: $SLEEP_HOOK_DST"
else
    echo "      Unchanged, skipped."
fi

# 3. Recompile GSettings schema (no-op if unchanged)
echo "[3/3] Recompiling GSettings schema..."
glib-compile-schemas "$EXT_SOURCE/schemas/" || true
echo "      Done."

echo ""
echo "Update complete."
echo ""
echo "To pick up JS changes, reload the extension:"
echo "  X11:    Alt+F2 → r → Enter"
echo "  Wayland: log out and back in"
