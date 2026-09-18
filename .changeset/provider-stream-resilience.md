---
"cognia-next": patch
---

Provider stream resilience (parity with opencode v1.18.x): direct-provider chat calls now bound the wait for response headers and the idle gap between streamed chunks (5 min defaults), so a provider that stalls mid-reply fails the turn instead of hanging it forever — on both the webview BYOK path and the desktop sidecar. Transient failures (`network_error` finishes, sent-but-silent requests, watchdog timeouts) get a bounded same-provider retry while nothing has been committed to the transcript, and a leg that ends on an unmapped finish reason continues generating instead of truncating the answer. Also: a session resuming a live stream no longer keeps showing the previous turn's error banner, and malformed non-finite pricing values in custom/discovered model metadata can no longer poison cost accounting.
