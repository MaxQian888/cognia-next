---
"cognia-next": patch
---

The account auto-lock timeout now actually locks the app after the configured minutes of inactivity (previously the setting had no effect). It uses a wall-clock deadline, so the app also locks correctly when it returns to the foreground after sitting idle in the background past the timeout.
