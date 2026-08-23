---
"cognia-next": patch
---

Remote session control: prompts reach the device that is actually watching, and attachments expire.

**A decision prompt only wakes the device that can answer it.** When a run on your desktop needed a tool-use approval, every paired device got a push — including ones that were never watching that session, and ones without permission to answer. The alert also carried the name of the tool, so a command a run wanted to execute could appear on a lock screen. Notifications now go only to devices holding a live control attachment on that session, they are skipped entirely for a device already looking at the prompt, and the payload carries ids and a deep link, nothing about the tool.

**A phone that drops off stops holding your run hostage.** Watching a session used to register the device forever, so one that lost its connection without closing the view kept collecting approval prompts nobody would ever see — each one stalling the run until it timed out and auto-denied. Attachments are now leases: the viewer renews while it is open, and one that stops renewing is released within 90 seconds. A device whose event stream is down attaches as an observer instead of silently claiming control it cannot exercise.

**Remote actions are authorized one at a time.** Sending a message, answering an approval, creating a session and rewriting a transcript were all covered by the single "remote control" grant. They are now checked individually: steering a run needs Remote Control, creating one needs Agent Control, and editing or truncating a transcript needs owner permission. A batch reports the outcome of each action, so the allowed ones still apply.

**Devices can no longer act as each other.** The device identity behind attach, detach and every remote state change now comes from the verified connection instead of the request body, which previously let a paired device claim another's identity and receive its approval prompts.
