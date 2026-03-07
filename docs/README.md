<a href="url"><img src="splash.png" align="left" width="60%" ></a>

# Mindful Connections — GNOME Proof of Concept

> **This is an open-source proof of concept for GNOME Shell.**
> It demonstrates a timer-gated internet access system implemented entirely as a native GNOME extension + Python backend, with no third-party GUI framework required.
>
> A full cross-platform version (Linux, Windows, macOS) exists separately as a private project.

---

## What it does

Mindful Connections enforces intentional internet use by requiring a short pause before web browsing is allowed. HTTP/HTTPS traffic (ports 80 and 443) is blocked at the `iptables` level; everything else — email, SSH, background updates — is unaffected.

### Timer flow

```
LOCKED -> [click] -> WARM_UP (3 min, red) -> OPEN (20 min, green) -> COOL_DOWN (1 min) -> LOCKED
```

| Icon | State | Meaning |
|------|-------|---------|
| White disc + black dot | LOCKED | Click to start |
| Red draining pie | WARM_UP | Mandatory pause — wait for it |
| Green draining pie | OPEN | Browsing allowed |
| Black disc filling white | COOL_DOWN | Buffer before you can restart |

All timers are configurable via the in-panel menu during the OPEN state. Changes take effect on the next session.

![screenshot 1](Screenshot1.png)
![screenshot 2](Screenshot2.png)

---

## Architecture

```
gnome_extension/
  extension.js          GNOME Shell panel button, Cairo icon drawing, menu
  metadata.json         Extension manifest (UUID, compatible shell versions)

backend/
  mindful_timer.py      Daemon: drives state machine, reads/writes state file
  internet_controller.py  iptables wrapper (Linux only for this PoC)
  on-sleep.sh           systemd-sleep hook: locks on suspend/hibernate

install.sh              One-shot installer (copies backend, links extension, sudoers)
uninstall.sh            Full removal, restores internet access
```

The GNOME extension and Python daemon communicate through a JSON state file at `/tmp/mindful_connections_state.json`. The extension polls it every second and repaints a Cairo canvas. The daemon runs as a detached subprocess under `sudo` (passwordless, scoped to the timer script only via sudoers).

---

## Requirements

- **GNOME Shell** 42-47
- **Python 3** (standard library only — no pip dependencies)
- **iptables**
- Linux (tested on Debian/Ubuntu/Fedora with systemd)

---

## Installation

```bash
git clone https://github.com/lhdharris/mindful-connections-gnome.git
cd mindful-connections-gnome
./install.sh
```

Then restart GNOME Shell:
- **X11:** press `Alt+F2`, type `r`, press Enter
- **Wayland:** log out and log back in

Look for a white circle in the top-right of your GNOME panel.

## Uninstall

```bash
./uninstall.sh
```

This removes the extension, backend scripts, sudoers entry, and sleep hook, and immediately restores internet access.

---

## How it works in detail

1. `install.sh` copies the Python backend to `~/.local/share/mindful-connections/`, symlinks the extension into `~/.local/share/gnome-shell/extensions/`, and writes a narrowly-scoped sudoers entry so the extension can invoke the timer script as root without a password prompt.
2. Clicking the panel button calls `sudo python3 mindful_timer.py --action start`, which sets `iptables` rules and writes the initial state, then spawns a detached daemon.
3. The daemon drives the full `WARM_UP -> OPEN -> COOL_DOWN -> LOCKED` cycle, unblocking/reblocking `iptables` at each transition.
4. A `systemd-sleep` hook ensures the timer locks immediately on suspend or hibernate.
5. The GNOME extension reads the state file every second, repaints the Cairo icon, and sends GNOME notifications on state changes.

---

## Status and limitations

This is a **proof of concept**, not a hardened security tool. A determined user can trivially bypass it (editing the state file, removing iptables rules directly, etc.). The intent is habit formation, not enforcement.

Known limitations:
- Requires `iptables` (not `nftables`). Systems using nftables exclusively will need adaptation.
- GNOME Shell 48+ may require extension API updates (the `imports.gi.*` style is legacy from GNOME 42-45 era).
- No GNOME Extensions website listing — install manually.

---

## License

MIT — see [LICENSE](LICENSE).

Contributions welcome. If you adapt this for nftables, GNOME 48+, or other desktop environments, please open a PR.
