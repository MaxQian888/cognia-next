---
"cognia-next": minor
---

Select text anywhere on the desktop and a small Cognia toolbar appears beside it, offering to copy it, explain it, translate it, or ask about it. It is a real system-level overlay rather than an in-app feature: it works in your browser, your editor, a PDF, a chat client — anywhere the OS reports a selection — and hands the text to Cognia without a copy, an app switch, and a paste.

The toolbar lives in its own borderless window that never takes focus, so the selection you just made is still a selection when you click an action. It dismisses itself when the selection clears or you click away, and it restores itself after a restart, so enabling it once is enough. Settings → Desktop gains its own controls: the on/off switch, and a per-application block list for the apps you would rather it never read.

Desktop only, and off until you turn it on. Reading a selection screen-wide needs the OS accessibility permission, so the panel says so and points at the system prompt instead of failing silently without it; the app never asks for that permission on your behalf. Nine credential managers — 1Password, Bitwarden, LastPass, Dashlane, KeePass, Authy, Microsoft Authenticator, Keychain Access, and Cognia itself — are refused before the block list is even consulted, so the toolbar cannot be turned on for them. The web and mobile shells are unaffected.
