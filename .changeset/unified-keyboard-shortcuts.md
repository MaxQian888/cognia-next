---
"cognia-next": minor
---

Unify keyboard-shortcut settings into a single **Settings › Keyboard shortcuts** page that groups all three scopes — global system hotkeys, in-app shortcuts, and Canvas editor keybindings — in one place with search and conflict detection. Every previously-hardcoded in-app shortcut (terminal toggle, zoom, focus-search, the Skills panel keys, the artifacts/Canvas rail toggles, the observability dashboard keys, and the A2UI workspace editor) is now rebindable through a single keydown dispatcher, and overrides persist across restarts. The recorder warns when a chord collides with another in-app shortcut (blocking) or with a per-platform system-reserved shortcut such as Spotlight or Alt+Tab (non-blocking). The desktop-pet toggle-hotkey link and the old scattered entry points now lead to this unified page.
