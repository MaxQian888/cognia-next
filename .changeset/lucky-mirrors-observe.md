---
"cognia-next": minor
---

Website: the homepage now shows the product instead of describing it. Every large product visual was
an empty frame holding a sentence of alt text, because the screenshot matrix is still blocked on a
product-side seed seam — so the hero's near-full-width stage was a blank box about a screen tall.
The stage now falls back to a DOM reconstruction of the workbench (activity rail, task thread, and
the change open in the workspace dock), permanently labelled as a reconstruction rather than passed
off as a screenshot, and a real capture still wins whenever one exists.

The signature task section gained the six interfaces the design asks for and previously only talked
about: repository context, the proposed plan, the change as an actual unified diff, the permission
checkpoint with its action, target and scope, the failing check's output, and the launch-notes
artifact. The desktop section gained its macro crop — command palette over the integrated terminal,
with the notification a waiting task sends. The workbench bento's regions now carry fragments of the
same task instead of a paragraph each, the connection receipts read as numbered records, and the
twelve-column rhythm lines behind the hero are drawn at last.

Also fixes the hero's product visual being invisible until you scrolled: it was gated on an in-view
trigger it could never satisfy, since its top sits at the fold.
