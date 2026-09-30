---
"cognia-next": patch
---

Fix exporting and deleting a conversation on a fresh (encrypted) profile failing with "TransactionInactiveError: Failed to execute 'continue' on 'IDBCursor'": encrypted rows read by cursor now resume iteration inside an active IndexedDB transaction. A provider's "API key is invalid." on the phone's direct path is now reported as an authentication error with a way to the credentials (the HTTP status is carried through, and more rejected-key wordings are recognised). Opaque cross-origin "Script error." events are folded into one counted log entry per five minutes instead of filling the log buffer, log viewer rows no longer overlap after new entries arrive, and logs written to the Android/iOS native console serialize their data instead of printing "[object Object]".
