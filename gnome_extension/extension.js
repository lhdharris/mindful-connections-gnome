/**
 * Mindful Connections — GNOME Shell Extension
 *
 * Left-click or Right-click:
 *   LOCKED    → start timer
 *   WARM_UP   → menu (timer only)
 *   OPEN      → menu (timer only)
 *   COOL_DOWN → menu (timer only)
 *
 * States:
 *   LOCKED    — white disc + black dot.
 *   WARM_UP   — red pie draining clockwise (cooldown).
 *   OPEN      — green pie draining clockwise (browse window).
 *   COOL_DOWN — black disc filling with white (buffer).
 *
 * Session settings are edited via the GNOME Extensions preferences window.
 * Widgets are insensitive unless the current state is OPEN.
 */

import St from 'gi://St';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';
import Cairo from 'gi://cairo';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

const BACKEND_DIR = GLib.get_home_dir() + "/.local/share/mindful-connections";
const TIMER_SCRIPT = BACKEND_DIR + "/mindful_timer.py";
const STATE_FILE = "/tmp/mindful_connections_state.json";
const CONFIG_FILE = "/tmp/mindful_connections_config.json";

const DEFAULT_WAIT_SECS = 3 * 60;
const DEFAULT_OPEN_SECS = 20 * 60;
const DEFAULT_BUFFER_SECS = 1 * 60;
const DEFAULT_LONG_BREAK_SESSIONS = 3;
const DEFAULT_LONG_BREAK_SECS = 20 * 60;
const BTN_SIZE = 26;

// ─── Config helpers ───────────────────────────────────────────────────────────

function _readConfig() {
    try {
        let file = Gio.File.new_for_path(CONFIG_FILE);
        let [ok, raw] = file.load_contents(null);
        if (ok) {
            let d = JSON.parse(new TextDecoder().decode(raw));
            return {
                wait_seconds: d.wait_seconds || DEFAULT_WAIT_SECS,
                open_seconds: d.open_seconds || DEFAULT_OPEN_SECS,
                buffer_seconds: d.buffer_seconds !== undefined
                    ? d.buffer_seconds : DEFAULT_BUFFER_SECS,
                long_break_sessions: d.long_break_sessions !== undefined
                    ? d.long_break_sessions : DEFAULT_LONG_BREAK_SESSIONS,
                long_break_seconds: d.long_break_seconds !== undefined
                    ? d.long_break_seconds : DEFAULT_LONG_BREAK_SECS,
                routines: Array.isArray(d.routines) ? d.routines : null,
            };
        }
    } catch (_e) { }
    return {
        wait_seconds: DEFAULT_WAIT_SECS,
        open_seconds: DEFAULT_OPEN_SECS,
        buffer_seconds: DEFAULT_BUFFER_SECS,
        long_break_sessions: DEFAULT_LONG_BREAK_SESSIONS,
        long_break_seconds: DEFAULT_LONG_BREAK_SECS,
        routines: null,
    };
}

// ─── Indicator ────────────────────────────────────────────────────────────────

