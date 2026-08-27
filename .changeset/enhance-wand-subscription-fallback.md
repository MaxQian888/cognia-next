---
"cognia-next": patch
---

Composer: the prompt-enhance wand now works on a Claude subscription. It resolved its model only through the renderer-side provider client, which requires a BYOK API key in settings — a subscription keeps its bearer in the keyring and never hands it to the renderer, so every rewrite answered "no model configured" on a fully configured install. It now falls back to one headless, toolless turn over the same transport the chat uses (unpersisted session id, PII gate unchanged); a configured BYOK key still takes the cheap direct path first.
