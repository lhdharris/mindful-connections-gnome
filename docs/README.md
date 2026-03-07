<p align="center">
  <img src="splash.png" alt="Mindful Connections — hand-drawn overview" width="480">
</p>

# Mindful Connections — GNOME Proof of Concept

> **Open-source proof of concept for GNOME Shell.**
> A timer-gated internet access system built as a native GNOME extension + Python backend — no third-party GUI framework required.
>
> 100% vibe coded. I'm an ideas man — feel free to improve the concept.
>
> A full cross-platform version (Linux, Windows, macOS) exists as a separate private project.

---

## What it does

Mindful Connections enforces intentional internet use by requiring a short pause before web browsing is allowed. HTTP/HTTPS traffic (ports 80 and 443) is blocked at the `iptables` level. Everything else — email, SSH, background updates — is unaffected.

### Timer flow

```
LOCKED → [click] → WARM_UP (3 min) → OPEN (20 min) → COOL_DOWN (1 min) → LOCKED
```

| Icon | State | Meaning |
|------|-------|---------|
| White disc + black dot | LOCKED | Click to start the cycle |
| Red draining pie | WARM_UP | Mandatory pause — internet still blocked |
| Green draining pie | OPEN | Browsing allowed |
| Black disc filling white | COOL_DOWN | Buffer period before you can restart |

Timers are configurable from the in-panel menu during the OPEN state. Changes take effect on the next session.

| | |
|---|---|
| ![WARM_UP state — red pie icon in GNOME panel](Screenshot1.png) | ![OPEN state — green pie icon in GNOME panel](Screenshot2.png) |
| **WARM_UP** — red draining pie, internet blocked | **OPEN** — green draining pie, browsing allowed |

---

## Architecture

```
gnome_extension/
  extension.js            GNOME Shell panel button, Cairo icon, popup menu
  metadata.json           Extension manifest (UUID, compatible shell versions)

backend/
  mindful_timer.py        State machine daemon — manages the full timer cycle
  internet_controller.py  iptables wrapper (Linux)
  on-sleep.sh             systemd-sleep hook — locks on suspend or hibernate

resources/
  uninstall.sh            Failsafe uninstaller — always present in install dir

install.sh                One-shot installer
uninstall.sh              Full removal — only surfaced during OPEN state
```

The extension and daemon communicate via a JSON state file at `/tmp/mindful_connections_state.json`. The extension polls it every second and repaints a Cairo canvas. The daemon runs as a detached subprocess via passwordless `sudo`, scoped to the timer script only.

---

## Requirements

- **GNOME Shell** 42–47
- **Python 3** (standard library only — no pip dependencies)
- **iptables**
- Linux with systemd (tested on Debian, Ubuntu, Fedora)

---

## Setup

### Install

```bash
git clone https://github.com/lhdharris/mindful-connections-gnome.git
cd mindful-connections-gnome
./install.sh
```

Then restart GNOME Shell:
- **X11:** `Alt+F2` → type `r` → Enter
- **Wayland:** log out and back in

A white circle will appear in the top-right of your GNOME panel. Click it to begin.

### Uninstall

`uninstall.sh` is only present in the install directory (`~/.local/share/mindful-connections/`) during the **OPEN** state — it appears automatically when browsing is unlocked and disappears when the session ends. Run it then:

```bash
~/.local/share/mindful-connections/uninstall.sh
```

A failsafe copy is always available at `~/.local/share/mindful-connections/resources/uninstall.sh` if you need to uninstall outside of the OPEN window.

Both scripts remove the extension, backend, sudoers entry, and sleep hook, and immediately restore internet access.

---

## How it works

1. `install.sh` copies the Python backend to `~/.local/share/mindful-connections/`, symlinks the extension into `~/.local/share/gnome-shell/extensions/`, and writes a narrowly-scoped sudoers rule.
2. Clicking the panel icon runs `sudo python3 mindful_timer.py --action start`, which applies `iptables` rules, writes the initial state, and spawns a detached daemon.
3. The daemon drives the `WARM_UP → OPEN → COOL_DOWN → LOCKED` cycle, toggling `iptables` at each transition.
4. The `systemd-sleep` hook locks the timer immediately on suspend or hibernate.
5. The extension re-reads the state file every second, repaints the Cairo icon, and fires GNOME notifications on each state change.

---

## Limitations

This is a **proof of concept**, not a hardened security tool. A determined user can bypass it trivially. The intent is habit formation, not enforcement.

- Requires `iptables`. Systems on `nftables` exclusively will need adaptation.
- GNOME Shell 48+ may require API updates — the `imports.gi.*` style is from the GNOME 42–45 era.
- Not listed on the GNOME Extensions website — manual install only.

---

## License

MIT — see [LICENSE](../LICENSE).

Contributions welcome. If you adapt this for nftables, GNOME 48+, or another desktop environment, open a PR.
