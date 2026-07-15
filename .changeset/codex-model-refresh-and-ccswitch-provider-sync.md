---
"cognia-next": minor
---

Refresh the Codex (OpenAI) model list and make a CCSwitch provider switch show up immediately. The Codex provider offered only the retired `gpt-5.2-codex` / `gpt-5.1-codex` / `gpt-5.1-codex-mini` line-up, and it now tracks the models Codex actually exposes — GPT-5.6 Sol / Terra / Luna, GPT-5.5, GPT-5.4 and GPT-5.4 Mini — with correct context windows, cache-aware pricing, and GPT-5.6 Sol as the default. Codex was also defined twice internally, and the duplicate quietly shadowed the real entry: it stripped Codex's API protocol and default base URL, and meant the model list had to be edited in two places to take effect. Codex is now defined once, so it keeps both.

Switching providers from Settings → CCSwitch also no longer leaves the rest of the app on the previous provider: the switch wrote straight to the database behind the settings layer the UI renders from, so Settings → Providers and the model picker kept showing the old provider and models until the app was restarted. The switch now writes through the same path everything else reads, so the new provider, models and default appear right away.
