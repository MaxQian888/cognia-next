---
"cognia-next": minor
---

The desktop pet is now something the agent can see and touch, something that survives a new machine, and something with one set of rules.

Your pet travels with your backups. Its name, its level, every XP it earned since it hatched, its coins, its daily-care streak, its badges, its items and your Live2D tuning are all in the backup package now, so restoring onto a new machine no longer quietly loses the pet you raised. Model files and sprite atlases stay behind (they can be re-imported, and they would not survive the package format anyway), and if a backup turns out to hold a different pet than the one on this machine, the restore keeps yours and tells you rather than silently picking one.

The agent can look after your pet when you turn it on in Settings → Tools (off by default). It can read how the pet is doing, feed or play with it, let it speak in its own voice, and reward it for milestones you reach. Putting the pet on screen always asks first.

Feeding is now genuinely rate-limited. Holding a bound hotkey, or holding the mouse on the desktop sprite, used to farm XP and coins without limit while the on-screen button was correctly greyed out. Every route into the pet now goes through the same gate, cooldowns survive a reload, and all three windows agree on them. A refused interaction says so in the pet's speech bubble instead of looking like a dead button. Feeding an unhatched egg is refused and points you at hatching it.

Your conversations with the pet are encrypted at rest. Doing that required rebuilding that one table, so chat history with your pet from before this release is not carried over. The pet only ever kept the most recent 200 exchanges.

Turning the pet off now actually removes it from your desktop instead of leaving a frozen sprite floating there. Opening the pet page on a phone explains that the pet is desktop-only rather than loading forever. Storage now reports what your pet models and sprite packs really weigh instead of a couple of bytes. And a plugin can no longer use a treat it does not own.
