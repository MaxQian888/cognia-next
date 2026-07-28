---
"cognia-next": patch
---

Fix `@container` rules silently never matching inside a plugin surface that declares no width hint. The shared surface boundary is documented to plugin authors as a query container — "Slot wrappers are query containers (`container-type: inline-size`), so use `@container` rather than measuring" — but it only became one when the contribution happened to declare a `minWidth` or `maxWidth`. Everything else was wrapped in a `display: contents` box, which generates no principal box at all, and `container-type` is inert without one. A plugin that styled itself responsively looked correct in a hinted slot and quietly lost every breakpoint everywhere else.

Hosts that genuinely need the surrounding layout left alone still get it: Context Workbench panels opt out with `container={false}`, because containment re-anchors absolutely positioned descendants. That opt-out is now load-bearing rather than decorative — previously it was only consulted on the hinted path, so the one call site using it was passing a flag that could not change the outcome.
