---
"cognia-next": patch
---

Fix a freshly paired browser reporting itself as unpaired. `web-companion` is a placeholder the Web boot provider publishes to name the surface before it knows which Host it talks to — nothing is ever stored under it, because a Web companion target is filed under the Host's own id. The outbound-runner provider installed that placeholder as the active runtime target context, which is what companion credential lookup resolves by, and the boot provider republishes the opening snapshot on every host rebind — so the placeholder landed on top of the real Host id the pairing had just set, and activation then failed with "Companion Host activation failed and rollback was incomplete". Placeholder ids are now named, given a predicate, and refused by everything that routes.
