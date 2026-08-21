---
"cognia-next": patch
---

Connector OAuth callbacks are now localized. The deep-link router reported "OAuth state mismatch", "No OAuth handler for …" and "… connected successfully" as hard-coded English regardless of locale, and the mismatch case now explains what to do about it instead of naming an internal check.
