---
"cognia-next": minor
---

Server deployments accept an optional fourth release image, the agent bundle that project runtime environments inject into their images (ADR-0183). The deployment wizard and the upgrade dialog take it as an optional digest, and production certification requires it to be digest-pinned when set. The Ops Controller remembers the bundles each server has run and ships the two most recent earlier bundles with every release, so projects pinned to an older agent bundle keep working through an upgrade. Servers without a bundle deploy exactly as before.
