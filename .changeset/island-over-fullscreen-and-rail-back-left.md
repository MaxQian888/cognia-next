---
"cognia-next": patch
---

Keep the agent island visible over other apps' full-screen windows, and put the navigation rail back on the left edge.

The island used to withdraw completely — nothing painted, window shrunk to a click-through sliver — whenever a full-screen app owned its display, which made it look like it only worked on Cognia's own desktop. Its overlay panel is configured to float over every Space, so now it does: the island stays where you put it, on any Space, and the yield-the-top-strip behaviour moved behind a new "Hide under full-screen apps" switch in Settings → Agent fleet monitor that ships off. Turn it on if you want the top strip left alone while watching video or presenting; even then, a session that needs a permission or an answer still brings the island back. (macOS only — no other platform has the full-screen Space model this reads, and while the switch is off the window sweep behind it no longer runs at all.)

The navigation rail defaults to the left edge again. Right stays available in Settings → Sidebar and in the rail's right-click "Customize layout"; it is simply no longer where the rail lands out of the box.
