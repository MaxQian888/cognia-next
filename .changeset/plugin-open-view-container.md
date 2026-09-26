---
"cognia-next": minor
---

Plugin API: `ctx.ui.openViewContainer(id)` shows one of a plugin's own view containers. It is the only way to open a `location: "panel"` container, which has no rail button. It needs the `extension:ui` permission and refuses another plugin's containers. Python plugins get it through `ctx.ui` too, and `isViewContainerOpenError` from `@cognia/plugin-sdk` tells the refusal reasons apart. A plugin's "Contributed" tab can now open panel containers as well.
