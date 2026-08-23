---
"cognia-next": minor
---

Approvals and questions now look and behave the same wherever they are answered. The phone used to show a raw dump of a tool's arguments where the desktop showed a diff or a shell command, with no truncation, no note of which subagent asked, and no honest handling of a decision the run had already given up on — all three are fixed by sharing one decision surface. A watcher without remote control now sees that a decision exists without its arguments, and has nothing to press. Multi-select questions render as checkboxes instead of a box to type the options into by hand, and a question's free-text box keeps its label.

Queued actions for one session are now sent strictly in order: a message whose first attempt hit a flaky link no longer gets overtaken by the follow-up typed after it, while other sessions keep draining independently. Actions the host refused, or that ran out of retries, are finally counted somewhere the user can see — until now a refused action looked exactly like one that had gone through.
