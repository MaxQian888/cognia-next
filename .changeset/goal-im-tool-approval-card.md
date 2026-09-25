---
"cognia-next": patch
---

A goal started from an IM conversation now asks for tool approval in that conversation instead of denying the tool and pausing. The same Allow / Deny / Allow-for-session card as the conversation's other turns goes to the person who sent `/goal`, and a turn can wait up to 10 minutes for an answer. Deny is an answer: the model is told and the goal carries on. `yolo` mode and tools already allowed for the session skip the card. The goal pauses with `needs_approval` only when a card expires unanswered or cannot be delivered, and `/goal resume` asks again. Scheduled goals are unchanged.
