---
"cognia-next": patch
---

Saved SSH hosts now actually appear in the device console (`/devices`) and in global search. All three read sites looked for them under `AppSettings.terminalSettings`, a key the settings shape has never declared, so the lookup resolved to `undefined` and every saved profile was silently missing from both surfaces. They now read the real path, `AppSettings.terminal.sshHosts`, which is the same one Settings → Terminal writes. A saved SSH row whose profile is no longer in Settings now says so, instead of rendering a Connect button that is dead with no explanation. Device search also isolates its three sources, so one unhydrated store no longer empties the whole device section of the command palette.
