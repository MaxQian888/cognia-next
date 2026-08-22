---
"cognia-next": patch
---

**Long Slack replies no longer stop mid-thought.**

Slack accepts at most 50 blocks in one message. A reply that needed more had everything past the fiftieth block discarded before the request was even sent — so the message just ended, with no error shown, nothing in the logs, and no record that anything had been dropped. Longer answers, tables, and anything with several attachments or interactive cards were the usual casualties.

Replies that need more room are now split across several messages, with the continuations posted as a thread under the first one so they stay together instead of scattering down the channel. Every part carries its own summary line, which is what Slack reads to screen readers and shows in notifications. Buttons and other interactive elements keep working wherever they land.

If a continuation fails to send, the failure now says how many parts were delivered, rather than reporting a success that quietly lost the rest.
