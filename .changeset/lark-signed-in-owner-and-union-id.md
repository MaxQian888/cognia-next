---
"cognia-next": patch
---

Feishu bots now recognize you once you confirm yourself: the connector records each sender's `union_id`, a bind request from the Feishu account you signed in with is labeled "matches your sign-in" with a "This is me" approval, and after that one confirmation the same account reaches your other bots in the tenant without a new bind code (only over the long connection or a signed webhook, and only while you stay signed in). Bind approvals and sign-ins also fill in the person's login subject, and the lark-cli skill reads the app ID from the keyring where the settings form stores it instead of always failing with "no appId".
