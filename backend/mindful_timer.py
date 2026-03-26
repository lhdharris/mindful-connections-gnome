import argparse
import json
import os
import subprocess
import sys
import time
import platform
import tempfile
from datetime import datetime, timedelta

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

DEFAULT_WAIT_SECS          = 1 * 60
DEFAULT_OPEN_SECS          = 20 * 60
DEFAULT_BUFFER_SECS        = 1 * 60
DEFAULT_LONG_BREAK_SESSIONS = 3
DEFAULT_LONG_BREAK_SECS    = 20 * 60


# ─── Config ──────────────────────────────────────────────────────────────────

def read_config() -> dict:
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE) as f:
                data = json.load(f)
            return {
                "wait_seconds":          int(data.get("wait_seconds",          DEFAULT_WAIT_SECS)),
                "open_seconds":          int(data.get("open_seconds",          DEFAULT_OPEN_SECS)),
                "buffer_seconds":        int(data.get("buffer_seconds",        DEFAULT_BUFFER_SECS)),
                "long_break_sessions":   int(data.get("long_break_sessions",   DEFAULT_LONG_BREAK_SESSIONS)),
                "long_break_seconds":    int(data.get("long_break_seconds",    DEFAULT_LONG_BREAK_SECS)),
                "routines":              data.get("routines"),
            }
        except Exception:
            pass
    return {
        "wait_seconds":        DEFAULT_WAIT_SECS,
        "open_seconds":        DEFAULT_OPEN_SECS,
        "buffer_seconds":      DEFAULT_BUFFER_SECS,
        "long_break_sessions": DEFAULT_LONG_BREAK_SESSIONS,
        "long_break_seconds":  DEFAULT_LONG_BREAK_SECS,
        "routines":            None,
    }


# ─── Routine helpers ──────────────────────────────────────────────────────────

def current_routine_active() -> bool:
    """Return True if the current wall-clock time falls in a scheduled routine slot."""
    routines = read_config().get("routines")
    if not isinstance(routines, list):
        return False
    now  = datetime.now()
    day  = (now.weekday() + 1) % 7          # Python Mon=0; convert to Sun=0
    slot = now.hour * 2 + now.minute // 30  # 0–47
    try:
        return bool(routines[day][slot])
    except (IndexError, TypeError):
        return False


def _routine_run_end() -> float:
    """Return the epoch time when the current contiguous routine block ends.

    Walks forward slot-by-slot (up to one full week) to find the last
    consecutive active slot, then returns the timestamp of its end.
    """
    routines = read_config().get("routines")
    if not isinstance(routines, list):
        return time.time()

    now  = datetime.now()
    day  = (now.weekday() + 1) % 7
    slot = now.hour * 2 + now.minute // 30

    d, s = day, slot
    for _ in range(7 * 48):          # hard limit: one full week
        nd, ns = d, s + 1
        if ns >= 48:
            ns = 0
            nd = (d + 1) % 7
        try:
            active = bool(routines[nd][ns])
        except (IndexError, TypeError):
            active = False
        if not active:
            break
        d, s = nd, ns

    # Convert (d, s) back to a wall-clock timestamp.
    # end_minutes can reach 1440 (slot 47 ends at midnight) — timedelta handles it.
    days_offset = (d - day) % 7
    end_minutes = (s + 1) * 30
    midnight    = datetime(now.year, now.month, now.day)
    end_dt      = midnight + timedelta(days=days_offset, minutes=end_minutes)

    if end_dt.timestamp() <= time.time():   # shouldn't happen, guard anyway
        end_dt += timedelta(weeks=1)

    return end_dt.timestamp()


# ─── State file ──────────────────────────────────────────────────────────────

def read_state() -> dict:
    if os.path.exists(STATE_FILE):
        try:
            with open(STATE_FILE) as f:
                return json.load(f)
        except Exception:
            pass
    return {"state": "LOCKED", "ends_at": 0, "total_seconds": DEFAULT_WAIT_SECS}


def write_state(state: str, ends_at: float = 0.0, total_seconds: float = 0.0, session_count: int = 0) -> None:
    with open(STATE_FILE, "w") as f:
        json.dump({"state": state, "ends_at": ends_at, "total_seconds": total_seconds,
                   "session_count": session_count}, f)
    try:
        os.chmod(STATE_FILE, 0o644)
    except Exception:
        pass



