---
"cognia-next": patch
---

Global developer mode now has a single switch. The plugin devtools panel used to keep its own `cognia.plugins.developerMode` localStorage flag while the plugin store kept a separate persisted `developerModeEnabled` setting that nothing wrote to, so the panel could be unlocked while the rest of the app still considered developer mode off. Both now read and write the persisted store setting, the old localStorage flag is adopted once at startup (and left in place so downgrading keeps it), and a development build still enables developer mode automatically. The per-plugin `debug` / `devMode` instrumentation flag is unchanged.
