---
"cognia-next": minor
---

The connector detail now tells you what a bot can do — and why it can't do the rest.

The capability projection already knew that a Slack workspace was never granted `files:write`, that a OneBot server does not implement the reaction action, that a webhook-mode Discord bot has no gateway to set presence on. That answer only ever reached the code: the model quietly stopped being offered a tool and a button quietly disappeared, with nothing telling you that re-authorizing would bring it back.

A new card in the connector's Config tab lists the capabilities this bot can actually serve, and above them, every one it cannot — each with the reason and the remedy: the access to grant, the setting that is off, the server action that is missing, the transport it needs, or the kind of conversation it only works in.
