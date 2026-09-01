---
"cognia-next": minor
---

The Twin registry and the issue tracker now reach a paired phone. Discover's
Twin section, the issue board, the delivery-container list and the workspace
switcher all read tables that were never mirrored, so each of them rendered an
empty state on every device. Twin sources are read live from the host instead
of a local mirror, renaming one there now reaches the host rather than a local
copy, and /issues and /projects finally have a way in from /me. Each of these
surfaces now shows a loading state while its first sync is in flight instead of
claiming there is nothing to show.
