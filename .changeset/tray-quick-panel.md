---
"cognia-next": minor
---

Clicking the tray icon now opens a quick panel for delegating a task or firing a shortcut, without bringing the main window forward. The panel is fully customizable: every entry defines its own input fields, what it does (delegate a prompt, run a slash or plugin command, open a page, or fire a tray action), and when it fires (on click, as the primary Enter action, on a keyboard chord, or when the panel opens). Open-triggered actions are limited to page navigation and plugin commands so merely viewing the panel cannot start a billed turn or mutate native state. Fields feed the action through `{{placeholder}}` references, so an input can even choose the destination conversation. Configure it under Settings › Desktop, where the tray-click behaviour can also be set back to showing the main window.
