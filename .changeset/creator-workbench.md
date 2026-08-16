---
"cognia-next": minor
---

Adds the Creator workbench at `/creator`, a developer-mode surface for authoring plugins, skills, hooks, agent presets and visual workflows. Everything Creator reads or writes is confined to an authoring root you pick explicitly — there is no implicit fallback to the current workspace — and secrets, VCS internals and `node_modules` stay off limits even inside it. The nine-step workflow shows a permission diff before any file is generated: adding a capability needs approval, removing one does not, and an approval only covers the exact capabilities it was granted for, so a regenerated proposal that asks for more has to ask again. Progress is recorded on the existing workflow run timeline and rebuilt from it after a reload, the reviewer runs read-only with its own context, and tearing down a sandbox preview reports any resource it failed to release.
