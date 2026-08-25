---
"cognia-next": patch
---

Files a repository asks to be copied into every managed worktree (`include`) are now cloned copy-on-write where the filesystem supports it — APFS on macOS, btrfs/XFS with reflinks on Linux — so a large fixture corpus or seeded database costs a metadata operation per worktree instead of a full byte copy. Every failure falls back to an ordinary copy, so nothing is skipped on a filesystem without reflinks.
