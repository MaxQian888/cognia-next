---
"cognia-next": minor
---

Pro IDE (embedded code-server) is now a first-class editor surface: switching tabs or routes no longer reboots VS Code, the chat-side workspace dock can host it too, running instances are visible and stoppable under Performance → Managed Processes, a new Settings → Pro IDE card manages the install and disk usage, a health watchdog surfaces a crashed code-server instead of leaving a dead page, and the Agent Team editor tab now fills its pane instead of sitting in a fixed-height scrolling box.

Polish in the same pass: collapsing the sidebar no longer smears the embedded editor, the first-run download shows a real progress bar, the placeholder stays up until the editor has actually painted (no more flash of empty background), a crashed instance is parked so its own retry button is reachable, the engine switch is a proper single-choice radiogroup with keyboard navigation, and where the embedded editor has no build the toggle now offers to open the project in your local VS Code instead of just saying you should.