const MindfulIndicator = GObject.registerClass(
    class MindfulIndicator extends PanelMenu.Button {

        _init() {
            super._init(0.0, 'Mindful Connections');

            this._state = 'LOCKED';
            this._endsAt = 0;
            this._totalSec = DEFAULT_WAIT_SECS;
            this._timerId = null;
            this._menuRefreshId = null;   // live update timer while menu is open
            this._cfg = _readConfig();
            this._sessionCount = 0;
            this._recovering = false;     // true while a recovery lock is in flight
            this._routineActive = false;
            this._routineType = 'open';   // 'open' or 'blocked'
            this._routineEndsAt = 0;
            this._routineStartAt = 0;
            this._lastRoutineSlot = -1;   // slotKey (day*48+slot) of last detected routine

            // Canvas — Cairo drawing
            this._canvas = new St.DrawingArea({ width: BTN_SIZE, height: BTN_SIZE });
            this._canvas.set_style('margin: 5px 6px;');
            this._canvas.connect('repaint', this._onRepaint.bind(this));
            this.add_child(this._canvas);

            // Stop menu refresh timer whenever menu closes
            this.menu.connect('open-state-changed', (_m, isOpen) => {
                if (!isOpen)
                    this._stopMenuRefresh();
            });

            // Intercept all clicks: Stage 0 (LOCKED) starts timer, others toggle menu
            // (handled via vfunc_event override below)

            // Poll state file every second
            this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
                this._pollState();
                return GLib.SOURCE_CONTINUE;
            });

            this._pollState();
        }

        vfunc_event(event) {
            let t = event.type();
            if (t === Clutter.EventType.BUTTON_PRESS ||
                t === Clutter.EventType.TOUCH_BEGIN) {
                if (this._state === 'LOCKED') {
                    if (this._routineActive && this._routineType === 'blocked')
                        return Clutter.EVENT_STOP;
                    this._runBackend('start');
                    return Clutter.EVENT_STOP;
                }
                if (!this.menu.isOpen)
                    this._openMenu();
                this.menu.toggle();
                return Clutter.EVENT_STOP;
            }
            return super.vfunc_event(event);
        }

        // ─── Routine detection ────────────────────────────────────────────────────

        _checkRoutineSlot() {
            const routines = this._cfg.routines;
            if (!Array.isArray(routines)) return { active: false, endsAt: 0, startsAt: 0, slotKey: -1 };

            const now = new Date();
            const day = now.getDay();   // 0=Sun … 6=Sat (matches Python Sun=0 convention)
            const slot = now.getHours() * 2 + Math.floor(now.getMinutes() / 30);
            const slotKey = day * 48 + slot;

            // Normalize: old booleans (true→1), numbers 0/1/2
            const _norm = v => { if (v === true) return 1; return Number(v) || 0; };
            let slotVal = 0;
            try { slotVal = _norm(routines[day][slot]); } catch (_e) {}
            if (!slotVal) return { active: false, endsAt: 0, startsAt: 0, slotKey };

            const type = slotVal === 2 ? 'blocked' : 'open';

            // Walk backward — stop when adjacent slot has a different value
            let sd = day, ss = slot;
            for (let i = 0; i < 7 * 48; i++) {
                let ps = ss - 1, pd = sd;
                if (ps < 0) { ps = 47; pd = (sd - 1 + 7) % 7; }
                let pv = 0;
                try { pv = _norm(routines[pd][ps]); } catch (_e) {}
                if (pv !== slotVal) break;
                sd = pd; ss = ps;
            }

            // Walk forward — stop when adjacent slot has a different value
            let d = day, s = slot;
            for (let i = 0; i < 7 * 48; i++) {
                let ns = s + 1, nd = d;
                if (ns >= 48) { ns = 0; nd = (d + 1) % 7; }
                let nv = 0;
                try { nv = _norm(routines[nd][ns]); } catch (_e) {}
                if (nv !== slotVal) break;
                d = nd; s = ns;
            }

            const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            const daysBack = (day - sd + 7) % 7;
            const startMinutes = ss * 30;
            let startsAt = (midnight.getTime() - daysBack * 86400 * 1000 + startMinutes * 60 * 1000) / 1000;

            const daysOffset = (d - day + 7) % 7;
            const endMinutes = (s + 1) * 30;
            let endsAt = (midnight.getTime() + (daysOffset * 86400 + endMinutes * 60) * 1000) / 1000;
            if (endsAt <= Date.now() / 1000) endsAt += 7 * 86400;

            return { active: true, type, endsAt, startsAt, slotKey };
        }

        // ─── State polling ────────────────────────────────────────────────────────

        _pollState() {
            let data = this._readStateFile();
            let newState = data.state || 'LOCKED';
            let endsAt = data.ends_at || 0;
            let totalSec = data.total_seconds || DEFAULT_WAIT_SECS;

            // Stuck-state recovery: if the timer has expired but the daemon never
            // advanced the state (e.g. it crashed), force a lock so the user isn't
            // permanently locked out with no way to click-to-start.
            const GRACE_SECS = 15;
            let now = Date.now() / 1000;
            if (!this._recovering && newState !== 'LOCKED' &&
                    endsAt > 0 && now > endsAt + GRACE_SECS) {
                this._recovering = true;
                this._runBackend('lock');
            }
            if (newState === 'LOCKED') {
                this._recovering = false;
            }

            if (newState !== this._state) {
                this._onStateChange(this._state, newState);
                if (newState === 'OPEN') {
                    // Refresh config when entering OPEN so next menu open shows current values
                    this._cfg = _readConfig();
                }
            }

            this._state = newState;
            this._endsAt = endsAt;
            this._totalSec = totalSec;
            this._sessionCount = data.session_count !== undefined ? data.session_count : 0;

            // Check if current time falls in a routine slot
            const routineInfo = this._checkRoutineSlot();
            const wasRoutineActive = this._routineActive;
            this._routineActive = routineInfo.active;
            this._routineType   = routineInfo.type || 'open';
            this._routineEndsAt = routineInfo.endsAt;

            // During a blocked slot, keep the backend locked
            if (routineInfo.active && routineInfo.type === 'blocked' && newState !== 'LOCKED') {
                this._runBackend('lock');
            }

            if (routineInfo.active) {
                this._routineStartAt = routineInfo.startsAt;
                if (routineInfo.slotKey !== this._lastRoutineSlot) {
                    // New slot boundary: refresh config and tell backend to open
                    this._lastRoutineSlot = routineInfo.slotKey;
                    this._cfg = _readConfig();
                    this._runBackend('routine-check');
                }
            } else {
                this._lastRoutineSlot = -1;
            }

            // Update live info labels if menu is open
            if (this.menu.isOpen) {
                this._updateMenuLabels();
            }

            this._canvas.queue_repaint();
        }

        _readStateFile() {
            try {
                let file = Gio.File.new_for_path(STATE_FILE);
                let [ok, raw] = file.load_contents(null);
                if (ok) return JSON.parse(new TextDecoder().decode(raw));
            } catch (_e) { }
            return { state: 'LOCKED', ends_at: 0, total_seconds: DEFAULT_WAIT_SECS };
        }

        // ─── Universal Menu ───────────────────────────────────────────────────────

        _openMenu() {
            this._stopMenuRefresh();
            this.menu.removeAll();

            // Timer display (centered)
            this._timerItem = new PopupMenu.PopupBaseMenuItem({ reactive: false });
            try { this._timerItem._ornamentLabel.set_style('width: 0; min-width: 0;'); } catch (_e) { }
            this._timerLabel = new St.Label({
                text: '',
                x_align: Clutter.ActorAlign.CENTER,
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            this._timerItem.add_child(this._timerLabel);
            this.menu.addMenuItem(this._timerItem);

            this._updateMenuLabels();

            // Refresh every second while open
            this._menuRefreshId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
                if (this.menu.isOpen) {
                    this._updateMenuLabels();
                    return GLib.SOURCE_CONTINUE;
                }
                return GLib.SOURCE_REMOVE;
            });
        }

        _updateMenuLabels() {
            if (!this._timerItem) return;

            if (this._routineActive) {
                let rem = Math.max(0, Math.ceil(this._routineEndsAt - Date.now() / 1000));
                let m = Math.floor(rem / 60);
                let s = rem % 60;
                let timeStr = `${m}:${String(s).padStart(2, '0')}`;
                let label = this._routineType === 'blocked' ? 'Routine Lockout' : 'Routine';
                this._timerLabel.set_text(`⏲  ${timeStr} - ${label}`);
                return;
            }

            const stageNames = {
                WARM_UP: 'Warming Up',
                OPEN: 'Open',
                COOL_DOWN: 'Cooling Down',
            };

            let rem = Math.max(0, Math.ceil(this._endsAt - Date.now() / 1000));
            let m = Math.floor(rem / 60);
            let s = rem % 60;
            let timeStr = `${m}:${String(s).padStart(2, '0')}`;
            let stageName = stageNames[this._state] || this._state;

            let sessionStr = '';
            if (this._state === 'OPEN') {
                let total = this._cfg.long_break_sessions || DEFAULT_LONG_BREAK_SESSIONS;
                let current = (this._sessionCount % total) + 1;
                sessionStr = `  (${current}/${total})`;
            }
            this._timerLabel.set_text(`⏲  ${timeStr} - ${stageName}${sessionStr}`);
        }

        _stopMenuRefresh() {
            if (this._menuRefreshId !== null) {
                GLib.source_remove(this._menuRefreshId);
                this._menuRefreshId = null;
            }
        }

        // ─── State change ─────────────────────────────────────────────────────────

        _onStateChange(_old, _newState) {
            this.menu.close();
        }

        // ─── Cairo drawing ────────────────────────────────────────────────────────

        _onRepaint(area) {
            let cr = area.get_context();
            let [w, h] = area.get_surface_size();
            let cx = w / 2, cy = h / 2;
            let r = Math.min(w, h) / 2 - 1.5;

            let now = Date.now() / 1000;
            let remaining = Math.max(0, this._endsAt - now);

            if (this._state === 'COOL_DOWN') {
                // Black disc filling up with white (elapsed fraction grows)
                cr.arc(cx, cy, r, 0, 2 * Math.PI);
                cr.setSourceRGB(0.12, 0.12, 0.12);
                cr.fill();

                let elapsed = this._totalSec > 0
                    ? Math.min(1, 1 - remaining / this._totalSec) : 1;
                cr.setSourceRGB(1, 1, 1);
                if (elapsed >= 1.0) {
                    cr.arc(cx, cy, r - 2, 0, 2 * Math.PI);
                    cr.fill();
                } else if (elapsed > 0) {
                    let s = -Math.PI / 2;
                    cr.moveTo(cx, cy);
                    cr.arc(cx, cy, r - 2, s, s + 2 * Math.PI * elapsed);
                    cr.closePath();
                    cr.fill();
                }
            } else if (this._routineActive) {
                // Routine mode: blue (open) or red (blocked) draining pie
                cr.arc(cx, cy, r, 0, 2 * Math.PI);
                cr.setSourceRGB(1, 1, 1);
                cr.fill();

                let routineRemaining = Math.max(0, this._routineEndsAt - now);
                let routineTotal = this._routineEndsAt - this._routineStartAt;
                let fraction = routineTotal > 0
                    ? Math.min(1, routineRemaining / routineTotal) : 1;

                if (this._routineType === 'blocked')
                    cr.setSourceRGB(0.85, 0.15, 0.15);
                else
                    cr.setSourceRGB(0.20, 0.50, 0.90);

                if (fraction >= 1.0) {
                    cr.arc(cx, cy, r - 2, 0, 2 * Math.PI);
                    cr.fill();
                } else if (fraction > 0) {
                    let s = -Math.PI / 2;
                    cr.moveTo(cx, cy);
                    cr.arc(cx, cy, r - 2, s, s + 2 * Math.PI * fraction);
                    cr.closePath();
                    cr.fill();
                }
            } else {
                // White disc background
                cr.arc(cx, cy, r, 0, 2 * Math.PI);
                cr.setSourceRGB(1, 1, 1);
                cr.fill();

                if (this._state === 'LOCKED') {
                    cr.arc(cx, cy, r * 0.28, 0, 2 * Math.PI);
                    cr.setSourceRGB(0, 0, 0);
                    cr.fill();
                } else {
                    // Draining pie (WARM_UP = red, OPEN = green)
                    let fraction = this._totalSec > 0
                        ? Math.min(1, remaining / this._totalSec) : 0;

                    if (this._state === 'WARM_UP') cr.setSourceRGB(0.85, 0.15, 0.15);
                    else cr.setSourceRGB(0.15, 0.68, 0.38);

                    if (fraction >= 1.0) {
                        cr.arc(cx, cy, r - 2, 0, 2 * Math.PI);
                        cr.fill();
                    } else if (fraction > 0) {
                        let s = -Math.PI / 2;
                        cr.moveTo(cx, cy);
                        cr.arc(cx, cy, r - 2, s, s + 2 * Math.PI * fraction);
                        cr.closePath();
                        cr.fill();
                    }
                }
            }

            // Black ring border
            cr.arc(cx, cy, r, 0, 2 * Math.PI);
            cr.setSourceRGB(0, 0, 0);
            cr.setLineWidth(1.5);
            cr.stroke();
            cr.$dispose();
        }

        // ─── Backend ──────────────────────────────────────────────────────────────

        _runBackend(action) {
            try {
                let proc = Gio.Subprocess.new(
                    ['sudo', 'python3', TIMER_SCRIPT, '--action', action],
                    Gio.SubprocessFlags.NONE);
                proc.wait_async(null, null);
            } catch (e) {
                console.error(`MindfulConnections: backend error [${action}]: ${e.message}`);
                Main.notify('Mindful Connections Error', 'Could not run backend. Check sudoers setup.');
            }
        }

        // ─── Cleanup ──────────────────────────────────────────────────────────────

        destroy() {
            this._stopMenuRefresh();
            if (this._timerId !== null) {
                GLib.source_remove(this._timerId);
                this._timerId = null;
            }
            super.destroy();
        }
    });

// ─── Extension lifecycle ──────────────────────────────────────────────────────

export default class MindfulConnectionsExtension extends Extension {
    enable() {
        this._indicator = new MindfulIndicator();
        Main.panel.addToStatusArea(this.uuid, this._indicator, 1, 'right');
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
