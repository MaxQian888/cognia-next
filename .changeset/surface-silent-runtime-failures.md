---
"cognia-next": patch
---

Two more silent failures now reach the notification center instead of only the console. When Cognia loses its event channel to the desktop backend, the surfaces fed by it used to just stop updating — no error, no log line, no hint that a reload would fix it; it now says so, once, however many subscriptions died. When the built-in skills, characters and teams fail to seed, that used to read as "those features don't exist here" rather than as a failure. Repeats of the same condition coalesce into one counted row rather than a wall of notices.
