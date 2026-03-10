/**
 * Mindful Connections — GNOME Shell Extension
 *
 * Left-click or Right-click:
 *   LOCKED    → start timer
 *   WARM_UP   → menu (timer only)
 *   OPEN      → menu (timer + prefs)
 *   COOL_DOWN → menu (timer only)
 *
 * States:
 *   LOCKED    — white disc + black dot.
 *   WARM_UP   — red pie draining clockwise (cooldown).
 *   OPEN      — green pie draining clockwise (browse window).
 *   COOL_DOWN — black disc filling with white (buffer).
 *
 * Preferences only editable in OPEN state (grayed out elsewhere).
 * Pref changes are locked in at the START of the next session, not mid-session.
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
            };
        }
    } catch (_e) { }
    return {
        wait_seconds: DEFAULT_WAIT_SECS,
        open_seconds: DEFAULT_OPEN_SECS,
        buffer_seconds: DEFAULT_BUFFER_SECS,
    };
}

function _writeConfig(cfg) {
    try {
        let file = Gio.File.new_for_path(CONFIG_FILE);
        let bytes = new TextEncoder().encode(JSON.stringify(cfg));
        file.replace_contents(bytes, null, false,
            Gio.FileCreateFlags.REPLACE_DESTINATION, null);
    } catch (e) {
        console.error(`MindfulConnections: config write failed: ${e.message}`);
    }
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
            this._menuRefreshId = null;   // live update timer while info menu is open
            this._menuMode = null;        // 'info' | 'prefs' | null
            this._cfg = _readConfig();

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

        // ─── State polling ────────────────────────────────────────────────────────

        _pollState() {
            let data = this._readStateFile();
            let newState = data.state || 'LOCKED';
            let endsAt = data.ends_at || 0;
            let totalSec = data.total_seconds || DEFAULT_WAIT_SECS;

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

            // Timer display (always present, centered)
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

            if (this._state === 'OPEN') {
                this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
                this._buildPrefsWidgets();
                this.menu.addMenuItem(this._waitRow.item);
                this.menu.addMenuItem(this._openRow.item);
                this.menu.addMenuItem(this._bufferRow.item);
                this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
                this.menu.addMenuItem(this._saveItem);
                this._setPrefsEnabled(true);
            }

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

            this._timerLabel.set_text(`⏲  ${timeStr} - ${stageName}`);
        }

        _stopMenuRefresh() {
            if (this._menuRefreshId !== null) {
                GLib.source_remove(this._menuRefreshId);
                this._menuRefreshId = null;
            }
        }

        // ─── Prefs building (OPEN state only) ─────────────────────────────────────

        _buildPrefsWidgets() {
            let cfg = _readConfig();
            let waitMin = Math.round(cfg.wait_seconds / 60);
            let openMin = Math.round(cfg.open_seconds / 60);
            let bufMin = Math.round(cfg.buffer_seconds / 60);

            this._waitRow = this._makeSpinRow('Warm up', waitMin, 1, 60);
            this._openRow = this._makeSpinRow('Open browsing', openMin, 1, 120);
            this._bufferRow = this._makeSpinRow('Cool down', bufMin, 0, 30);

            this._saveItem = new PopupMenu.PopupMenuItem('Save settings');
            this._saveItem.connect('activate', () => {
                this._cfg.wait_seconds = this._waitRow.getValue() * 60;
                this._cfg.open_seconds = this._openRow.getValue() * 60;
                this._cfg.buffer_seconds = this._bufferRow.getValue() * 60;
                _writeConfig(this._cfg);
                this.menu.close();
            });
        }

        _makeSpinRow(label, initVal, min, max) {
            let item = new PopupMenu.PopupBaseMenuItem({ reactive: false });
            try { item._ornamentLabel.set_style('width: 0; min-width: 0;'); } catch (_e) { }
            let value = initVal;

            let lbl = new St.Label({
                text: label + ':',
                style: 'min-width: 110px; color: #ccc;',
                y_align: Clutter.ActorAlign.CENTER,
            });

            let btnStyle = [
                'width: 26px; height: 26px; border-radius: 13px;',
                'background-color: rgba(255,255,255,0.12);',
                'color: #fff; font-size: 16px; font-weight: bold;',
                'text-align: center; padding: 0;',
            ].join(' ');

            let btnMinus = new St.Button({ label: '−', style: btnStyle });
            let valLbl = new St.Label({
                text: String(value) + ' min',
                style: 'min-width: 52px; text-align: center; color: #fff;',
                y_align: Clutter.ActorAlign.CENTER,
            });
            let btnPlus = new St.Button({ label: '+', style: btnStyle });

            const refresh = () => valLbl.set_text(String(value) + ' min');
            btnMinus.connect('clicked', () => { if (value > min) { value--; refresh(); } });
            btnPlus.connect('clicked', () => { if (value < max) { value++; refresh(); } });

            item.add_child(lbl);
            item.add_child(btnMinus);
            item.add_child(valLbl);
            item.add_child(btnPlus);

            const setEnabled = (on) => {
                const a = on ? 255 : 70;
                btnMinus.reactive = on; btnMinus.opacity = a;
                btnPlus.reactive = on; btnPlus.opacity = a;
                valLbl.opacity = a;
                lbl.opacity = a;
            };

            return {
                item,
                getValue: () => value,
                setValue: (v) => { value = v; refresh(); },
                setEnabled,
            };
        }

        _setPrefsEnabled(on) {
            if (!this._waitRow) return;
            this._waitRow.setEnabled(on);
            this._openRow.setEnabled(on);
            this._bufferRow.setEnabled(on);
            this._saveItem.setSensitive(on);
            this._saveItem.opacity = on ? 255 : 70;
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
