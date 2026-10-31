#!/usr/bin/env bash
# Liquid Glass hardware checks: read-only. Never needs sudo.
#
#   lg-hwcheck.sh info        your PC, screens, GPU and Liquid Glass version
#   lg-hwcheck.sh monitors    guided screen unplug check (asks you to press Enter between steps)
#   lg-hwcheck.sh fps         prints the one line to paste into Looking Glass for the smoothness check
#   lg-hwcheck.sh report      sums up everything into one file you can share
#
# For a non-interactive runner (Remote Control): "monitors start", "monitors snap" and
# "monitors report" do the same steps without waiting for Enter.
#
# It only reads: system info, GNOME's screen list (over D-Bus), and your own GNOME
# Shell log since the check started. It writes only to ~/liquid-glass-checks/.
# Nothing is sent anywhere.

set -u
umask 077
UUID=liquid-glass@djshiye.github.io
DIR="$HOME/liquid-glass-checks"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$DIR"

say() { printf '%s\n' "$*"; }
ts() { date '+%Y-%m-%d %H:%M:%S'; }

shell_pid() { pgrep -u "$(id -u)" -x gnome-shell | head -n1; }

ext_state() {
    if command -v gnome-extensions >/dev/null 2>&1; then
        gnome-extensions info "$UUID" 2>/dev/null | sed -n 's/^ *\(Version\|State\|Path\): */\1: /p' | tr '\n' ' '
        echo
    else
        echo "gnome-extensions not found"
    fi
}

# Screens as GNOME sees them right now: connector, mode, refresh, scale, primary.
screens() {
    python3 -I - <<'PY' 2>/dev/null || echo "(could not read the screen list)"
import gi
gi.require_version('Gio', '2.0')
from gi.repository import Gio, GLib
bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
res = bus.call_sync('org.gnome.Mutter.DisplayConfig', '/org/gnome/Mutter/DisplayConfig',
                    'org.gnome.Mutter.DisplayConfig', 'GetCurrentState', None, None,
                    Gio.DBusCallFlags.NONE, 5000, None).unpack()
serial, monitors, logical, props = res
modes = {}
for (conn, vendor, product, serialno), mlist, mprops in monitors:
    cur = next((m for m in mlist if m[6].get('is-current')), None)
    name = mprops.get('display-name', f'{vendor} {product}')
    modes[conn] = (name, f"{cur[1]}x{cur[2]} @{cur[3]:.2f} Hz" if cur else 'off')
seen = set()
for x, y, scale, transform, primary, mons, lprops in logical:
    for conn, *_ in mons:
        seen.add(conn)
        name, mode = modes.get(conn, ('?', '?'))
        print(f"  {conn:10} {name:28} {mode:22} scale {scale:g} at {x},{y}{'  (primary)' if primary else ''}")
for conn, (name, mode) in modes.items():
    if conn not in seen:
        print(f"  {conn:10} {name:28} connected but not in use")
if not modes:
    print("  (no screens reported)")
PY
}

info() {
    say "== Liquid Glass hardware info, $(ts)"
    say "System:   $(. /etc/os-release 2>/dev/null; echo "${PRETTY_NAME:-unknown}"), kernel $(uname -r)"
    say "Session:  ${XDG_SESSION_TYPE:-?} / ${XDG_CURRENT_DESKTOP:-?}"
    say "Shell:    $(gnome-shell --version 2>/dev/null || echo unknown)"
    say "Package:  $(rpm -q liquid-glass 2>/dev/null || echo 'liquid-glass rpm not installed')"
    say "Extension: $(ext_state)"
    say "CPU:      $(sed -n 's/^model name\s*: //p' /proc/cpuinfo | head -n1) ($(nproc) threads)"
    say "GPU:"
    if command -v lspci >/dev/null 2>&1; then
        lspci -k 2>/dev/null | grep -A3 -E 'VGA|3D controller|Display controller' \
            | grep -E 'VGA|3D controller|Display controller|driver in use' | sed 's/^/    /'
    else
        for d in /sys/class/drm/card[0-9]; do
            [ -e "$d/device/vendor" ] && say "    $(basename "$d"): vendor $(cat "$d/device/vendor") device $(cat "$d/device/device") driver $(basename "$(readlink "$d/device/driver")")"
        done
    fi
    if command -v glxinfo >/dev/null 2>&1; then
        glxinfo -B 2>/dev/null | grep -E 'OpenGL renderer|OpenGL core profile version' | sed 's/^/    /'
    fi
    say "Screens:"
    screens
}

# --- monitor unplug check ------------------------------------------------------------
STATE="$DIR/monitor-check.state"
MLOG="$DIR/monitor-check.log"

mon_start() {
    {
        echo "START_EPOCH=$(date +%s)"
        echo "START_PID=$(shell_pid)"
    } > "$STATE"
    {
        say "== Monitor unplug check started $(ts)"
        say "GNOME Shell process: $(shell_pid)"
        say "Extension: $(ext_state)"
        say "Screens before:"
        screens
    } | tee "$MLOG"
}

mon_snap() {
    { say "-- $(ts) ${1:-screens now}:"; screens; } | tee -a "$MLOG"
}

# Lines from your own GNOME Shell log since the check started that matter for us.
shell_log_since() {
    local since=$1
    {
        journalctl --user -q --no-pager -o short-iso --since "@$since" 2>/dev/null
        journalctl -q --no-pager -o short-iso --since "@$since" _UID="$(id -u)" 2>/dev/null
    } | grep -E 'gnome-shell|liquid|Liquid' | sort -u
}

