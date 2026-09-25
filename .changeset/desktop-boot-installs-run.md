---
"cognia-next": patch
---

The desktop app now runs the six boot steps a second setup hook had been silently discarding. WASM plugins get their clipboard, notification, AI and workflow services instead of answering "host unavailable"; FCM/APNs push dispatchers configured in an earlier session are restored at launch; task-workspace retention and mirror cleanup run on desktop; the gateway `/v1/runs` surface gets its link to the brain; the backups folder is writable by the atomic backup stream; and the file-access allow-list is seeded at boot (app data, the Claude/Codex/Gemini/Pi config folders and Documents), so a paired device's writes are confined from the first moment instead of being unrestricted until the window finished loading.
