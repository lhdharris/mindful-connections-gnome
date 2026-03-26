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

# Stop any running daemon
echo "[1/5] Stopping daemon..."
PID_FILE="$INSTALL_DIR/mindful_connections_daemon.pid"
if [ -f "$PID_FILE" ]; then
    DAEMON_PID=$(cat "$PID_FILE" 2>/dev/null || true)
    if [ -n "$DAEMON_PID" ]; then
        sudo kill "$DAEMON_PID" 2>/dev/null || true
    fi
fi
# Belt-and-suspenders: kill any remaining timer processes
sudo pkill -f "mindful_timer.py" 2>/dev/null || true

# Unblock internet
echo "[2/5] Unblocking internet..."
sudo python3 "$INSTALL_DIR/internet_controller.py" --action unblock || true

# Remove extension
echo "[3/5] Removing extension..."
gnome-extensions disable "$UUID" 2>/dev/null || true
rm -rf "$EXT_DEST"

# Remove sleep hook and sudoers
echo "[4/5] Removing suspend hook and sudoers..."
sudo rm -f "$SLEEP_HOOK_DST"
sudo rm -f "$SUDOERS_FILE"

# Remove installed backend and state files (sudo needed: root may own __pycache__ files)
echo "[5/5] Removing installed backend..."
sudo rm -rf "$INSTALL_DIR"
sudo rm -f /tmp/mindful_connections_state.json
sudo rm -f /tmp/mindful_connections_config.json

echo ""
echo "✅  Uninstalled. Restart GNOME Shell to complete removal."
