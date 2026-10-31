// Liquid Glass smoothness check: a guided, read-only frame-time measurement.
//
// Run it from Looking Glass (Alt+F2, type lg, Enter) with the one line that
// lg-hwcheck.sh prints, for example:
//
//     (await import('file:///home/you/liquid-glass-checks/fps.js')).run()
//
// What it does:
//   * shows a small card at the top of the screen that tells you what to do,
//     phase by phase (hands off, minimize and restore, hover the panel, drag a window);
//   * listens to GNOME Shell's own frame signals and counts how long each frame
//     took and how often a frame was late, per screen;
//   * writes the numbers to ~/liquid-glass-checks/fps-<time>.txt (and .json).
//
// What it never does: change a setting, touch a file outside ~/liquid-glass-checks,
// talk to the network, or keep running after the last phase. Everything it adds
// (signal handlers, timers, the card) is removed at the end, also on an error.
// stop() ends it early.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as ShellConfig from 'resource:///org/gnome/shell/misc/config.js';

const UUID = 'liquid-glass@djshiye.github.io';
const OUT_DIR = GLib.build_filenamev([GLib.get_home_dir(), 'liquid-glass-checks']);
// A gap longer than this is the screen resting (nothing to draw), not a slow frame.
const IDLE_GAP_US = 250000;

const PHASES = [
    {key: 'ready', secs: 5, count: false,
        text: 'Smoothness check starting. Hands off the mouse for a moment.'},
    {key: 'still', secs: 6,
        text: 'Hands off. Measuring the desktop at rest.'},
    {key: 'minimize', secs: 25,
        text: 'Minimize a window (the _ button), then click its panel icon to bring it back. Repeat until the timer ends.'},
    {key: 'hover', secs: 15,
        text: 'Slide the mouse slowly back and forth along the panel icons.'},
    {key: 'drag', secs: 15,
        text: 'Drag a window around the screen by its title bar, in slow circles.'},
];

let run_ = null;
let lastResult_ = null;

// Only you can read the results (GNOME Shell's own umask would make them world-readable).
function save(path, text) {
    GLib.file_set_contents_full(path, text, GLib.FileSetContentsFlags.CONSISTENT, 0o600);
}

function percentile(sorted, p) {
    if (!sorted.length)
        return 0;
    const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p / 100 * sorted.length) - 1));
    return sorted[i];
}

function ms(us) {
    return Math.round(us / 100) / 10;
}

// Sum of the glass panes' re-render counters (read-only; the extension keeps them for QA).
function glassRenders() {
    let total = 0, panes = 0;
    const walk = actor => {
        for (const e of actor.get_effects?.() ?? []) {
            if (typeof e.renders === 'number') {
                total += e.renders;
                panes++;
            }
        }
        for (const c of actor.get_children?.() ?? [])
            walk(c);
    };
    try {
        walk(global.stage);
    } catch {}
    return {total, panes};
}

async function extensionModule(name) {
    try {
        const ext = Main.extensionManager.lookup(UUID);
        if (!ext?.dir)
            return null;
        // Same URL as the extension's own import, so this is the running module, not a copy.
        return await import(ext.dir.get_child(name).get_uri());
    } catch {
        return null;
    }
}

function readMotion() {
    try {
        const path = GLib.build_filenamev([GLib.get_user_config_dir(), 'liquid-glass', 'shell-glass.json']);
        const [ok, bytes] = GLib.file_get_contents(path);
        if (!ok)
            return null;
        const raw = JSON.parse(new TextDecoder().decode(bytes));
        return raw?.animations ?? null;
    } catch {
        return null;
    }
}

function screens() {
    const out = [];
    try {
        const d = global.display;
        for (let i = 0; i < d.get_n_monitors(); i++) {
            const g = d.get_monitor_geometry(i);
            out.push({size: `${g.width}x${g.height}`, at: `${g.x},${g.y}`,
                scale: d.get_monitor_scale(i), primary: i === d.get_primary_monitor()});
        }
    } catch {}
    return out;
}

class Run {
    constructor() {
        this._signals = [];
        this._timers = [];
        this._phase = -1;
        this._left = 0;
        this._stats = {};       // phase -> view name -> {intervals, paints, frames}
        this._last = new Map(); // view name -> last after-paint time (µs)
        this._start = new Map(); // view name -> before-paint time (µs)
        this._events = {minimize: 0, unminimize: 0};
        this._renders = {};
    }