mon_report() {
    [ -f "$STATE" ] || { say "No monitor check was started. Run: $0 monitors"; return 1; }
    # shellcheck disable=SC1090
    . "$STATE"
    local now_pid errors crashes lg
    now_pid=$(shell_pid)
    local all
    all=$(shell_log_since "$START_EPOCH")
    lg=$(printf '%s\n' "$all" | grep -iE 'liquid-glass|liquid glass|djshiye' | grep -viE 'smoothness check' )
    errors=$(printf '%s\n' "$all" | grep -E 'JS ERROR|Gjs-CRITICAL|Gjs-WARNING|assert|Segmentation|core dumped|meta_window_get_work_area' )
    crashes=""
    if command -v coredumpctl >/dev/null 2>&1; then
        crashes=$(coredumpctl list --no-pager --no-legend --since "@$START_EPOCH" 2>/dev/null | grep -E 'gnome-shell|Xwayland' )
    fi
    {
        say "== Monitor unplug check result $(ts)"
        if [ -n "$now_pid" ] && [ "$now_pid" = "$START_PID" ]; then
            say "GNOME Shell kept running the whole time (same process $now_pid): no crash."
        else
            say "GNOME Shell process changed ($START_PID -> ${now_pid:-none}): it restarted or crashed."
        fi
        say "Extension now: $(ext_state)"
        say "Screens now:"
        screens
        say "Shell crash reports since start: $( [ -n "$crashes" ] && echo "YES" || echo "none")"
        [ -n "$crashes" ] && printf '%s\n' "$crashes" | sed 's/^/    /'
        say "Liquid Glass log lines since start: $(printf '%s' "$lg" | grep -c . )"
        [ -n "$lg" ] && printf '%s\n' "$lg" | tail -n 40 | sed 's/^/    /'
        say "Shell errors/criticals since start (any source): $(printf '%s' "$errors" | grep -c . )"
        [ -n "$errors" ] && printf '%s\n' "$errors" | tail -n 40 | sed 's/^/    /'
    } | tee -a "$MLOG"
}

pause() { read -r -p "$1  [press Enter] " _; }

mon_guided() {
    say "Monitor unplug check. You need two screens. It takes about 2 minutes."
    say "Nothing is changed on your PC; this only watches GNOME's log and screen list."
    say
    pause "1. Open two or three windows (for example Files and Terminal) on the screen you will unplug."
    mon_start >/dev/null
    say "   Noted the starting point."
    local round=1
    while :; do
        pause "2. Unplug that screen's cable now (round $round). Wait until its windows jump to the other screen."
        mon_snap "after unplug (round $round)" >/dev/null
        read -r -p "   Do the windows that moved still have glass edges and look normal? [y/n] " a1
        echo "round $round after unplug: glass looks normal = ${a1:-?}" >> "$MLOG"
        pause "3. Plug the cable back in and wait for the screen to come back."
        mon_snap "after replug (round $round)" >/dev/null
        read -r -p "   Do all windows have glass again, with no stray glass boxes left on screen? [y/n] " a2
        echo "round $round after replug: glass looks normal = ${a2:-?}" >> "$MLOG"
        read -r -p "4. Do one more round? (a second round catches more) [y/n] " again
        [ "${again:-n}" = y ] || [ "${again:-n}" = Y ] || break
        round=$((round + 1))
    done
    say
    mon_report
    say
    say "Saved to $MLOG"
}

# --- smoothness check ------------------------------------------------------------------
fps_line() {
    local js="$DIR/fps.js"
    if [ "$HERE/fps.js" != "$js" ]; then
        cp "$HERE/fps.js" "$js" || { say "fps.js is missing next to this script."; return 1; }
    fi
    chmod 600 "$js"
    say "Smoothness check (about 70 seconds, guided by a card at the top of your screen):"
    say
    say "  1. Press Alt+F2, type  lg  and press Enter. GNOME's Looking Glass console opens."
    say "  2. Paste this line into it and press Enter:"
    say
    say "     (await import('file://$js')).run()"
    say
    say "  3. Looking Glass closes by itself. Follow the card: hands off, then minimize and"
    say "     restore a window, then hover the panel icons, then drag a window around."
    say "  4. When the card says Done, the numbers are in $DIR/fps-<time>.txt"
    say
    say "To stop early: open Looking Glass again and paste  (await import('file://$js')).stop()"
    say "To run it again later, paste the same line again."
}

report() {
    local out="$DIR/report-$(date +%Y%m%d-%H%M%S).txt"
    {
        info
        say
        if [ -f "$MLOG" ]; then cat "$MLOG"; else say "== Monitor unplug check: not run yet"; fi
        say
        local f
        f=$(ls -1t "$DIR"/fps-*.txt 2>/dev/null | head -n1)
        if [ -n "$f" ]; then say "== Smoothness check ($(basename "$f"))"; cat "$f"; else say "== Smoothness check: not run yet"; fi
    } > "$out"
    cat "$out"
    say
    say "Everything above is saved in $out . Send that file (or paste it) in the chat."
}

case "${1:-}" in
    info) info ;;
    monitors)
        case "${2:-}" in
            start) mon_start ;;
            snap) mon_snap "${3:-screens now}" ;;
            report) mon_report ;;
            *) mon_guided ;;
        esac ;;
    fps) fps_line ;;
    report) report ;;
    *) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//' ;;
esac
