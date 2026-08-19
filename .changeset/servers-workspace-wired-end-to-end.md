---
"cognia-next": minor
---

Make the Servers workspace actually operate a fleet: controller traffic now goes through the platform HTTP transport (so the desktop and mobile shells can reach a self-hosted controller at all), live operation events stream through a native command, and a new agent-enrollment flow connects a deploy agent to a registered target — without which every queued operation had nothing to run it. Adds preflight, status/log collection, release upgrade, operation detail and cancellation, a rendered-deployment preview, and a stepped deployment wizard that points at the field each validation error came from.