# ─── Internet control ─────────────────────────────────────────────────────────

def block_internet() -> None:
    get_controller().block()


def unblock_internet(retries: int = 3) -> None:
    """Unblock and verify with retries. Raises if still blocked after all attempts."""
    ctrl = get_controller()
    last_err = None
    for attempt in range(retries):
        try:
            ctrl.unblock()
        except Exception as e:
            last_err = e
        # Always verify regardless of whether unblock() raised
        if not ctrl.is_blocked():
            return
        print(f"[mindful] unblock attempt {attempt + 1}/{retries} failed — still blocked", file=sys.stderr)
        time.sleep(1)
    raise RuntimeError(
        f"unblock_internet failed after {retries} attempts. Last error: {last_err}"
    )


# ─── Uninstall script visibility ──────────────────────────────────────────────

_UNINSTALL_SRC = os.path.join(BACKEND_DIR, 'resources', 'uninstall.sh')
_UNINSTALL_DST = os.path.join(BACKEND_DIR, 'uninstall.sh')

def _show_uninstall() -> None:
    try:
        import shutil
        shutil.copy2(_UNINSTALL_SRC, _UNINSTALL_DST)
        os.chmod(_UNINSTALL_DST, 0o755)
    except Exception:
        pass

def _hide_uninstall() -> None:
    try:
        os.remove(_UNINSTALL_DST)
    except Exception:
        pass


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


def _reconcile_firewall(state: str) -> None:
    """Ensure firewall matches the recorded state. Fixes stale rules from crashes/reboots."""
    ctrl = get_controller()
    if state == "OPEN":
        if ctrl.is_blocked():
            print("[mindful] reconcile: state=OPEN but internet is blocked — unblocking", file=sys.stderr)
            ctrl.unblock()
            if ctrl.is_blocked():
                print("[mindful] reconcile: unblock failed — forcing lock", file=sys.stderr)
                lock_down()
    else:
        # LOCKED / WARM_UP / COOL_DOWN — should be blocked
        if not ctrl.is_blocked():
            print(f"[mindful] reconcile: state={state} but internet is open — blocking", file=sys.stderr)
            ctrl.block()


def _run_daemon_impl() -> None:
    state_data = read_state()
    state      = state_data.get("state", "LOCKED")
    _reconcile_firewall(state)

    if state == "WARM_UP":
        # Wait out the cooldown
        ends_at   = state_data.get("ends_at", 0)
        remaining = ends_at - time.time()
        if remaining > 0:
            time.sleep(remaining)

        # Cooldown over — unlock browsing
        cfg           = read_config()
        open_secs     = cfg["open_seconds"]
        open_until    = time.time() + open_secs
        session_count = state_data.get("session_count", 0)
        write_state("OPEN", open_until, total_seconds=open_secs, session_count=session_count)
        unblock_internet()
        _show_uninstall()

        remaining = open_until - time.time()
        if remaining > 0:
            time.sleep(remaining)

        _enter_cool_down()

    elif state == "OPEN":
        # Resume an in-progress open window (e.g. after daemon restart).
        # Always unblock — we can't assume the previous daemon left things clean.
        _show_uninstall()
        unblock_internet()
        ends_at   = state_data.get("ends_at", 0)
        remaining = ends_at - time.time()
        if remaining > 0:
            time.sleep(remaining)
        _enter_cool_down()

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


def _enter_cool_down() -> None:
    """Block internet and enter COOL_DOWN state, then transition to LOCKED."""
    _hide_uninstall()
    block_internet()

    # Re-read config here so any settings saved during OPEN take effect immediately,
    # including a reduced long_break_sessions threshold that the current count already meets.
    cfg           = read_config()
    state_data    = read_state()
    session_count = state_data.get("session_count", 0) + 1
    long_break_sessions = cfg.get("long_break_sessions", DEFAULT_LONG_BREAK_SESSIONS)

    if long_break_sessions > 0 and session_count >= long_break_sessions:
        buffer_secs   = cfg.get("long_break_seconds", DEFAULT_LONG_BREAK_SECS)
        session_count = 0  # reset counter after long break
    else:
        buffer_secs = cfg.get("buffer_seconds", DEFAULT_BUFFER_SECS)

    if buffer_secs > 0:
        ends_at = time.time() + buffer_secs
        write_state("COOL_DOWN", ends_at, total_seconds=buffer_secs, session_count=session_count)
        remaining = ends_at - time.time()
        if remaining > 0:
            time.sleep(remaining)

    lock_down(session_count)


