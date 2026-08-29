---
"cognia-next": patch
---

Fix a crash that killed browser pairing partway through. Activating a new Host suspends the live transport before switching, which puts the web stub back and re-runs the signaling controller against it; the controller assumed any companion build already held a real transport and called straight into it, throwing "tx.onConnectionStateChange is not a function" from inside the pairing flow and leaving the pair screen spinning on a step that had already died. It now decides on the transport rather than the runtime and waits for the real one, which arrives with its own notification moments later.
