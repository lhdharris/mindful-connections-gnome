# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

A GNOME Shell extension that enforces intentional internet use. Clicking the panel icon starts a mandatory warm-up timer before HTTP/HTTPS is unblocked. The extension and a Python backend daemon communicate via a JSON state file in `/tmp/`.

## Commands

**Install (first-time setup):**
```bash
./install.sh
```
Installs the backend to `~/.local/share/mindful-connections/`, symlinks the extension into `~/.local/share/gnome-shell/extensions/`, writes a sudoers rule, and installs a systemd-sleep hook.

**Manually test backend state machine:**
```bash
sudo python3 backend/mindful_timer.py --action start   # begin the cycle
sudo python3 backend/mindful_timer.py --action status  # dump current state JSON
sudo python3 backend/mindful_timer.py --action lock    # force LOCKED immediately
```

**Manually test firewall controller:**
```bash
sudo python3 backend/internet_controller.py --action block
sudo python3 backend/internet_controller.py --action unblock
sudo python3 backend/internet_controller.py --action status
```

**Reload the extension after JS changes** (Wayland requires a full logout):
```bash
# X11 only:
busctl --user call org.gnome.Shell /org/gnome/Shell org.gnome.Shell Eval s 'Meta.restart("Restarting…", global.context)'
# Or: Alt+F2 → r → Enter
```

**Check extension logs:**
```bash
journalctl -f /usr/bin/gnome-shell
```

**Uninstall:**
```bash
# During OPEN state (surfaced automatically):
~/.local/share/mindful-connections/uninstall.sh

# Failsafe (any time):
~/.local/share/mindful-connections/resources/uninstall.sh
```

There are no automated tests and no build step — the JS is loaded directly by GNOME Shell.

## Architecture

### Communication model
The extension (JS, GNOME Shell process) and the daemon (Python, root subprocess) never talk directly. They share two JSON files:
- `/tmp/mindful_connections_state.json` — daemon writes, extension polls every 1 second
- `/tmp/mindful_connections_config.json` — extension writes (prefs), daemon reads at session start

### State machine
`LOCKED → WARM_UP → OPEN → COOL_DOWN → LOCKED`

Driven entirely by `mindful_timer.py`. The extension only reads state; it never drives transitions except by spawning the backend via `sudo python3 mindful_timer.py --action start`.

### Privilege model
The daemon runs as root via a narrowly-scoped sudoers rule (`NOPASSWD: /usr/bin/python3 <path>/mindful_timer.py *`). The daemon spawns a detached child (`Popen`, `start_new_session=True`) to drive the async cycle, allowing the GNOME extension's `sudo` call to return immediately.

### Firewall backend
`internet_controller.py` selects a `FirewallController` at runtime:
- **`NftablesController`** — used when `nft` is in `$PATH` (Debian 12+, Ubuntu 22.04+). Creates an `ip mindful_connections` table with an `output` chain; drops the whole table to unblock.
- **`LinuxController`** — iptables fallback for older systems.
- `WindowsController` / `MacController` — stubs for the private cross-platform version; not exercised by this GNOME extension.

### Uninstall script visibility
`mindful_timer.py` copies `resources/uninstall.sh` → `<install_dir>/uninstall.sh` when entering OPEN state, and deletes it when leaving. This is the "state-gated visibility" feature — only surfaces the uninstaller when the user could actually run it without being left blocked.

## Key file paths (runtime)
| Path | Purpose |
|------|---------|
| `/tmp/mindful_connections_state.json` | Live state (state, ends_at, total_seconds) |
| `/tmp/mindful_connections_config.json` | User prefs (wait/open/buffer seconds) |
| `~/.local/share/mindful-connections/` | Installed backend |
| `~/.local/share/gnome-shell/extensions/mindful-connections@gemini.dad/` | Symlink → `gnome_extension/` |
| `/etc/sudoers.d/mindful-connections` | Passwordless sudo scope |
| `/usr/lib/systemd/system-sleep/mindful-connections` | Sleep/hibernate lock hook |

## GNOME Shell version notes
- Uses ES module syntax (`gi://`, `resource:///`, `export default class`) — requires GNOME 45+.
- Supports GNOME 45–48 (declared in `metadata.json`).
- The legacy `imports.gi.*` API is gone; do not reintroduce it.
- `_ornamentLabel` access on `PopupBaseMenuItem` is wrapped in `try/catch` because its presence varies across shell versions.
