---
"cognia-next": patch
---

Organization members on a shared Host now start new conversations on a model their organization serves, instead of this device's default (which the Host refused). The model menu lists only the organization's models for the conversation (its agent's, or every model the organization holds a key for in plain chat), and picking one switches the conversation on the Host from the next message. A conversation on a model the organization doesn't serve says so in the composer, and a Host turn on such a model is refused as "no model access" rather than a bare error.
