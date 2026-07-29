---
"cognia-next": minor
---

Make navigating a long conversation work end to end. The scroll-to-latest control now floats above the message list instead of inside it, so it is actually on screen when you have scrolled up — previously it was positioned against the unscrolled container and scrolled away with the messages, exactly when it was needed. It has become one pill with three states: return to where you were, N new messages, and jump to latest.

Jumping now lands correctly and says so: virtualized rows carry a message anchor (so a jump could previously resolve to nothing at all), the landing message is briefly marked, a jump that cannot resolve reports why instead of silently doing nothing, and a timeline anchor lands at the top of its turn rather than mid-screen. The collapsed timeline rail no longer sits on top of the scrollbar, is visible at rest, responds to stylus and touch as well as the mouse, and its viewport thumb can be dragged. The expanded panel opens at the turn you are reading, groups rows by date, and jumps to the starred assistant reply rather than the question above it.

Adds message permalinks — copy a link to any message from the message actions, on desktop and mobile — and uses them to give terminal tabs a "locate in conversation" that lands on the message that spawned the tab, not just the conversation.
