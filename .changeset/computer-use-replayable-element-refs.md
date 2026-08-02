---
"cognia-next": patch
---

Fix macOS Computer Use element references going stale. Picking an element, finding one, or reading the focused window previously handed back a reference that could only be looked at, never acted on — and references from a tree read stopped working as soon as the next tree read happened. References are now re-resolvable recipes that survive both, and refuse with a clear "stale element" error when the UI has changed enough that they would otherwise click the wrong control.
