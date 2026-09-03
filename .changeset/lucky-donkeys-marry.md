---
"cognia-next": patch
---

Fix an installed Pi being invisible to onboarding: its runtime id was used where a preset id belonged, so the setup scan printed a raw slug, could not tell it was already signed in, and asked for credentials anyway. Agent vendor identities now resolve through one shared mapping.
