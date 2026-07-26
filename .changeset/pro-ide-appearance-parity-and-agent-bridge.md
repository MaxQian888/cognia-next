---
"cognia-next": minor
---

Pro IDE now matches the rest of the app's appearance and can be driven by the agent. A single palette resolver (`resolveAppPalette`) replaces the four diverged consumers that previously each rebuilt the theme on their own, so high-contrast and colorblind palettes now reach the embedded editor, the native window chrome, and the mobile status/navigation bars instead of leaving them tinted from the normal palette. The editor's title bar, status bar, terminal, and menus follow the active theme rather than falling back to a stock VS Code look, and the embedded webview paints its own background from the same source so a reload no longer flashes the platform default.

The Pro IDE also follows the app's display language: the locale is written into `argv.json` and the matching language pack is installed, with a toast explaining the required workbench restart — or saying so plainly when VS Code ships no translation for the selected language.

Adds an agent↔IDE bridge so a turn can act on the editor you are actually looking at: the agent can save dirty buffers, show a diff, reveal a file, run a command in the integrated terminal, and post notifications. Unsaved editor buffers are now flushed to disk before a chat turn starts, since the agent's file tools read the filesystem — this stops the agent reasoning about stale content and then overwriting work you had not saved, and warns when a buffer could not be flushed.
