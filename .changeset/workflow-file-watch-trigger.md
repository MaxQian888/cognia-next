---
"cognia-next": minor
---

Workflows can react to a file changing. Point the new trigger at a directory and it fires when something under it changes, honouring .gitignore and whatever include or ignore globs you give it.

The interesting part is that it cannot chase its own tail. A workflow that reacts to file changes and then writes files is a loop, and no amount of debouncing closes it, because the run outlives any plausible debounce window. So the watch goes silent the moment it fires and stays silent for the entire run it started, plus a settling period afterwards. Everything the run writes under the watched directory is seen and discarded. That holds whichever way the run writes, whether through a file node, a terminal command, git, an agent turn or a plugin, because none of them has to know the watch exists.

A crashed window cannot brick it either: the mute lifts itself after ten minutes, so the worst case is a late re-arm rather than a trigger that never fires again. A build running inside a watched directory is capped rather than allowed to start a run per file. And a directory that changed while the app was closed produces one summary event with a count, never a replay, and only if you ask for it.

Desktop only, and it says so: it needs a native watcher that outlives the window, and it refuses to watch your whole home directory or the filesystem root.
