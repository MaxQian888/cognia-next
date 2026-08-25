---
"cognia-next": patch
---

A plugin asking for a repository workspace no longer re-clones it every time. The per-plugin cache directory was only ever used as a clone _destination_, so a plugin that scans a repository paid a full network clone on every run; it now refreshes the existing checkout instead. A cache directory left holding a different repository is cleared rather than cloned over — previously that made `git clone` fail on a non-empty directory and the plugin could never acquire the workspace again.
