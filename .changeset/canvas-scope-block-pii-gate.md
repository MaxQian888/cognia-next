---
"cognia-next": patch
---

Fix a PII-gate bypass in the Canvas context analyzer: stripping an npm scope marker with `replace("@", "")` removed the first `@` anywhere in an import specifier, turning `jane@example.com/pkg` into `janeexample.com` — an address the redaction gate no longer recognised. It now strips a leading `@` only.
