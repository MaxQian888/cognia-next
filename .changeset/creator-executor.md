---
"cognia-next": minor
---

The Creator workbench can now run its nine-step workflow rather than only display it. Describe what you want, press run, and it moves forward until it needs you — stopping at the permission review, at a failing check, or at the delivery approval, and saying which and why. Files are only ever written after the permission diff is approved, and every write is checked twice: once for the shape of the path and once on disk, so a symlink pointing out of the authoring root is refused even though it looks fine on paper. A run resumed after a reload regenerates its plan instead of restoring it, which means the approval you gave earlier is re-checked against the new proposal — a regenerated plan asking for more has to ask again. Steps that need a capability this build has not connected yet (the generator, the toolchain, the reviewer) report exactly that instead of quietly doing nothing.
