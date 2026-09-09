---
"cognia-next": patch
---

Installing a WASM plugin from a local `.zip` now works. The button called `plugin_install`, a host command that unpacks nothing (it validates a manifest, creates a directory and writes `manifest.json`) and that takes `(pluginId, source, payload)` rather than the arguments the call actually sent, so it could not succeed under any input. The host now has the local-file installer its own module documentation had always listed alongside the HTTP and Git ones, sharing their archive limits, manifest-contract validation and atomic replace, and recording a verified publisher in the trust ledger the same way.
