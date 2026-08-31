---
"cognia-next": minor
---

Browse a paired Host's folders as a tree that starts where the Host actually allows. The picker now asks the Host which roots it will open (a new `fs_workspace_roots` read), opens inside one instead of guessing the local documents folder, expands directories lazily, and when a path is refused it offers the allowed roots as one click instead of leaving the Rust error on screen. Companion settings gain a read-only card naming those folders and where each is configured, and `pnpm dev:headless` takes `--workspaces-dir` to set the headless root.
