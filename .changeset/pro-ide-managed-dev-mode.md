---
"cognia-next": minor
---

Pro IDE plugin authors get Managed IDE Dev Mode in Plugin DevTools: a live trace of the editor broker (payload values only on request, and redacted), per-session permission simulation with a badge on the plugin, live `manifest.ide` diagnostics for plugin folders, and folder-based development where an edit reinstalls the plugin and reloads it with a temporary Pro IDE proxy, trusted only while Dev Mode is on. A plugin folder or zip can no longer bring its own verification receipt, and Pro IDE proxies are built only for plugins the app verified.
