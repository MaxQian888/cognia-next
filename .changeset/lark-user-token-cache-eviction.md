---
"cognia-next": patch
---

Lark send-as-user: re-authorizing now takes effect immediately. The in-process user-token cache holds a keyring read with no known expiry and was never evicted when a new token was stored, so re-authorizing (to add a scope, or to connect as a different user) kept sending with the previous token until the app was restarted.
