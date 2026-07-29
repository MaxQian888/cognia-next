---
"cognia-next": patch
---

A workflow holding a node this app no longer provides now says so, in the editor, before you run it.

Two things were wrong. The editor never checked node availability at all: the check exists, but it only runs when the caller passes a predicate for it, and the editor — its only caller — never did. And when such a workflow ran anyway, the step failed with "install the plugin that provides it", which for a node that was removed from the product is advice you cannot act on; no plugin will ever provide it.

The editor now reports a removed node as an error naming the version that removed it, which also stops the run from starting rather than letting it fail partway through with some steps already done. Nodes whose plugin is merely uninstalled keep their existing warning, because installing the plugin really does fix those. Runs that never touch the editor — scheduled, triggered through the API, or a workflow whose provider disappears mid-run — get the corrected message too.

The removed kinds this applies to today are the fourteen from the GitHub Delivery removal. If you install the compatibility plugin, it re-registers those same kinds and your workflows are reported as fine, because they are.
