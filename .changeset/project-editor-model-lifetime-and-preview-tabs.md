---
"cognia-next": minor
---

The project editor no longer throws your undo history away when you switch tabs. Every tab switch used to tear down the Monaco editor and destroy the file's model with it, so undo/redo, folding, the cursor position and the scroll offset were all gone the moment you came back to a file. One editor now serves every tab and swaps models instead, and a new model registry disposes a file's buffer only when the file is actually closed.

Tabs also gain VS Code's preview behaviour: clicking a file in the tree opens it in a single reusable italic tab, so browsing no longer leaves twenty tabs behind. Double-click the file, double-click its tab, use the new pin button, or just start typing, and the tab becomes permanent. Anything that deliberately opens a file — search results, terminal path links, session restore, the agent bridge, creating a new file — still opens a permanent tab as before.
