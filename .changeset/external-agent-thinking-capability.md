---
"cognia-next": patch
---

Reasoning-effort control now tells the truth on every external agent, and works on OpenCode V2. The capability manifest read `thinking` as "the agent streams reasoning" rather than "Cognia can set the level", so `/think` opened an effort slider on ACP (Claude Code) and both OpenCode majors and forwarded the pick nowhere. ACP has no such method and OpenCode V1 has no reasoning field on its API at all, so both now report unavailable with the reason that applies. OpenCode V2 gains a real one: the session panel offers the current model's variants — OpenCode's named request overlays for reasoning effort — and the pick rides `session.switchModel` as the `variant` half of the model reference, the `provider/model#variant` form OpenCode documents. Picking a model clears the variant, since variants are per-model and an unknown one fails model resolution. Codex and Pi are unchanged.
