---
"cognia-next": minor
---

Restore and redesign the composer's thinking-level (reasoning effort) control. It had disappeared entirely on a default install: the Anthropic capability table still matched only Opus 4.5–4.9 / Sonnet 4.6 / Fable 5, so on the shipped default model (`claude-sonnet-5`) the offered ladder came back empty and the control removed itself. The Claude 5 family is now recognised across both capability tables, including Bedrock/Vertex/gateway spellings, and the parity test pins the ids the app actually ships on.

The control also moves out of the bottom of the model popover onto its own composer toolbar chip, which shows the active tier at a glance and opens a redesigned card: an "Effort · <tier>" header with inline help, a Faster→Smarter track with a raised knob, friendly tier names (Low / Medium / High / Extra / Max / Ultracode) in place of raw wire values, and a distinct violet dot-lattice track for Ultracode, which is a change in kind rather than one more step. The in-popover copy stays, sharing one component and one piece of state.

Coverage now extends past the built-in Claude rail: every reasoning-capable provider keeps the ladder its wire surface can actually distinguish, and external CLI agents (Codex and peers) get the generic low/medium/high ladder plus the level they were previously denied — their effort had been gated on the session's Anthropic model, which that rail never runs.

Two new preferences under Settings → Conversation → Input & sending: a default thinking level stamped onto every new conversation, and per-tier visibility for users who want a shorter track. Hiding is presentation only — a conversation already on a hidden tier keeps running at that depth.
