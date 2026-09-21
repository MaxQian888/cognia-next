---
"cognia-next": minor
---

Delegate workspace safety in Rust: a revision-bound compare-and-swap apply that refuses to overwrite a workspace that moved, confined reads and acceptance-report extraction that refuse `..`, absolute paths and symlinks, and a Windows sandbox runner that applies the policy's memory, CPU and process caps and fails closed when asked for a network confinement it cannot enforce.
