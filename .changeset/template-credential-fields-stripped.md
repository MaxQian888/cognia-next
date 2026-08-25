---
"cognia-next": patch
---

Templates no longer leak credentials whose field name isn't exactly `apiKey`. Both the portability strip and the validator matched a short list of exact key names, so a field like `defaultApiKey`, `accessToken`, `botToken` or `clientSecret` was neither removed when a template was projected nor flagged when it was validated — and rode a published template to whoever imported it in clear text. Credential detection now matches key stems, with the innocent look-alikes (`maxTokens`, `cacheKey`, …) explicitly excluded.
