---
"cognia-next": patch
---

Fix a crash where evaluating any module that imports the `ai` SDK threw `TypeError: os.platform is not a function`. Deps pulled in transitively by `ai` (`@ai-sdk/gateway` → `@vercel/oidc`) read `os.platform()`/`arch()`/`hostname()` at module-eval time, which the empty `os` browser stub turned into `undefined()` calls. `os` now resolves to a small browser-safe shim in the client/static-export bundle. Also add the missing `account.passwordStrength` translations so the password-strength meter no longer throws `MISSING_MESSAGE`.
