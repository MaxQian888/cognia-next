---
"cognia-next": minor
---

Add project-scoped vector memory tools for the agent (`vector_search`, `vector_add_document`, `vector_delete_document`), opt-in from Settings → Tools. Collections are scoped to the session's linked project — the agent can neither name nor reach another project's memory — and every call passes the PII redaction gate before anything is embedded or stored. Desktop only: they run against the local native vector store, never a configured cloud vector provider.
