---
"cognia-next": minor
---

Dynamic Island: fix its placement on notched MacBooks and let it control Cognia's own agents.

- **Notch placement.** On a MacBook with a camera notch the island is now drawn as the notch itself growing wider. The compact and minimal views sit entirely in the menu-bar strip, as "ears" either side of the camera, and the expanded list grows down out of the notch. It no longer hangs a pill below the menu bar over the frontmost app's toolbar, and an idle island shrinks to exactly the notch, so it is invisible. The window is also placed correctly with an external display attached: positions and sizes are now applied in points on macOS, the island no longer drifts off the top of the screen after it resizes, and hovering to reveal it works when the two displays use different scaling.
- **Cognia chat agents.** A conversation's tool approval can be answered from the island (Allow, Always allow where the ask permits it, or Deny). You can also stop a running turn and send a reply, which steers the turn or starts the next one. A chat turn now shows as its conversation, named by its title, instead of as a separate "Run" row.
- **Gates and durable approvals.** Plan-step and cost-budget gates can be approved or rejected from the island. So can run approvals whose answer is a plain yes or no: plan, delegation, bot, fusion, capability-audit and connector tool asks. These go through the same validated path the Agent Runs page uses.
- **Honest countdowns.** Only asks that actually expire show a countdown: a CLI hook's 20-second window, or a run approval's deadline. ACP agent requests and chat approvals wait for you and no longer turn unanswerable after 20 seconds.
- **Fixes.** A Cognia run no longer shows "waiting for your approval" after the ask was answered. A refused approval, answer or reply now says why on its row. Pinning a blocked task reveals exactly what it is asking to do. A task that just finished stays visible for a few seconds, named, instead of disappearing into a tucked island.
