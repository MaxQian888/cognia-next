---
"cognia-next": patch
---

Browser Companion: the side panel now tells the truth about a submission that did not start. A refused enqueue is recorded as `failed` with the Host's own refusal code and a missing runtime as `host_unavailable` — both were previously left looking mid-flight, and the reader then overwrote them with `queued` on the next poll because it read "this session has no run" as "the run is queued". Both states stay retryable, so the panel's next attempt finishes the original submission instead of opening a second task, and the panel explains why by fetching the recorded code through `browser_context_get` (implemented on the Host since the feature shipped, and never once called). A submission whose response never arrived now survives the panel being closed, so reopening it retries rather than minting a new id.

Two fixes behind that. The panel's theme was read from a store that only a React provider hydrates, so a Host with no renderer — a headless brain, which is what a browser reaches when Cognia is served as a web app or self-hosted — painted every panel with the stock dark preset regardless of the user's theme; it is read from the database now, and answers correctly on every host. And Browser Access, which the ADR describes as a kill switch, only decided whether to bind the listener at startup: switching it off left an already-bound listener accepting submissions until the server restarted. Turning it off now refuses new enrollments and submissions on the next request, while the reads a paired panel makes keep answering, so tasks a browser already started stay visible to it.

Settings → Companion also gains a control to clear what this Host has recorded about browser submissions.
