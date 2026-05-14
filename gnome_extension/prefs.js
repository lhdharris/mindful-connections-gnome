/**
 * Mindful Connections — Extension Preferences
 *
 * All session settings live here. Widgets are insensitive (greyed out)
 * unless the current state is OPEN. A GFileMonitor on the state file
 * updates sensitivity live while the window is open.
 *
 * Routines: a 7×48 grid of toggle buttons (days × 30-min slots). Marked
 * slots are saved to config and will always be open at those times.
 */

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const STATE_FILE  = '/tmp/mindful_connections_state.json';
const CONFIG_FILE = '/tmp/mindful_connections_config.json';

const DEFAULT_WAIT_SECS           = 1 * 60;
const DEFAULT_OPEN_SECS           = 20 * 60;
const DEFAULT_BUFFER_SECS         = 1 * 60;
const DEFAULT_LONG_BREAK_SESSIONS = 3;
const DEFAULT_LONG_BREAK_SECS     = 20 * 60;

// Dimensions of each routine slot button
const SLOT_W = 40;
const SLOT_H = 18;

export default class MindfulConnectionsPreferences extends ExtensionPreferences {

    fillPreferencesWindow(window) {
        window.set_default_size(540, 660);

        // GSettings — source of truth that survives extension reload.
        this._settings = this.getSettings();

        // Routines data: _routines[day][slot], initialised before the grid is built
        // so toggle callbacks always have a valid target.
        this._routines = Array.from({length: 7}, () => new Array(48).fill(false));
        this._sessionRows = [];
        this._isOpen   = false;

        const page = new Adw.PreferencesPage({
            title: 'Session Settings',
            icon_name: 'preferences-system-time-symbolic',
        });
        window.add(page);

        // ── Status banner ────────────────────────────────────────────────────────

        const statusGroup = new Adw.PreferencesGroup();
        page.add(statusGroup);
        this._statusRow = new Adw.ActionRow({ icon_name: 'system-lock-screen-symbolic' });
        statusGroup.add(this._statusRow);

        // ── Session timing ───────────────────────────────────────────────────────

        const timingGroup = new Adw.PreferencesGroup({ title: 'Session Timing' });
        page.add(timingGroup);

        this._waitRow = new Adw.SpinRow({
            title: 'Warm up',
            subtitle: 'Minutes before internet opens',
            adjustment: new Gtk.Adjustment({ lower: 1, upper: 60, step_increment: 1 }),
        });
        timingGroup.add(this._waitRow);

        this._openRow = new Adw.SpinRow({
            title: 'Open browsing',
            subtitle: 'Minutes the internet stays open',
            adjustment: new Gtk.Adjustment({ lower: 1, upper: 120, step_increment: 1 }),
        });
        timingGroup.add(this._openRow);

        this._bufferRow = new Adw.SpinRow({
            title: 'Cool down',
            subtitle: 'Buffer minutes after session ends',
            adjustment: new Gtk.Adjustment({ lower: 0, upper: 30, step_increment: 1 }),
        });
        timingGroup.add(this._bufferRow);

        // ── Long break ───────────────────────────────────────────────────────────

        const longBreakGroup = new Adw.PreferencesGroup({ title: 'Long Break' });
        page.add(longBreakGroup);

        this._longBreakEnabledRow = new Adw.SwitchRow({
            title: 'Enable long breaks',
            subtitle: 'After several sessions, extend the cool-down for a longer rest',
        });
        longBreakGroup.add(this._longBreakEnabledRow);
        this._longBreakEnabledRow.connect('notify::active', () => this._updateLongBreakSensitivity());

        this._longBreakSessionsRow = new Adw.SpinRow({
            title: 'Long break every',
            subtitle: 'Number of sessions before a long break',
            adjustment: new Gtk.Adjustment({ lower: 1, upper: 20, step_increment: 1 }),
        });
        longBreakGroup.add(this._longBreakSessionsRow);

        this._longBreakDurRow = new Adw.SpinRow({
            title: 'Long break duration',
            subtitle: 'Minutes for the long break',
            adjustment: new Gtk.Adjustment({ lower: 1, upper: 120, step_increment: 1 }),
        });
        longBreakGroup.add(this._longBreakDurRow);

        // ── Session profiles ────────────────────────────────────────────────────

        this._sessionsGroup = new Adw.PreferencesGroup({
            title: 'Plan Session Profiles',
            description: 'Quick durations shown in the "Plan session" submenu when a session is open. Add, edit, or remove them.',
        });
        page.add(this._sessionsGroup);

        this._addSessionRow = new Adw.ActionRow({
            title: 'Add session profile',
            subtitle: 'Up to 10 entries',
        });
        this._addSessionBtn = new Gtk.Button({
            icon_name: 'list-add-symbolic',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
            tooltip_text: 'Add a new session profile',
        });
        this._addSessionBtn.connect('clicked', () => this._addSessionProfile(15));
        this._addSessionRow.add_suffix(this._addSessionBtn);
        this._addSessionRow.activatable_widget = this._addSessionBtn;
        this._sessionsGroup.add(this._addSessionRow);

        // ── Routines ─────────────────────────────────────────────────────────────

        const routinesGroup = new Adw.PreferencesGroup({
            title: 'Routines',
            description: 'Click a slot to cycle: open (green) forces internet access, blocked (red) forces it off. ' +
                         'Both override the normal warm-up/open/cool-down cycle. Click a third time to clear.',
        });
        page.add(routinesGroup);
        this._buildRoutineGrid(routinesGroup);

        // ── Save button ──────────────────────────────────────────────────────────

        const saveGroup = new Adw.PreferencesGroup();
        page.add(saveGroup);

        const saveRow = new Adw.ActionRow({ title: 'Save settings' });
        this._saveBtn = new Gtk.Button({
            label: 'Save',
            valign: Gtk.Align.CENTER,
            css_classes: ['suggested-action'],
        });
        this._saveBtn.connect('clicked', () => this._saveConfig());
        saveRow.add_suffix(this._saveBtn);
        saveRow.activatable_widget = this._saveBtn;
        saveGroup.add(saveRow);

        // ── Populate values and apply initial sensitivity ────────────────────────

        this._loadValues();
        this._applyState(this._readState());

        // ── Monitor state file for live sensitivity updates ──────────────────────

        const stateFile = Gio.File.new_for_path(STATE_FILE);
        this._monitor = stateFile.monitor_file(Gio.FileMonitorFlags.NONE, null);
        this._monitor.connect('changed', () => this._applyState(this._readState()));

        window.connect('destroy', () => {
            this._monitor?.cancel();
            this._monitor = null;
        });
    }

