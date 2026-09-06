---
"cognia-next": minor
---

The desktop host records who signed in. It now takes its Logto trust anchor from the cloud deployment the profile chose (fetched by the host itself, certificate pinned for a self-signed gateway) instead of an environment nobody sets on a laptop, so the device attribution of ADR-0149 happens on desktops too. The person's server-assigned id is kept alongside the verified one, so the device console and the roster name the same person.
