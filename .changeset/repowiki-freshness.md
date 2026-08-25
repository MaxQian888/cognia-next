---
"cognia-next": minor
---

The RepoWiki reader now says whether the wiki still matches the code — including when it cannot tell.

The panel compares the commit the wiki was built at against the checkout now, and badges the result. Three states, not two: a freshness check that cannot be answered — the path is not a repository, this runtime has no git bridge, no commit was recorded — used to render exactly like a current wiki, so "Freshness unknown" is its own muted badge and the reason joins the warnings banner. Both states offer the rescan.

The side conversation reads the same answer, so a model answering from a stale wiki says so rather than presenting it as current.

A plugin workspace handle now carries `headRef`, the commit the checkout was at when it was acquired. Without it `ctx.workspace.changedSince` could not tell "nothing changed" apart from "the host could not compute a diff".
