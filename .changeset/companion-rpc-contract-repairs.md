---
"cognia-next": patch
---

Fix two Companion RPC commands that rejected their own documented payload. `plugin_install_from_github` dropped `generatedFiles` and `plugin_set_network_allowlist` dropped `rules`; because the request contracts are enforced at runtime and forbid unmodelled fields, sending either returned a 422 rather than being quietly ignored. Installing a plugin from a repository that ships no manifest, and narrowing a plugin's network access by method and path rather than only widening it by domain, both work remotely now.
