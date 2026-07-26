---
"cognia-next": minor
---

Plugins can now animate and open overlays. `@cognia/plugin-ui` gains a motion facade (`Fade`, `SlideUp`, `Stagger`, `Collapse`, `motionTokens`, `useMotionPrefs`) and six overlay components (`DropdownMenu`, `Popover`, `ContextMenu`, `Sheet`, `HoverCard`, `Command`).

Both close gaps a plugin author could not work around. `react-dom` is deliberately withheld from plugin bundles so a contribution cannot `createPortal` out of its slot and its scoped stylesheet — which also meant a plugin could not build _any_ anchored overlay, making the commonest shape of all, a toolbar button that opens a menu, impossible. And while the host has a full motion vocabulary, none of it was reachable: plugins had a single `--motion-duration-scale` variable and had to invent their own curves, so plugin UI never quite moved like the app around it.

The motion tokens now live in `@cognia/plugin-ui/motion-tokens` with `lib/ui/motion.ts` re-exporting them, so host and plugin animation are the same values by construction rather than by convention. `useMotionPrefs()` tracks the user's reduced-motion and duration settings live, and every facade component degrades to a plain element when animation is suppressed.

`Command` ships without `CommandDialog` and `Sheet` exposes a `closeLabel` prop instead of a hard-coded English string — centered modals remain the runtime `ctx.modal.openModal()` API's job, and plugins have no access to the app's translation catalog.