    // ── Routine grid ─────────────────────────────────────────────────────────────

    _buildRoutineGrid(group) {
        const DAYS  = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        const SLOTS = 48;

        // Register CSS once for the slot buttons.
        const css = new Gtk.CssProvider();
        css.load_from_string(`
            .routine-slot {
                padding: 0;
                min-width:  ${SLOT_W}px;
                min-height: ${SLOT_H}px;
                border-radius: 3px;
                background: shade(@window_bg_color, 0.65);
                border: 1px solid alpha(currentColor, 0.35);
            }
            .routine-slot.open {
                background: #26a269;
                border: 1px solid #26a269;
            }
            .routine-slot.blocked {
                background: #c01c28;
                border: 1px solid #c01c28;
            }
            .routine-slot:disabled {
                opacity: 0.35;
            }
        `);
        Gtk.StyleContext.add_provider_for_display(
            Gdk.Display.get_default(), css,
            Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
        );

        // ── Outer container ───────────────────────────────────────────────────────

        const outer = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 4,
            margin_start: 8,
            margin_end: 8,
            margin_top: 8,
            margin_bottom: 8,
            hexpand: true,
        });

        // Day header row (spacer + 7 day labels)
        const header = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 2,
            hexpand: true,
        });
        header.append(new Gtk.Label({ width_request: 42 }));   // time-column spacer
        for (const day of DAYS) {
            header.append(new Gtk.Label({
                label: day,
                hexpand: true,
                xalign: 0.5,
                css_classes: ['caption', 'dim-label'],
            }));
        }
        outer.append(header);

        // ── Scrolled grid ─────────────────────────────────────────────────────────

        const scroll = new Gtk.ScrolledWindow({
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
            min_content_height: 350,
            max_content_height: 350,
            hexpand: true,
        });

        const grid = new Gtk.Grid({
            row_spacing: 1,
            column_spacing: 2,
            hexpand: true,
        });

        this._routineBtns = [];   // [slot][day]

        for (let slot = 0; slot < SLOTS; slot++) {
            const hour   = Math.floor(slot / 2);
            const isHour = slot % 2 === 0;

            // Time label — text only on the hour, invisible on the half-hour
            const timeLbl = new Gtk.Label({
                label:        isHour ? `${String(hour).padStart(2, '0')}:00` : '',
                xalign:       1.0,
                width_request: 38,
                height_request: SLOT_H + 1,
                css_classes:  ['caption'],
                opacity:      isHour ? 0.45 : 0.0,
                margin_end:   4,
            });
            grid.attach(timeLbl, 0, slot, 1, 1);

            const slotBtns = [];
            for (let d = 0; d < 7; d++) {
                const btn = new Gtk.Button({
                    css_classes:    ['routine-slot'],
                    width_request:  SLOT_W,
                    height_request: SLOT_H,
                    hexpand:        true,
                });
                // Capture loop vars so the closure is correct
                const _d = d, _s = slot;
                btn.connect('clicked', () => {
                    const next = (this._routines[_d][_s] + 1) % 3;
                    this._routines[_d][_s] = next;
                    this._applyRoutineBtn(btn, next);
                });
                grid.attach(btn, d + 1, slot, 1, 1);
                slotBtns.push(btn);
            }
            this._routineBtns.push(slotBtns);
        }

        scroll.set_child(grid);
        outer.append(scroll);
        group.add(outer);
    }

    // ── Helpers ──────────────────────────────────────────────────────────────────

    _readState() {
        try {
            const [ok, raw] = Gio.File.new_for_path(STATE_FILE).load_contents(null);
            if (ok) return JSON.parse(new TextDecoder().decode(raw)).state || 'LOCKED';
        } catch (_e) {}
        return 'LOCKED';
    }

    _readConfig() {
        try {
            const [ok, raw] = Gio.File.new_for_path(CONFIG_FILE).load_contents(null);
            if (ok) {
                const d = JSON.parse(new TextDecoder().decode(raw));
                return {
                    wait_seconds:         d.wait_seconds         || DEFAULT_WAIT_SECS,
                    open_seconds:         d.open_seconds         || DEFAULT_OPEN_SECS,
                    buffer_seconds:       d.buffer_seconds       !== undefined ? d.buffer_seconds       : DEFAULT_BUFFER_SECS,
                    long_break_enabled:   d.long_break_enabled   !== undefined ? d.long_break_enabled   : true,
                    long_break_sessions:  d.long_break_sessions  !== undefined ? d.long_break_sessions  : DEFAULT_LONG_BREAK_SESSIONS,
                    long_break_seconds:   d.long_break_seconds   !== undefined ? d.long_break_seconds   : DEFAULT_LONG_BREAK_SECS,
                    session_profiles:     Array.isArray(d.session_profiles) ? d.session_profiles : null,
                    routines:             Array.isArray(d.routines) ? d.routines : null,
                };
            }
        } catch (_e) {}
        return {
            wait_seconds:        DEFAULT_WAIT_SECS,
            open_seconds:        DEFAULT_OPEN_SECS,
            buffer_seconds:      DEFAULT_BUFFER_SECS,
            long_break_enabled:  true,
            long_break_sessions: DEFAULT_LONG_BREAK_SESSIONS,
            long_break_seconds:  DEFAULT_LONG_BREAK_SECS,
            session_profiles:    null,
            routines:            null,
        };
    }

    _readSessionProfiles(cfg) {
        // Prefer GSettings (survives extension reload); fall back to temp config.
        try {
            const raw = this._settings.get_string('session-profiles');
            if (raw) {
                const parsed = JSON.parse(raw);
                if (Array.isArray(parsed)) return parsed.filter(m => Number(m) > 0);
            }
        } catch (_e) {}
        if (Array.isArray(cfg.session_profiles))
            return cfg.session_profiles.filter(m => Number(m) > 0);
        return [30, 60, 90];
    }

    _addSessionProfile(mins) {
        if (this._sessionRows.length >= 10) return;
        const row = new Adw.SpinRow({
            title: `Session ${this._sessionRows.length + 1}`,
            subtitle: 'Duration in minutes',
            adjustment: new Gtk.Adjustment({
                lower: 1, upper: 240, step_increment: 1, value: mins,
            }),
        });
        const delBtn = new Gtk.Button({
            icon_name: 'edit-delete-symbolic',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
            tooltip_text: 'Remove this profile',
        });
        delBtn.connect('clicked', () => this._removeSessionProfile(row));
        row.add_suffix(delBtn);
        row._delBtn = delBtn;
        row.sensitive = this._isOpen;
        delBtn.sensitive = this._isOpen;
        // Insert before the "Add session" row.
        this._sessionsGroup.remove(this._addSessionRow);
        this._sessionsGroup.add(row);
        this._sessionsGroup.add(this._addSessionRow);
        this._sessionRows.push(row);
        this._updateAddSessionState();
    }

    _removeSessionProfile(row) {
        const idx = this._sessionRows.indexOf(row);
        if (idx < 0) return;
        this._sessionRows.splice(idx, 1);
        this._sessionsGroup.remove(row);
        this._renumberSessionRows();
        this._updateAddSessionState();
    }

    _renumberSessionRows() {
        this._sessionRows.forEach((row, i) => { row.title = `Session ${i + 1}`; });
    }

    _updateAddSessionState() {
        const canAdd = this._isOpen && this._sessionRows.length < 10;
        this._addSessionBtn.sensitive = canAdd;
        this._addSessionRow.subtitle = this._sessionRows.length >= 10
            ? 'Limit reached (10)'
            : 'Up to 10 entries';
    }

    _loadValues() {
        const cfg = this._readConfig();

        this._waitRow.value               = Math.round(cfg.wait_seconds / 60);
        this._openRow.value               = Math.round(cfg.open_seconds / 60);
        this._bufferRow.value             = Math.round(cfg.buffer_seconds / 60);
        this._longBreakEnabledRow.active  = cfg.long_break_enabled;
        this._longBreakSessionsRow.value  = cfg.long_break_sessions;
        this._longBreakDurRow.value       = Math.round(cfg.long_break_seconds / 60);

        // Rebuild session-profile rows.
        for (const row of [...this._sessionRows])
            this._sessionsGroup.remove(row);
        this._sessionRows = [];
        for (const mins of this._readSessionProfiles(cfg))
            this._addSessionProfile(Number(mins) || 15);
        this._updateAddSessionState();

        // Rebuild routines from config (0=off, 1=open, 2=blocked).
        // Old boolean configs: true→1, false/missing→0.
        this._routines = Array.from({length: 7}, (_, d) =>
            Array.from({length: 48}, (__, s) => {
                const v = cfg.routines?.[d]?.[s];
                if (v === true) return 1;
                if (!v) return 0;
                return Math.min(2, Math.max(0, Number(v) || 0));
            })
        );
        for (let slot = 0; slot < 48; slot++)
            for (let d = 0; d < 7; d++)
                this._applyRoutineBtn(this._routineBtns[slot][d], this._routines[d][slot]);
    }

    _applyRoutineBtn(btn, val) {
        btn.remove_css_class('open');
        btn.remove_css_class('blocked');
        if (val === 1) btn.add_css_class('open');
        else if (val === 2) btn.add_css_class('blocked');
    }

    _updateLongBreakSensitivity() {
        const enabled = this._longBreakEnabledRow.active;
        this._longBreakSessionsRow.sensitive = this._isOpen && enabled;
        this._longBreakDurRow.sensitive      = this._isOpen && enabled;
    }

    _applyState(state) {
        this._isOpen = state === 'OPEN';

        for (const row of [
            this._waitRow, this._openRow, this._bufferRow,
            this._longBreakEnabledRow,
        ])
            row.sensitive = this._isOpen;

        this._updateLongBreakSensitivity();
        this._saveBtn.sensitive = this._isOpen;

        for (const row of this._sessionRows) {
            row.sensitive = this._isOpen;
            if (row._delBtn) row._delBtn.sensitive = this._isOpen;
        }
        this._updateAddSessionState();

        for (const slotBtns of this._routineBtns)
            for (const btn of slotBtns)
                btn.sensitive = this._isOpen;

        if (this._isOpen) {
            this._statusRow.title     = 'Session is open — settings are editable';
            this._statusRow.subtitle  = 'Changes take effect at the start of the next session.';
            this._statusRow.icon_name = 'emblem-ok-symbolic';
        } else {
            const label = { WARM_UP: 'warming up', COOL_DOWN: 'cooling down' }[state] ?? 'locked';
            this._statusRow.title     = `Session ${label} — settings are locked`;
            this._statusRow.subtitle  = 'Start a session and wait for it to open to edit these.';
            this._statusRow.icon_name = 'system-lock-screen-symbolic';
        }
    }

    _saveConfig() {
        try {
            const sessionProfiles = this._sessionRows
                .map(r => Number(r.value) || 0)
                .filter(m => m > 0);

            // Merge into existing temp config so we don't drop fields written
            // by other code paths (e.g. planned_open_seconds).
            let existing = {};
            try {
                const [ok, raw] = Gio.File.new_for_path(CONFIG_FILE).load_contents(null);
                if (ok) existing = JSON.parse(new TextDecoder().decode(raw)) || {};
            } catch (_e) {}

            const cfg = Object.assign(existing, {
                wait_seconds:        this._waitRow.value * 60,
                open_seconds:        this._openRow.value * 60,
                buffer_seconds:      this._bufferRow.value * 60,
                long_break_enabled:  this._longBreakEnabledRow.active,
                long_break_sessions: this._longBreakSessionsRow.value,
                long_break_seconds:  this._longBreakDurRow.value * 60,
                session_profiles:    sessionProfiles,
                routines:            this._routines,
            });
            const bytes = new TextEncoder().encode(JSON.stringify(cfg));
            Gio.File.new_for_path(CONFIG_FILE).replace_contents(
                bytes, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null
            );

            // Persist to GSettings so values survive extension reload.
            try {
                this._settings.set_int('wait-seconds',        this._waitRow.value * 60);
                this._settings.set_int('open-seconds',        this._openRow.value * 60);
                this._settings.set_int('buffer-seconds',      this._bufferRow.value * 60);
                this._settings.set_boolean('long-break-enabled', this._longBreakEnabledRow.active);
                this._settings.set_int('long-break-sessions', this._longBreakSessionsRow.value);
                this._settings.set_int('long-break-seconds',  this._longBreakDurRow.value * 60);
                this._settings.set_string('session-profiles', JSON.stringify(sessionProfiles));
                this._settings.set_string('routines',         JSON.stringify(this._routines));
            } catch (e) {
                console.error(`MindfulConnections prefs: GSettings save failed: ${e.message}`);
            }
            this._saveBtn.label = 'Saved!';
            this._saveBtn.remove_css_class('suggested-action');
            this._saveBtn.add_css_class('success');
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
                if (this._saveBtn) {
                    this._saveBtn.label = 'Save';
                    this._saveBtn.remove_css_class('success');
                    this._saveBtn.add_css_class('suggested-action');
                }
                return GLib.SOURCE_REMOVE;
            });
        } catch (e) {
            console.error(`MindfulConnections prefs: save failed: ${e.message}`);
        }
    }
}
