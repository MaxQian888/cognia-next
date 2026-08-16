---
"cognia-next": patch
---

Fix the paired-device permission toggles so they grant what they say they grant. Remote control, agent control, and terminal access now write the host's SecurityStore capabilities that the request-path gates actually check, and the switches render the host's answer instead of a local mirror that could disagree with it; previously they wrote a set of in-memory allow lists that nothing had consulted since authorization moved into the store, so enabling or revoking one of these permissions had no effect on what a paired device could do. Existing grants are imported once on first launch. The Locked Use switch is now shown as unavailable, because its macOS system component is not part of this build.
