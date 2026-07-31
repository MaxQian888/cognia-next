---
"cognia-next": patch
---

The Pro IDE stops discarding your editor settings on every launch. Starting the managed profile re-copied a small allowlist of preferences across from the native profile and did it by replacing whole files, so anything you had changed from inside VS Code — and every setting outside that eleven-key list — was gone the next time you opened the pane. Custom keybindings were worse: that copy is their only writer, so they were deleted outright rather than merely overwritten.

The copy is now a one-time seed, which is what the operations guide always described, and it merges instead of replacing. Afterwards the managed profile belongs to you and to Cognia's own appearance sync; the native profile is no longer given the last word on the eight keys the two lists share, which is what produced the theme flicker on startup.

Settings Cognia owns — theme, typography, accessibility — repair themselves the next time the pane opens, because that sync already read-merge-writes. Anything else you had set from inside VS Code before this release, and any keybinding you authored there, was already lost and cannot be recovered; there was no backup. On upgrade the seed runs once more, now merging, and then never again.
