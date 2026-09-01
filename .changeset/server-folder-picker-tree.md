---
"cognia-next": minor
---

Browse a paired Host's folders as a tree that starts where the Host actually allows. The picker now asks the Host which roots it will open (a new `fs_workspace_roots` read), opens inside one instead of guessing the local documents folder, expands directories lazily, and when a path is refused it offers the allowed roots as one click instead of leaving the Rust error on screen. Companion settings gain a read-only card naming those folders and where each is configured, and `pnpm dev:headless` takes `--workspaces-dir` to set the headless root, which `pnpm dev:web-headless` now passes for you -- defaulting to the checkout itself, so the picker opens on your code instead of an empty data directory; pass `--workspaces-dir ..` if you want sibling repositories in reach too.
