---
"cognia-next": patch
---

A burst of server events no longer disconnects every device paired to a Host: a stream that falls behind refills what it missed from the replay buffer instead of closing.
