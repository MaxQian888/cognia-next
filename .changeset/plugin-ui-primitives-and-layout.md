---
"cognia-next": minor
---

Plugin authors get the rest of the component surface and their first real layout control.

`@cognia/plugin-ui` adds twelve primitives — `Accordion`, `Avatar`, `Collapsible`, `Progress`, `RadioGroup`, `ScrollArea`, `Separator`, `Skeleton`, `Slider`, `Switch`, `Table`, `Textarea` — bringing the kit to eighteen components plus the motion facade. `Progress` deliberately diverges from the host's version, which destructures `value` and then never forwards it to the Radix root: the bar is stuck reporting `indeterminate` and emits no `aria-valuenow`, so it is silent to screen readers. The fork forwards `value` and `max`, normalises the indicator against `max` rather than a hard-coded 100, and clamps out-of-range values. A plugin could not have worked around this from the outside, since `value` was being swallowed before it reached Radix.

On the layout side, three additions that plugins previously had no equivalent of:

- `ctx.modal.openModal(component, args, options)` accepts `size` (`sm`/`md`/`lg`/`full`) and `variant` (`center`/`sheet-right`/`sheet-bottom`). `manifest.modalMounts[]` takes the same options as declared defaults, validated at install, so deep links and slash commands — which have no call site to pass anything — are not stuck with centered modals. Existing two-argument calls are unchanged.
- Context-panel width now persists per panel id and is restored on reveal, reusing the workbench's existing persisted layout store rather than introducing a second writer.
- `registerExtension(point, component, options)` accepts `minWidth` / `maxWidth` hints. The slot honours them clamped to its own bounds, so a contribution can ask for room without being able to break the host's layout.
