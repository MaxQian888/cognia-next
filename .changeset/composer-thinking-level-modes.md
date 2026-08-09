---
"cognia-next": minor
---

Complete the composer's thinking-level control.

**Two presentations**, chosen in Settings → Conversation → Composer behaviour (and on mobile under Me → Conversation): a **slider** (Faster → Smarter, the default) mirroring the CLI's effort slider — same keyboard map (←/→/↑/↓, Home/End, digits, `0` for the model default), click-anywhere and drag on the track — and a **list** with a one-line description per level. Both drive the same state, and each adapts to the width it is given rather than a viewport breakpoint, so the control stays usable in a narrow chat sidebar or on a phone.

**The levels now match the provider.** The control used to offer the same fixed set everywhere, and several entries were fictional: OpenAI rejects `max` (it was silently folded to `xhigh`), and an OpenAI-compatible gateway folds both `xhigh` and `max` down to `high` — three controls with one effect. Each provider now offers only the levels its wire surface actually distinguishes, resolved from the very tables that do the folding, so the two can't drift. A level a newly-picked model can't honour is shown as the level that will really be sent, without overwriting your choice. The same fix reaches the model catalog, whose per-model reasoning tiers were a hardcoded placeholder that badged (for example) Sonnet 4.5 with effort levels it rejects.

**The level finally reaches external agents.** On the Codex runtime the composer's thinking level was silently inert — only the per-agent settings panel had any effect. It is now sent per session, taking precedence over the agent default, and folded onto whatever ladder the selected model publishes.

Adds the composite **ultracode** level (maximum-but-one reasoning plus the dynamic workflow `wf_*` tools for the turn) on the providers where it is meaningful; picking it actually exposes those tools, and they survive semantic tool-routing. Chinese level names are translated (轻度 / 中 / 高 / 极高 / 最高 / 超级) instead of showing raw English ids, and the model chip shows the level you picked rather than the raw effort it maps to.
