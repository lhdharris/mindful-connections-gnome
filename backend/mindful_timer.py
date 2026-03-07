import argparse
import json
import os
import subprocess
import sys
import time
import platform
import tempfile

# Ensure this file's directory is on sys.path so internet_controller is importable
# both when run as a script and when imported as a module from mindful_tray.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from internet_controller import get_controller

def get_base_dir():
    if platform.system() == "Windows":
        return os.path.join(os.environ.get("LOCALAPPDATA", tempfile.gettempdir()), "MindfulConnections")
    elif platform.system() == "Darwin":
        return os.path.expanduser("~/Library/Application Support/MindfulConnections")
    else:
        return "/tmp"

BASE_DIR = get_base_dir()
os.makedirs(BASE_DIR, exist_ok=True)

STATE_FILE  = os.path.join(BASE_DIR, "mindful_connections_state.json")
CONFIG_FILE = os.path.join(BASE_DIR, "mindful_connections_config.json")
PID_FILE    = os.path.join(BASE_DIR, "mindful_connections_daemon.pid")
BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))

DEFAULT_WAIT_SECS   = 3 * 60
DEFAULT_OPEN_SECS   = 20 * 60
DEFAULT_BUFFER_SECS = 1 * 60


# ─── Config ──────────────────────────────────────────────────────────────────

def read_config() -> dict:
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE) as f:
                data = json.load(f)
            return {
                "wait_seconds":   int(data.get("wait_seconds",   DEFAULT_WAIT_SECS)),
                "open_seconds":   int(data.get("open_seconds",   DEFAULT_OPEN_SECS)),
                "buffer_seconds": int(data.get("buffer_seconds", DEFAULT_BUFFER_SECS)),
            }
        except Exception:
            pass
    return {
        "wait_seconds":   DEFAULT_WAIT_SECS,
        "open_seconds":   DEFAULT_OPEN_SECS,
        "buffer_seconds": DEFAULT_BUFFER_SECS,
    }


# ─── State file ──────────────────────────────────────────────────────────────

def read_state() -> dict:
    if os.path.exists(STATE_FILE):
        try:
            with open(STATE_FILE) as f:
                return json.load(f)
        except Exception:
            pass
    return {"state": "LOCKED", "ends_at": 0, "total_seconds": DEFAULT_WAIT_SECS}


def write_state(state: str, ends_at: float = 0.0, total_seconds: float = 0.0) -> None:
    with open(STATE_FILE, "w") as f:
        json.dump({"state": state, "ends_at": ends_at, "total_seconds": total_seconds}, f)
    try:
        os.chmod(STATE_FILE, 0o644)
    except Exception:
        pass



# ─── Internet control ─────────────────────────────────────────────────────────

def block_internet()   -> None: get_controller().block()
def unblock_internet() -> None: get_controller().unblock()


# ─── Daemon loop ─────────────────────────────────────────────────────────────

def _write_pid() -> None:
    try:
        with open(PID_FILE, "w") as f:
            f.write(str(os.getpid()))
        os.chmod(PID_FILE, 0o644)
    except Exception:
        pass


def _clear_pid() -> None:
    try:
        os.remove(PID_FILE)
    except Exception:
        pass


def _kill_existing_daemon() -> None:
    """Kill any daemon whose PID is recorded in PID_FILE."""
    if not os.path.exists(PID_FILE):
        return
    try:
        with open(PID_FILE) as f:
            pid = int(f.read().strip())
        if pid != os.getpid():
            import signal
            os.kill(pid, signal.SIGTERM)
            time.sleep(0.3)
    except Exception:
        pass
    _clear_pid()


def run_daemon() -> None:
    """Long-running. Drives the full WAITING → OPEN → COOLING → LOCKED flow."""
    _write_pid()
    try:
        _run_daemon_impl()
    finally:
        _clear_pid()


def _run_daemon_impl() -> None:
    state_data = read_state()
    state      = state_data.get("state", "LOCKED")

    if state == "WARM_UP":
        # Wait out the cooldown
        ends_at   = state_data.get("ends_at", 0)
        remaining = ends_at - time.time()
        if remaining > 0:
            time.sleep(remaining)

        # Cooldown over — unlock browsing
        cfg        = read_config()
        open_secs  = cfg["open_seconds"]
        open_until = time.time() + open_secs
        write_state("OPEN", open_until, total_seconds=open_secs)
        unblock_internet()

        remaining = open_until - time.time()
        if remaining > 0:
            time.sleep(remaining)

        _enter_cool_down(cfg)

    elif state == "OPEN":
        # Resume an in-progress open window (e.g. after daemon restart)
        ends_at   = state_data.get("ends_at", 0)
        remaining = ends_at - time.time()
        if remaining > 0:
            unblock_internet()
            time.sleep(remaining)
        cfg = read_config()
        _enter_cool_down(cfg)

    elif state == "COOL_DOWN":
        # Resume a cooling period
        ends_at   = state_data.get("ends_at", 0)
        remaining = ends_at - time.time()
        block_internet()
        if remaining > 0:
            time.sleep(remaining)
        lock_down()

    else:
        block_internet()


def _enter_cool_down(cfg: dict) -> None:
    """Block internet and enter COOL_DOWN state, then transition to LOCKED."""
    block_internet()
    buffer_secs = cfg.get("buffer_seconds", DEFAULT_BUFFER_SECS)

    if buffer_secs > 0:
        ends_at = time.time() + buffer_secs
        write_state("COOL_DOWN", ends_at, total_seconds=buffer_secs)
        remaining = ends_at - time.time()
        if remaining > 0:
            time.sleep(remaining)

    lock_down()


def lock_down() -> None:
    """Force immediate transition to LOCKED (used by --action lock and sleep hook)."""
    block_internet()
    write_state("LOCKED", 0, total_seconds=0)


# ─── Start action ─────────────────────────────────────────────────────────────

def action_start(in_process: bool = False) -> None:
    state_data = read_state()
    if state_data.get("state") != "LOCKED":
        print(f"Already in state {state_data['state']}, ignoring.", file=sys.stderr)
        return

    cfg       = read_config()
    wait_secs = cfg["wait_seconds"]
    ends_at   = time.time() + wait_secs

    write_state("WARM_UP", ends_at, total_seconds=wait_secs)
    block_internet()

    if in_process:
        # Run the daemon cycle in the calling thread (used by bundled app / tray).
        # Skips PID-file management since we're inside the parent process.
        _run_daemon_impl()
    else:
        # Spawn a detached daemon subprocess (used by the GNOME extension via sudo).
        _kill_existing_daemon()
        subprocess.Popen(
            [sys.executable, __file__, "--action", "daemon"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )

    print(f"WARM_UP started ({wait_secs}s cooldown).")


# ─── Entry point ──────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Mindful Connections")
    parser.add_argument("--action",
                        choices=["start", "status", "daemon", "lock"],
                        required=True)
    args = parser.parse_args()

    if   args.action == "start":  action_start()
    elif args.action == "status": print(json.dumps(read_state(), indent=2))
    elif args.action == "daemon": run_daemon()
    elif args.action == "lock":   lock_down(); print("Locked.")
