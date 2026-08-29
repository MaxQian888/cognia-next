---
"cognia-next": patch
---

Workflow editor: the AI proposal banner exists again, and "Reveal" now reveals. The sticky banner that pins an open proposal's Apply / Discard controls to the top of the editor's chat pane was fully built but never mounted anywhere, which also silenced the notifications it raises when a proposal is opened, applied or discarded by the agent through a tool path rather than by a click. It is mounted now. Separately, the Changes tab's "Reveal" button rendered with no handler attached at all — clicking it did nothing; it now brings the chat panel forward and scrolls to the proposal card, falling back to the message that carried it when the card itself has scrolled out of a virtualized list.
