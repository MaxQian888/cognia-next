---
"cognia-next": patch
---

The `cognia-server` image no longer installs GTK or WebKitGTK. The headless Host is now its own package that links no desktop GUI stack, so the image is smaller and builds without the Tauri Linux dependencies.