def lock_down(session_count: int = None) -> None:
    """Force immediate transition to LOCKED (used by --action lock and sleep hook)."""
    _hide_uninstall()
    block_internet()
    if session_count is None:
        session_count = read_state().get("session_count", 0)
    write_state("LOCKED", 0, total_seconds=0, session_count=session_count)


# ─── Start action ─────────────────────────────────────────────────────────────

def action_start(in_process: bool = False) -> None:
    state_data = read_state()
    if state_data.get("state") != "LOCKED":
        print(f"Already in state {state_data['state']}, ignoring.", file=sys.stderr)
        return

    # If a routine slot is active right now, skip warm-up entirely.
    if current_routine_active():
        end_at    = _routine_run_end()
        remaining = end_at - time.time()
        if remaining > 0:
            session_count = state_data.get("session_count", 0)
            write_state("OPEN", end_at, total_seconds=remaining, session_count=session_count)
            _kill_existing_daemon()
            LOG_FILE = os.path.join(BASE_DIR, "mindful_daemon.log")
            with open(LOG_FILE, "a") as log_fd:
                subprocess.Popen(
                    [sys.executable, __file__, "--action", "daemon"],
                    stdin=subprocess.DEVNULL, stdout=log_fd, stderr=log_fd,
                    start_new_session=True,
                )
            print(f"Routine slot active — opening immediately (no warm-up).")
            return

    cfg           = read_config()
    wait_secs     = cfg["wait_seconds"]
    ends_at       = time.time() + wait_secs
    session_count = state_data.get("session_count", 0)

    write_state("WARM_UP", ends_at, total_seconds=wait_secs, session_count=session_count)
    block_internet()

    if in_process:
        # Run the daemon cycle in the calling thread (used by bundled app / tray).
        # Skips PID-file management since we're inside the parent process.
        _run_daemon_impl()
    else:
        # Spawn a detached daemon subprocess (used by the GNOME extension via sudo).
        _kill_existing_daemon()
        LOG_FILE = os.path.join(BASE_DIR, "mindful_daemon.log")
        log_fd = open(LOG_FILE, "a")
        subprocess.Popen(
            [sys.executable, __file__, "--action", "daemon"],
            stdin=subprocess.DEVNULL,
            stdout=log_fd,
            stderr=log_fd,
            start_new_session=True,
        )
        log_fd.close()

    print(f"WARM_UP started ({wait_secs}s cooldown).")


# ─── Routine check (called on wake-from-sleep) ────────────────────────────────

def action_routine_check() -> None:
    """Called by the sleep hook on system resume.

    If the current time falls within a scheduled routine slot, transition to
    OPEN for the duration of the contiguous block and spawn a daemon to manage
    the wind-down. Otherwise, ensure everything is locked.
    """
    if current_routine_active():
        end_at    = _routine_run_end()
        remaining = end_at - time.time()
        if remaining <= 0:
            lock_down()
            return
        print(f"[mindful] routine-check: routine slot active — opening until {end_at:.0f}",
              file=sys.stderr)
        session_count = read_state().get("session_count", 0)
        write_state("OPEN", end_at, total_seconds=remaining, session_count=session_count)
        _kill_existing_daemon()
        LOG_FILE = os.path.join(BASE_DIR, "mindful_daemon.log")
        with open(LOG_FILE, "a") as log_fd:
            subprocess.Popen(
                [sys.executable, __file__, "--action", "daemon"],
                stdin=subprocess.DEVNULL, stdout=log_fd, stderr=log_fd,
                start_new_session=True,
            )
    else:
        lock_down()


# ─── Entry point ──────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Mindful Connections")
    parser.add_argument("--action",
                        choices=["start", "status", "daemon", "lock", "routine-check"],
                        required=True)
    args = parser.parse_args()

    if   args.action == "start":         action_start()
    elif args.action == "status":        print(json.dumps(read_state(), indent=2))
    elif args.action == "daemon":        run_daemon()
    elif args.action == "lock":          lock_down(); print("Locked.")
    elif args.action == "routine-check": action_routine_check()
