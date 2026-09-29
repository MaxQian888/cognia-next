---
"cognia-next": patch
---

Redaction now also catches Stripe, GitHub user/refresh, AWS temporary, Google OAuth, Meta, Telegram and Slack app tokens, `Bearer` tokens, secret-looking environment assignments and credential directory paths, and ignores terminal escape / bidi control characters that could split a secret.
