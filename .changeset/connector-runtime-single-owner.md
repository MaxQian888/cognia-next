---
"cognia-next": minor
---

The connector runtime now has a single owner across processes, not just across webviews. Previously a desktop webview and a `cognia-agent serve` brain attached to that desktop's companion each used a different guard — Web Locks and a Rust lease respectively — in disjoint namespaces, so both could boot the same IM adapters and every inbound message got answered twice and every reply sent twice.

Both now contend for the same `connectors_runtime_lease_*` slot: the arms became host-neutral and are registered as Tauri commands as well, so the desktop (which speaks IPC, not its own companion's HTTP) can reach them. Ownership carries a priority class — an always-on brain preempts a desktop holder immediately instead of waiting out the lease TTL, and a desktop never evicts a running brain. The lease fails open on the desktop, so an install whose companion surface is off keeps booting exactly as before.
