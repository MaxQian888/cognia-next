---
"cognia-next": minor
---

External agents can now say whether they reach the web on their own. `web.search` joins the external-agent capability matrix, shipping `unknown` on all seven protocol rows — because it genuinely is unknown: whether a Codex or ACP build has web search switched on is a property of the binary and plan someone installed, not of the wire protocol, and asserting either way from a checked-in table would be guessing on the user's behalf. A new `user-declared` merge layer (and a matching evidence grade) is how it stops being unknown: Settings → external agent gains a "brings its own web search" tri-state, stored on the agent config and merged above the static layers but below a live handshake, since a measurement outranks a claim. A declaration can fill an `unknown` or tighten it; it cannot widen a protocol-level `unsupported` back to `native` — a declaration that needs to do that means the manifest row is wrong.

Deliberately NOT included: inferring the capability from watching an agent call `web_search`. Cognia hands out a tool by that exact name, so an observation cannot tell "the agent searched with its own tool" from "the agent used ours" without also knowing what the turn supplied it — and getting that backwards would silently mark an agent self-sufficient and leave its turns with no web at all.
