---
"cognia-next": minor
---

Open `ctx.ai` to Python plugins: `ctx.ai.embed`, `ctx.ai.getDefaultModel`, and the other introspection methods are now declared python-reachable in the interface catalog (still permission-gated by `ai:embed`/`ai:chat` in the manifest). `ctx.ai.chat` answers with its full `{text, finishReason, usage}` — the host request router drains a method's async-iterable result into one JSON value rather than shipping the generator's `{}` husk, and `ctx.ai.registerProvider` stays refused as a host-callback method.
