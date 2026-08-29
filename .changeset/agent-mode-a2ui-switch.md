---
"cognia-next": patch
---

Agent Modes: the "Enable A2UI" switch now affects the turn. Two switches in the custom-mode editor wrote `a2uiEnabled` onto the mode record and nothing in the send path ever read it, so turning it on changed nothing about how the agent replied. A mode that asks for A2UI now gets the A2UI tools and prompt section, ranked between the session's own toggle (which still wins, being the closer scope) and the character's standing default.
