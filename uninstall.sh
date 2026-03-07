#!/usr/bin/env bash
# uninstall.sh — Remove Mindful Connections and restore internet access.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UUID="mindful-connections@gemini.dad"
INSTALL_DIR="$HOME/.local/share/mindful-connections"
EXT_DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"
SLEEP_HOOK_DST="/usr/lib/systemd/system-sleep/mindful-connections"
SUDOERS_FILE="/etc/sudoers.d/mindful-connections"

echo "=== Mindful Connections — Uninstaller ==="

# Unblock internet first
echo "[1/4] Unblocking internet..."
sudo python3 "$INSTALL_DIR/internet_controller.py" --action unblock || true

# Remove extension
echo "[2/4] Removing extension..."
gnome-extensions disable "$UUID" 2>/dev/null || true
rm -rf "$EXT_DEST"

# Remove sleep hook and sudoers
echo "[3/4] Removing suspend hook and sudoers..."
sudo rm -f "$SLEEP_HOOK_DST"
sudo rm -f "$SUDOERS_FILE"

# Remove installed backend and state
echo "[4/4] Removing installed backend..."
rm -rf "$INSTALL_DIR"
sudo rm -f /tmp/mindful_connections_state.json

echo ""
echo "✅  Uninstalled. Restart GNOME Shell to complete removal."
