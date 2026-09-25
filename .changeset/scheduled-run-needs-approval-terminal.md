---
"cognia-next": patch
---

A scheduled chat, agent, skill or goal run that stops because nobody was there to approve a tool, or because its workspace is not trusted, now ends as "Needs approval" instead of as a plain failure. It is no longer retried, since each retry re-ran the whole turn into the same wall and paid for it again. It raises a "needs approval" notification instead of a failure one, and the scheduler shows which tools and roots it was waiting on and how to clear them. A Bot turn that needed approval is now recorded as failed rather than completed, and is not replayed.
