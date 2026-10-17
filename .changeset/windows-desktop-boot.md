---
"cognia-next": patch
---

The Windows desktop app starts cleanly: background Node and probe processes no longer flash console windows, sidecars start from paths with spaces or non-ASCII characters, the installer stays under Windows' path-length limit, and a stuck first paint still reveals a framed window. The desktop shell no longer registers the web PWA service worker or reloads on reconnect, and window controls stay available on sign-in, loading and safe-mode screens.
