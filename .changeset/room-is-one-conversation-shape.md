---
"cognia-next": minor
---

Team rooms now run on the host instead of on the device that typed the message (ADR-0177). A paired phone or web companion hands its turn to the desktop or headless host through the new `room_send` and `room_stop` commands, and a headless brain can run a team room at all. A team conversation's members panel gains a room settings section: room instructions injected into every member's prompt, a long-term memory switch, and stored-for-later reply mode and mute controls. The participants chip and the members list read one roster projection, and an IM group says when it only lists the members who have spoken.
