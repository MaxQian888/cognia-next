---
"cognia-next": minor
---

**Plugin-provided chat platforms can now run more than one bot, and each one is configurable.**

A plugin that adds a chat platform used to get exactly one bot, created the instant the plugin was enabled. It had no settings page, no credentials of its own, no trigger rules, and no way to turn it off short of disabling the whole plugin — and you could never run a second one, even though every built-in platform lets you run as many as you like.

Those bots are now ordinary connector instances. They appear alongside your Telegram and Slack bots, you can add as many as you want, configure and disable each separately, and they start, stop, reconnect and report health through exactly the same machinery. Enabling a plugin creates a first bot for you so nothing you had stops working; after that it is yours to duplicate or remove.

Plugins can no longer claim a platform name that is already taken — a built-in one, a name the app has reserved, or one another plugin is using. A conflicting plugin now says which name clashed and why, instead of quietly replacing whichever adapter happened to load first.

One rough edge worth knowing: deleting a plugin's last bot will recreate it the next time the app starts. Disable it instead if you want it to stay gone.
