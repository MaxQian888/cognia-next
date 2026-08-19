---
"cognia-next": patch
---

Fixed the layout jitter when a shell edge panel opens or collapses, and put all five of them on one clock.

The terminal dock (bottom and right) used to reserve its full size in a single frame and then slide a transform into it, so expanding jumped the workspace by up to 40% of the shell before the motion started, and collapsing slid the panel out and only then closed the gap — two structurally different gestures with one instant reflow each. Both directions are now the same transition on the space the dock occupies, with the terminal held at its final size behind a clip so it slides past the shell edge instead of being resized (and stops firing a SIGWINCH per animation frame at the child process).

The status bar and the navigation rail were simply unmounted when hidden, dropping 24px and 56px out of the window in one frame; they now collapse on the same transition. The rail's case matters most where it disappears because the expanded sidebar has taken over the navigation — that fires together with the sidebar's own width animation, so a smooth collapse used to end on an instant 56px jolt in the opposite direction.

The conversation sidebar, the artifact dock, the nav rail, the status bar and both terminal slots now share one duration and curve, and none of them snaps the last stretch of the animation when motion speed is turned down.
