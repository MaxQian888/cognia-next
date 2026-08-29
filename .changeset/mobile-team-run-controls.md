---
"cognia-next": patch
---

Agent Teams on mobile: a paused team is no longer a dead end. The phone workspace wired only Start and Abort, but the shared run-control block renders Resume for a paused run regardless — so the button appeared, was enabled, and did nothing when tapped, while Stop never appeared at all. Pause, Resume and Stop now reach the same team manager the desktop header uses. The control block itself also stopped rendering any button whose handler is missing: an inert control reads as "the run refuses" rather than "this surface cannot", which is how the mobile gap stayed invisible.
