---
"cognia-next": minor
---

Creator can now actually generate. The survey, scaffold, and review steps are backed by real model turns that run through the same headless path as the rest of the app, so they share its concurrency ceiling and can be cancelled with everything else. Those turns are read-only by construction: the model proposes files and the workbench writes them after you approve the permissions, so nothing reaches disk on the model's own say-so. The reviewer gets a fresh conversation every time and cannot be handed the generator's, which is what makes its verdict worth reading. Replies are parsed strictly — a plan with one bad path is rejected whole rather than half-applied, and a path that points outside the authoring root is refused before it is ever attempted. Running the toolchain and installing the result are still not connected, and say so plainly when you reach them.
