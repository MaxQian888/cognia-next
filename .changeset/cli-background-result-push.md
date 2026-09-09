---
"cognia-next": minor
---

CLI: when a background sub-agent finishes, its result is pushed into the parent chat as a framed turn while the session is idle (or queued behind the running turn, shown as a `↩ N bg result queued` footer chip), so the model reacts without polling `collect`. Results left undelivered by an earlier process are picked up on resume, and the footer's background counters refresh the moment a run settles.
