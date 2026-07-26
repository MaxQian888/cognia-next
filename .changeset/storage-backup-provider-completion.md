---
"cognia-next": minor
---

Encrypted backup to WebDAV and consumer cloud storage now actually works end to end, and stops trusting bad certificates by default.

Three contracts were incomplete. The desktop HTTP bridge rejected the WebDAV verbs the protocol requires, so connection tests, collection creation and directory listing failed on Tauri — `HEAD`, `OPTIONS`, `PROPFIND` and `MKCOL` are now allowlisted, and unknown methods stay rejected. Every WebDAV client implicitly accepted invalid TLS certificates while Tauri ignored the flag entirely; `allowInvalidCertificates` now defaults to `false` across settings, the TypeScript transport, Tauri serialization and reqwest, and when you do enable it, it applies only to that one endpoint's request client. And scheduled-backup selection controls no longer disagree with the payload that gets written: every selection maps to an exact payload, API keys stay out of scheduled runs, and the complete non-builtin plugin domain round-trips through export and restore.

Setup also gets shorter. Nutstore, Koofr, pCloud (US and EU) and Yandex Disk ship as presets with their documented endpoints applied for you; self-hosted Nextcloud and ownCloud stay user-supplied, because the host and username path are private configuration. Google Drive, Dropbox, OneDrive and iCloud Drive are supported as a distinct mode that writes the encrypted file into a folder their own desktop client already syncs — no unofficial APIs and no second sync engine. You can also hand configuration to the assistant without pasting anything sensitive: the AI-guided entry point names only the provider and its public documentation, never credentials or private paths.
