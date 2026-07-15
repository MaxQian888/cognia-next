---
"cognia-next": minor
---

Record and replay browser actions in the in-app preview. Hit Record in `/browser` and your clicks, typing, selections and key presses are captured as a replayable flow, which you can replay in the pane, save, or export three ways — a Playwright spec, the raw flow JSON, or a summary sent straight to chat. Passwords are never recorded: a password field is captured as a flagged secret with no value, so exports read it from an environment variable and replay asks you for it instead.
