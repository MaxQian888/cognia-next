---
"cognia-next": patch
---

Phones recover when their WebRTC data channel to the Host dies after the app resumes from the background: the Host refuses an ICE restart it has no connection for, so the phone negotiates a fresh connection instead of sending requests the Host silently discards. A liveness probe on the main channel fails requests fast on a dead channel and falls back to the relay. The Host logs each data channel by label, stream and handle.
