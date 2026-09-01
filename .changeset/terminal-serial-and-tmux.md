---
"cognia-next": minor
---

The terminal dock can open a serial port and attach to a running tmux session. Both were fully written on the TypeScript side and had no Rust behind them, so every call returned a dispatch error and neither had a way in. A serial port now opens as an ordinary tab, with xterm, search, splits and scrollback, and a baud rate chosen from the same menu. tmux sessions on the host are listed with their window counts, and picking one opens a shell already attached to it.
