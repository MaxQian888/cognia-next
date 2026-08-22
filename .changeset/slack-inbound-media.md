---
"cognia-next": minor
---

Slack: the bot can now see the files people share with it.

Slack's file links look like normal URLs and are not: fetching one without the workspace's bot token returns Slack's sign-in page, not the file. So a shared screenshot reached the model as `[image: https://files.slack.com/…]` and an attached document as `[file: q3.pdf]` — a link that answers a login page, and a file name.

Images shared in a channel the bot is in are now downloaded — with the token, through the encrypted attachment cache — and read. Text is extracted from shared documents so the model reads the contents. The token is only ever sent to Slack's own file host, so a link a stranger puts in a message cannot draw it out.

Whether the picture itself may be sent to a cloud model is unchanged and still decided per conversation: on the default setting only locally-extracted text leaves the device.
