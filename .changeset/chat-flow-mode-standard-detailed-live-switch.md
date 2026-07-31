---
"cognia-next": patch
---

Chat: fix the agent-flow display switch so standard and detailed are actually distinct. The two modes differ only in the default-open state handed to each tool card's and reasoning block's Collapsible, which is uncontrolled (`defaultOpen`, read once at mount) — so flipping the header/settings switch on an already-rendered transcript changed nothing on screen. The renderer now folds the display mode into the key of just the mode-sensitive parts (tool cards, activity groups, reasoning), so switching modes remounts them and re-applies the per-mode default (detailed expands every completed tool card and thinking block; standard collapses the finished ones). Prose keeps a mode-agnostic key, so a toggle no longer reflows the message text.
