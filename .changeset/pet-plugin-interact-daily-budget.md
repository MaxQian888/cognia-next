---
"cognia-next": patch
---

Close a loophole where a plugin could farm the desktop pet's progression forever. Direct nurture interactions from a plugin (`ctx.pet.interact`) were the one reward path that never touched the per-plugin daily budget, so they fell through to the host award tables and kept paying XP and coins indefinitely while the plugin's remaining budget still read as untouched. Interactions now spend from the same daily ledger as plugin reward events, and the granted amounts ride the event explicitly. Once a plugin's daily budget is spent, its nurture quests still work: feeding still restores energy and mood, and the pet still reacts. They simply stop paying XP and coins until the budget resets, instead of failing. `ctx.pet.interact` now also reports what it granted, so a quest can show when the day's rewards are used up.
