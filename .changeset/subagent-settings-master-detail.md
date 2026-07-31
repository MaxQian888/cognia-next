---
"cognia-next": minor
---

Rebuild the Sub-agents settings section as a master/detail layout and close the gaps that left it unable to describe its own data model.

- **Tool access is now editable.** `config.tools` has always been read by the dispatch projector but had no writer. A tri-state control (inherit / custom list / disable all) plus a searchable picker over the real tool catalog now expresses all three meanings the field carries — including the difference between "inherit" and "no tools at all", which a plain multi-select cannot show.
- **Sub-agents can be turned off without deleting them.** The `disabled` and `hidden` flags are enforced by every resolver; both now have switches, and the availability each produces is stated on the panel.
- **Running sub-agents can be cancelled**, and nested runs render as the parent→child tree the records already described. Finished runs can be cleared. A cancel that cannot reach its run says so instead of claiming success.
- **Silent overrides are surfaced**: a system prompt retiring the task template, a pinned provider or external runtime taking a template out of ordinary chat, and task-template placeholders that are undeclared (or declared and unused).
- **One save per panel**, with an unsaved-changes bar and a discard. The policy cards previously re-read the settings store on every change, so an unrelated save elsewhere in the app silently discarded whatever was being typed.
- Layout matches the other heavy settings sections (grouped nav + detail pane, full height), with motion throughout that collapses under reduced-motion. The category filter is now keyboard-reachable.
- Mobile's read-only list mirrors the new disabled/hidden state so the two surfaces agree.
