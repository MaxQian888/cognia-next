---
"cognia-next": patch
---

Mobile readability and layout fixes. With a wallpaper on, sheets, dialogs, drawers, popovers, menus, select lists, toasts and tooltips are now near-opaque, so the page underneath no longer reads through them (the slash menu, the model picker, session settings, the Discover detail card and the Edit character form were unreadable on Android, where the backdrop blur is often not painted). The mobile workflow canvas has a solid ground instead of showing the wallpaper behind nodes and edges. The mobile workflow editor's top bar keeps the workflow name visible at phone width: the saved/unsaved badge sits under the name instead of overflowing onto the mode toggle, and select mode and Workbench move into the overflow menu. The half-open workbench drawer no longer lays its content out below the screen, so the artifacts list's empty state (and any panel's bottom row) is visible. The perf HUD never mounts on a touch-only device, where it covered the tab bar.
