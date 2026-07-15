---
"cognia-next": patch
---

Fix the chat view not following the bottom while a reply streams in. When the user was already scrolled to the bottom, new tokens were supposed to keep the view pinned there, but the streaming text renders through `useDeferredValue` (and async syntax highlighting), so the visible height grows one or more frames after the `messages` state changes — the stick-to-bottom effect pinned to the pre-growth height and never re-fired for that deferred growth, letting the reply scroll up off screen. The message list now observes the content box and re-pins to the bottom on any height change while the user is at the bottom, so streaming replies stay in view. Still gated by the existing `composerBehavior.autoScrollOnStream` toggle and never overrides a user who has scrolled up.