    async begin() {
        this._anim = await extensionModule('animations.js');
        this._genie0 = this._anim?.qaGenie?.() ?? null;
        this._motion = readMotion();
        this._screens = screens();
        this._ext = Main.extensionManager.lookup(UUID);

        this._card = new St.BoxLayout({
            vertical: true, reactive: false, can_focus: false, track_hover: false,
            style: 'background-color: rgba(18,20,28,0.92); border-radius: 18px; padding: 14px 22px; ' +
                'border: 1px solid rgba(255,255,255,0.14); box-shadow: 0 6px 24px rgba(0,0,0,0.45);',
        });
        this._title = new St.Label({style: 'font-weight: 700; font-size: 11pt; color: rgba(255,255,255,0.65);'});
        this._label = new St.Label({style: 'font-size: 13pt; color: white; padding-top: 4px;'});
        this._label.clutter_text.line_wrap = true;
        this._card.add_child(this._title);
        this._card.add_child(this._label);
        // Not reactive, so clicks go straight through to what is under it.
        Main.layoutManager.addTopChrome(this._card);
        this._placeCard();

        const stage = global.stage;
        this._on(stage, 'before-paint', (_s, view) => this._before(view));
        this._on(stage, 'after-paint', (_s, view) => this._after(view));
        this._on(global.window_manager, 'minimize', () => this._count('minimize'));
        this._on(global.window_manager, 'unminimize', () => this._count('unminimize'));

        try {
            Main.lookingGlass?.close();
        } catch {}
        this._next();
        this._timers.push(GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => this._tick()));
    }

    _on(obj, sig, fn) {
        this._signals.push([obj, obj.connect(sig, fn)]);
    }

    _placeCard() {
        const m = Main.layoutManager.primaryMonitor;
        const width = Math.min(620, m.width - 40);
        this._card.set_width(width);
        this._card.set_position(m.x + Math.round((m.width - width) / 2), m.y + 48);
    }

    _key() {
        const p = PHASES[this._phase];
        return p && p.count !== false ? p.key : null;
    }

    _before(view) {
        if (this._key())
            this._start.set(view.name, GLib.get_monotonic_time());
    }

    _after(view) {
        const key = this._key();
        const now = GLib.get_monotonic_time();
        const name = view.name ?? '?';
        if (!key) {
            this._last.delete(name);
            return;
        }
        const s = (this._stats[key] ??= {})[name] ??= {intervals: [], paints: [], frames: 0,
            hz: Math.round((view.get_refresh_rate?.() ?? 0) * 100) / 100};
        s.frames++;
        const t0 = this._start.get(name);
        if (t0)
            s.paints.push(now - t0);
        const last = this._last.get(name);
        if (last && now - last < IDLE_GAP_US)
            s.intervals.push(now - last);
        this._last.set(name, now);
    }

    _count(what) {
        if (this._key())
            this._events[`${this._key()}:${what}`] = (this._events[`${this._key()}:${what}`] ?? 0) + 1;
    }

    _show() {
        const p = PHASES[this._phase];
        const n = PHASES.filter(x => x.count !== false).length;
        const i = PHASES.slice(0, this._phase + 1).filter(x => x.count !== false).length;
        this._title.text = p.count === false ? 'Liquid Glass smoothness check'
            : `Step ${i} of ${n}  ·  ${this._left} s`;
        this._label.text = p.text;
    }

    _next() {
        const prev = this._key();
        if (prev)
            this._renders[prev] = {...this._renders[prev], end: glassRenders()};
        this._last.clear();
        this._start.clear();
        this._phase++;
        if (this._phase >= PHASES.length) {
            this._finish();
            return;
        }
        const key = this._key();
        if (key)
            this._renders[key] = {start: glassRenders()};
        this._phaseStart = GLib.get_monotonic_time();
        this._left = PHASES[this._phase].secs;
        this._show();
    }

    _tick() {
        try {
            if (--this._left <= 0)
                this._next();
            else
                this._show();
        } catch (e) {
            this.stop(`error: ${e}`);
            return GLib.SOURCE_REMOVE;
        }
        return this._phase < PHASES.length ? GLib.SOURCE_CONTINUE : GLib.SOURCE_REMOVE;
    }

    _summary() {
        const phases = {};
        for (const [key, views] of Object.entries(this._stats)) {
            phases[key] = {};
            for (const [name, s] of Object.entries(views)) {
                const iv = [...s.intervals].sort((a, b) => a - b);
                const pt = [...s.paints].sort((a, b) => a - b);
                const budget = s.hz > 1 ? 1e6 / s.hz : 16667;
                const late = iv.filter(x => x > budget * 1.5).length;
                const busy = iv.reduce((a, b) => a + b, 0);
                phases[key][name] = {
                    hz: s.hz,
                    frames: s.frames,
                    fpsWhileMoving: busy ? Math.round(iv.length / (busy / 1e6) * 10) / 10 : 0,
                    frameGapMs: {p50: ms(percentile(iv, 50)), p95: ms(percentile(iv, 95)),
                        p99: ms(percentile(iv, 99)), max: ms(iv.at(-1) ?? 0)},
                    lateFrames: late,
                    latePct: iv.length ? Math.round(late / iv.length * 1000) / 10 : 0,
                    drawMs: {p50: ms(percentile(pt, 50)), p95: ms(percentile(pt, 95)), max: ms(pt.at(-1) ?? 0)},
                };
            }
        }
        const renders = {};
        for (const [key, r] of Object.entries(this._renders))
            renders[key] = r.end ? {panes: r.end.panes, renders: r.end.total - r.start.total} : null;
        const genie1 = this._anim?.qaGenie?.() ?? null;
        return {
            when: GLib.DateTime.new_now_local().format('%Y-%m-%d %H:%M:%S'),
            shell: ShellConfig.PACKAGE_VERSION,
            extension: this._ext ? {version: this._ext.metadata?.version ?? null,
                versionName: this._ext.metadata?.['version-name'] ?? null, state: this._ext.state} : null,
            screens: this._screens,
            motion: this._motion ?? 'defaults (minimize genie, hover spring)',
            events: this._events,
            genieFallbacks: genie1 && this._genie0 ? genie1.fallbacks - this._genie0.fallbacks : null,
            glassRenders: renders,
            phases,
        };
    }

    _text(r) {
        const L = [];
        L.push(`Liquid Glass smoothness check, ${r.when}`);
        L.push(`GNOME Shell ${r.shell}, extension ${r.extension?.versionName ?? r.extension?.version ?? 'not found'}`);
        L.push(`Screens: ${r.screens.map(s => `${s.size} at ${s.at} x${s.scale}${s.primary ? ' (primary)' : ''}`).join(', ')}`);
        L.push(`Motion: ${typeof r.motion === 'string' ? r.motion : JSON.stringify(r.motion)}`);
        L.push(`Minimize/restore seen: ${r.events['minimize:minimize'] ?? 0}/${r.events['minimize:unminimize'] ?? 0}` +
            `, genie fell back to plain scale: ${r.genieFallbacks ?? 'n/a'} times`);
        L.push('');
        L.push('phase     screen        Hz   frames  fps(moving)  gap p50/p95/p99/max ms   late%  draw p50/p95/max ms  glass renders');
        for (const p of PHASES.filter(x => x.count !== false)) {
            const views = r.phases[p.key] ?? {};
            const rn = r.glassRenders[p.key];
            if (!Object.keys(views).length)
                L.push(`${p.key.padEnd(9)} (no frames drawn)${rn ? `  renders ${rn.renders}` : ''}`);
            let first = true;
            for (const [name, v] of Object.entries(views)) {
                const g = v.frameGapMs, d = v.drawMs;
                const rnText = rn && first ? String(rn.renders).padStart(14) : '';
                first = false;
                L.push([p.key.padEnd(9), name.padEnd(12), String(v.hz).padStart(6), String(v.frames).padStart(7),
                    String(v.fpsWhileMoving).padStart(11),
                    `${g.p50}/${g.p95}/${g.p99}/${g.max}`.padStart(22),
                    String(v.latePct).padStart(7),
                    `${d.p50}/${d.p95}/${d.max}`.padStart(19),
                    rnText].join('  '));
            }
        }
        L.push('');
        L.push('gap = time between two drawn frames while something moves (resting gaps over 250 ms are left out).');
        L.push('late = a gap over 1.5x the screen refresh, i.e. at least one missed frame.');
        L.push('glass renders = glass re-renders in that step, all screens together.');
        L.push('draw = GNOME Shell CPU time to build and submit one frame; GPU work shows up as late frames.');
        return L.join('\n') + '\n';
    }

    _finish() {
        let file = null;
        try {
            const r = this._summary();
            lastResult_ = r;
            GLib.mkdir_with_parents(OUT_DIR, 0o700);
            const stamp = GLib.DateTime.new_now_local().format('%Y%m%d-%H%M%S');
            file = GLib.build_filenamev([OUT_DIR, `fps-${stamp}.txt`]);
            save(file, this._text(r));
            save(file.replace(/\.txt$/, '.json'), `${JSON.stringify(r, null, 2)}\n`);
        } catch (e) {
            logError(e, 'Liquid Glass smoothness check');
        }
        this.stop(file ? `Done. Results saved to ${file.replace(GLib.get_home_dir(), '~')}` : 'Done, but saving failed');
    }

    stop(message = 'Stopped') {
        for (const [obj, id] of this._signals) {
            try {
                obj.disconnect(id);
            } catch {}
        }
        this._signals = [];
        for (const id of this._timers)
            GLib.source_remove(id);
        this._timers = [];
        if (this._card) {
            const card = this._card;
            this._card = null;
            this._title.text = 'Liquid Glass smoothness check';
            this._label.text = message;
            card.ease?.({opacity: 255, duration: 1});
            // Leave the result on screen for a few seconds, then remove the card.
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 6000, () => {
                try {
                    Main.layoutManager.removeChrome(card);
                    card.destroy();
                } catch {}
                return GLib.SOURCE_REMOVE;
            });
        }
        this._phase = PHASES.length;
        if (run_ === this)
            run_ = null;
        log(`Liquid Glass smoothness check: ${message}`);
    }
}

/** Starts the guided check. Calling it again while it runs does nothing. */
export async function run() {
    if (run_)
        return 'Already running';
    run_ = new Run();
    try {
        await run_.begin();
    } catch (e) {
        run_?.stop(`error: ${e}`);
        throw e;
    }
    return 'Started: follow the card at the top of the screen';
}

/** Ends a running check early (nothing is saved). */
export function stop() {
    run_?.stop('Stopped early');
    return 'Stopped';
}

/** The last result, for the test harness. */
export function lastResult() {
    return lastResult_;
}
