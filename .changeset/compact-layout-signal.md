---
"cognia-next": minor
---

Narrow browser windows now get the phone-shaped layout instead of the desktop three-pane workspace. The app had two competing answers to "am I mobile": a Capacitor-runtime check used by about a dozen route-level layout branches, and a viewport check used by four. A 375px-wide browser tab matched the second but not the first, so it rendered the full desktop shell with the guild rail hidden below `md`, which left it with no navigation at all, and `/me` redirected it away to the desktop settings page.

Layout now asks `useCompactLayout()` (viewport width, or a native mobile shell at any width) and both app shells agree through one shared predicate, so exactly one of them draws the frame. Genuinely native behaviour stays on the runtime check: the automation consent sheet and the launch landing redirect do not follow a resized browser window, and the Tauri desktop shell always keeps its own title bar because that is where the window controls live.
