---
"cognia-next": minor
---

Workflows can read and write files. Nine new nodes (read, write, list, stat, search, mkdir, move, copy, delete) address the workspace as (root, relPath) through the same host-neutral seam the file tree uses, so a graph running on the desktop, on the cloud brain, or against a remote Host reaches that Host's disk. Until now the only way to touch a file from a graph was an agent turn or a terminal command.

The root is a selector rather than a baked path, so a workflow authored on a desktop still resolves on a server. Reads stat before they read and refuse over a byte cap, so a large file never lands in the run log. A non-UTF-8 file and a Host that demands an interactive approval both come back as advice you can act on instead of a raw error. Writes, moves and deletes are risk-gated, which means a cron or webhook run containing one needs an approval node upstream.
