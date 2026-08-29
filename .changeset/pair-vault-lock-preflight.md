---
"cognia-next": patch
---

Stop `/pair` from burning a one-shot invitation against a locked account, and give the failure a way back to the lock screen. Dev builds no longer auto-unlock on the web, where the password is the vault key — the account gate now runs there as it does in production.
