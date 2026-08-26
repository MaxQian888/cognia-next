---
"cognia-next": patch
---

The four connector keyring commands move off the loopback-only service plane onto the device plane, where every call must present a valid admin lease. This is the protocol change a paired browser needs before it can configure a bot at all; the client side that uses it is not wired yet, so the settings screen still says the bot runs on the paired host.
