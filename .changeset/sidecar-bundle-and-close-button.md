---
"cognia-next": patch
---

Fix the packaged sidecar and the window close button.

`bundle.resources` listed the sidecar's six entry points but none of the modules
they import, so the staged copy was missing `dispatch/`, `builtin-tools/`, `lsp/`,
`a2ui-tools/`, three top-level modules and three shared JSON files.
`packaged_sidecar_dir` accepts a directory on the presence of its entry point
alone, so that incomplete copy was preferred over the checkout and node exited
with `ERR_MODULE_NOT_FOUND` — taking connectors, workflows and external agents
down with it into recovery safe mode. A new build test walks the real import
graph and fails when the list drifts again.

The close (X) button did nothing on most routes. Rust prevents the close and
waits for the renderer to answer `app://close-requested`, but the dialog that
answers it was mounted behind `AccountGate` and the per-route `desktop-tools`
boot capability, so on any route that does not request that capability — and on
the lock screen — nothing replied and the window simply stayed open. It now
mounts with the other window-liveness initializers, keyed only on the Tauri main
window.
