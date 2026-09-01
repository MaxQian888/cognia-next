---
"cognia-next": patch
---

A turn sent to an agent the paired host owns is now recorded as an external turn. It used to answer "built-in" when asked which agent was running it, because the answer was read from the local-agent field and a host selection leaves that empty, so its code-adoption attribution named the wrong runtime and it registered a durable chat receipt that external turns are meant to skip.

Chat also resolves the runtime once per send instead of consulting the store at three separate points, so switching runtime part-way through a send can no longer be observed differently by each of them.
