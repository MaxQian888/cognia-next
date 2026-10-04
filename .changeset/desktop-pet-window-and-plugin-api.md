---
"cognia-next": minor
---

Desktop pet fixes and a complete plugin API. The pet now drags, throws and stays where you drop it on high-DPI and multi-monitor setups. The right-click popup opens next to the pet and stays there as it resizes. The size slider applies live. The pet no longer steals focus or shows in Alt-Tab on Windows, and only one pet is on screen at a time. Settings changed in one pet window no longer overwrite another window's changes. Closing a pet window with the OS shortcut, quitting, or switching the pet off cleans up its windows. The popup groups its window actions and the `/pet` console gains a desktop toggle. Plugins get `ctx.pet.getAvailability()`, a neutral `pluginReward` kind, per-call reward caps, typed cooldown and item errors, permission-gated `onPet*` hooks, validated `petItems`/`petAchievements`, and an `@cognia/plugin-sdk/api/pet` subpath. `ctx.pet.emitEvent` and `interact` now require `pet:interact`.
