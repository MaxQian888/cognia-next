---
"cognia-next": patch
---

Closing the plugin marketplace sources dialog while a catalog refresh is in flight no longer lets that refresh finish writing. The hook tracked only whether a request had been _superseded_ by a newer one, and an unmounted hook has nothing newer to compare against — so its pending fetch still counted as current and went on to write each source's sync health back to the database after the dialog was gone, able to overwrite a fresher result recorded in the meantime.

Marketplace source rows that carry no repository reference are also no longer fetched. Such a row can never resolve to a catalog, so the fetch spent GitHub API budget to guarantee a failure and then recorded that failure as the row's health — turning a malformed row into a permanent "last error" that re-appeared on every refresh.
