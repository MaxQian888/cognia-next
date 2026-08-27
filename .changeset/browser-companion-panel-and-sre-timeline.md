---
"cognia-next": patch
---

Browser Companion extension: it ships its own icon now, in the toolbar and the extensions list, instead of the browser's generic placeholder. The connection screen shows the extension's own `chrome-extension://` origin so it can be copied straight into Settings → Companion → Browser access, which is the one value pairing needs and the only one the user had no way to read. And a panel whose local pairing data cannot be read no longer sits on a blank loading state — it says so and offers a retry.

Browser Companion submissions: a submission whose first attempt did not finish is redriven onto the same session and the same transcript message rather than being abandoned, so a capture that failed to reach the Host is retried without producing a second task. A retry that carries a _different_ page under an already-used submission id is refused instead of being enqueued against the first page's session — including a different page on the same host, which the recorded hostname alone could not tell apart from the first one. The URL the panel submits also follows the "include the full address" toggle now, so the address it sends is the one shown in the preview rather than always the full one.
