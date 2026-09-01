---
"cognia-next": patch
---

An imported conversation's "verified native resume" state stopped riding a field that meant two other things. `runtimeBindingRef` was documented as a reference to a runtime binding, was never read that way, and in practice carried an external agent's native session id for imported conversations. That decision is now its own marker, and the id is read from the session row where it already lived.

One consequence: an imported conversation you verified before this update needs the "Resume" action once more before its turns reattach to the agent's own session again.
