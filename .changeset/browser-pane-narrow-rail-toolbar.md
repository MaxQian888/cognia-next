---
"cognia-next": patch
---

Embedded browser pane now behaves in a narrow right rail. The toolbar packs
itself against its measured width instead of wrapping into three or four rows:
back / forward / reload and the address bar stay inline at every width, while
the inspection actions (history, screenshot, select element, find) and the
set-once page actions (zoom, cookie import, open external) collapse into a "⋯"
popover as room runs out — the trigger carries a dot when something packed away
is armed. The address bar takes the leftover width and, while it mirrors the
live page, paints a host-first form over the field (scheme, `www.` and a bare
trailing slash dropped, path dimmed, lock icon for https) so truncation eats the
path instead of the host; focusing still reveals and copies the real URL. The
annotation-detail selector moved into the popover, the driver indicator drops to
its icon when narrow, and the selection/annotation rail stacks under the page
rather than taking 320px of it.
