---
"cognia-next": minor
---

Ship RepoWiki in the installer. Python and WASM plugins need a directory on disk before the desktop host can find them, `plugins/` was not in the Tauri bundle resources, and nothing ever copied one into the host's plugin directory, so RepoWiki (a full subsystem with its own 213-case gate suite) existed only for people who cloned the repository. A curated staging step now puts its shipping files, and only those, into the bundle with a per-file digest, and the renderer seeds them once per version through the existing atomic install command. It installs without enabling, so startup cost is unchanged. A new gate makes the same omission impossible for the next on-disk plugin: one that is neither bundled nor marked dev-only fails the sweep.
