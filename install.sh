#!/usr/bin/env bash
# install.sh — Set up Mindful Connections GNOME extension
# Run this once as your normal user. It will use sudo where needed.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UUID="mindful-connections@gemini.dad"
EXT_SOURCE="$SCRIPT_DIR/gnome_extension"
EXT_DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"
INSTALL_DIR="$HOME/.local/share/mindful-connections"
TIMER_SCRIPT="$INSTALL_DIR/mindful_timer.py"
CONTROLLER_SCRIPT="$INSTALL_DIR/internet_controller.py"
SLEEP_HOOK_SRC="$SCRIPT_DIR/backend/on-sleep.sh"
SLEEP_HOOK_DST="/usr/lib/systemd/system-sleep/mindful-connections"
SUDOERS_FILE="/etc/sudoers.d/mindful-connections"
USER="$(whoami)"

echo "=== Mindful Connections — Installer ==="
echo ""

# 0. Check / install dependencies
echo "[0/7] Checking dependencies..."
MISSING_PKGS=()
command -v python3 >/dev/null 2>&1 || MISSING_PKGS+=("python3")
command -v nft     >/dev/null 2>&1 || MISSING_PKGS+=("nftables")
if [ ${#MISSING_PKGS[@]} -gt 0 ]; then
    echo "      Installing missing packages: ${MISSING_PKGS[*]}"
    sudo apt-get install -y "${MISSING_PKGS[@]}"
else
    echo "      Dependencies OK (python3, nftables)."
fi

# 1. Install backend scripts
echo "[1/7] Installing backend to $INSTALL_DIR..."
mkdir -p "$INSTALL_DIR"
cp "$SCRIPT_DIR/backend/mindful_timer.py" "$INSTALL_DIR/"
cp "$SCRIPT_DIR/backend/internet_controller.py" "$INSTALL_DIR/"
chmod +x "$INSTALL_DIR/mindful_timer.py" "$INSTALL_DIR/internet_controller.py"
cp -r "$SCRIPT_DIR/resources" "$INSTALL_DIR/"
echo "      Backend installed: $INSTALL_DIR"

# 2. Install GNOME extension (symlink for easy updates)
echo "[2/7] Installing GNOME extension..."
mkdir -p "$(dirname "$EXT_DEST")"
if [ -L "$EXT_DEST" ] || [ -d "$EXT_DEST" ]; then
    rm -rf "$EXT_DEST"
fi
ln -s "$EXT_SOURCE" "$EXT_DEST"
echo "      Linked: $EXT_DEST -> $EXT_SOURCE"

# 3. Add sudoers entry (passwordless sudo for the timer script only)
echo "[3/7] Setting up sudoers (will prompt for your password)..."
SUDOERS_LINE="$USER ALL=(root) NOPASSWD: /usr/bin/python3 $TIMER_SCRIPT *"
echo "$SUDOERS_LINE" | sudo tee "$SUDOERS_FILE" > /dev/null
sudo chmod 440 "$SUDOERS_FILE"
echo "      Sudoers entry written to $SUDOERS_FILE"

# 4. Install systemd sleep hook (lock on suspend/hibernate/lid-close)
echo "[4/7] Installing suspend/hibernate lock hook..."

sudo mkdir -p "$(dirname "$SLEEP_HOOK_DST")"
sed "s|__INSTALL_DIR__|$INSTALL_DIR|g" "$SLEEP_HOOK_SRC" | sudo tee "$SLEEP_HOOK_DST" > /dev/null
sudo chmod 755 "$SLEEP_HOOK_DST"
echo "      Hook installed: $SLEEP_HOOK_DST"

# 5. Ensure internet starts in LOCKED state (apply block rules now)
echo "[5/7] Applying initial internet lock..."
sudo python3 "$TIMER_SCRIPT" --action lock || true
echo "      Internet browsing is now blocked."

# 6. Enable the extension
echo "[6/7] Enabling extension..."
gnome-extensions enable "$UUID" 2>/dev/null || true

echo ""
echo "✅  Installation complete!"
echo ""
echo "Next steps:"
echo "  1. Restart GNOME Shell:"
echo "       • On X11: press Alt+F2, type 'r', press Enter"
echo "       • On Wayland: log out and log back in"
echo ""
echo "  2. Look for a ● white circle in the top-right of your GNOME bar."
echo ""
echo "  To uninstall, run:  ./uninstall.sh"
