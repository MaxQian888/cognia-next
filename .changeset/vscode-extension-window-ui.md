---
"cognia-next": minor
---

VS Code extensions can now talk to the user: information, warning and error messages (as toasts, or dialogs when modal) return the chosen item; quick picks and input boxes, including live `createQuickPick` / `createInputBox` with multi-select, buttons, busy state and validation, open in the app; `withProgress` shows a notification with a working Cancel or a status bar spinner; status bar items and messages appear in the status bar and run their commands; output channels (including log channels) write to the plugin's logs with an "Open logs" notice; and open/save dialogs use the desktop's native file dialogs. A stray promise rejection in an extension is logged instead of crashing its host.
