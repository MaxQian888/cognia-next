---
"cognia-next": patch
---

The idle auto-lock no longer arms in development builds, so `pnpm dev` / `pnpm tauri dev` sessions stop locking mid-debug (set `NEXT_PUBLIC_ACCOUNT_GATE=1` to exercise the lock screen in dev). Also, when a backgrounded window returns past the lock deadline, live streaming or approval-waiting turns are now interrupted before locking instead of being torn down silently.
