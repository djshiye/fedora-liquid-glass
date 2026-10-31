# Hardware checks

Two short checks that need a real PC rather than the cloud test desktop:

1. **Screen unplug**: windows keep (or get back) their glass when a screen is unplugged
   and plugged back in, and GNOME Shell doesn't crash.
2. **Smoothness**: how many frames per second the genie minimize, the panel hover and a
   window drag really get on your graphics card.

Both are read-only. They never ask for `sudo`, change no setting, send nothing anywhere,
and write only to `~/liquid-glass-checks/`.

## Get the files

```bash
mkdir -p ~/liquid-glass-checks && cd ~/liquid-glass-checks
curl -fsSLO https://raw.githubusercontent.com/djshiye/fedora-liquid-glass/main/tools/hardware-check/lg-hwcheck.sh
curl -fsSLO https://raw.githubusercontent.com/djshiye/fedora-liquid-glass/main/tools/hardware-check/fps.js
sha256sum lg-hwcheck.sh fps.js     # compare with the values posted with the request
chmod +x lg-hwcheck.sh
```

## Run them

```bash
./lg-hwcheck.sh info        # what PC, GPU and screens this is
./lg-hwcheck.sh monitors    # guided: unplug a screen, plug it back, answer two questions
./lg-hwcheck.sh fps         # prints one line to paste into Looking Glass (Alt+F2, lg)
./lg-hwcheck.sh report      # puts everything into one file to share
```

### What the smoothness check measures

`fps.js` runs inside GNOME Shell for about 70 seconds. A card at the top of the screen
says what to do: hands off, minimize and restore a window, hover the panel icons, drag a
window. It listens to GNOME Shell's own `before-paint`/`after-paint` frame signals and
records, per screen and per step:

- **fps while moving** and the **gap between frames** (p50, p95, p99, max),
- **late frames**: gaps longer than 1.5 refresh intervals (at least one missed frame),
- **draw time**: GNOME Shell's CPU time per frame (GPU-bound frames show up as late),
- how often the genie fell back to a plain scale because frames were too slow,
- how many times the glass re-rendered.

All signal handlers, timers and the card are removed at the end.
