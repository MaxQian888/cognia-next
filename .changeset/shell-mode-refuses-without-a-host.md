---
"cognia-next": patch
---

An interactive `!` command (`ssh`, a REPL, a login flow) on a client with no Host now says so instead of being handed to a terminal dock with nothing behind it. The dock gate asked whether a terminal transport could be picked, which is true for any mobile shell and any browser with a companion target configured, paired or not. Whether the line can actually run is the negotiated question, and only the capture path was asking it. Both branches now read the same verdict, so `!ssh host` on an unpaired client gets the one message that names the fix.
