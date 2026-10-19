---
"cognia-next": patch
---

`cognia-agent x codex` starts again on current Codex releases: it now talks to the gateway over the Responses API (Codex no longer accepts the chat wire), updates existing Codex profiles in place on the next launch, and warns before launch when the fallback proxy points Codex at an upstream that may not serve the Responses API.
