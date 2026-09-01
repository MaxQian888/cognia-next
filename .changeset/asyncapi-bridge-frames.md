---
"cognia-next": patch
---

The headless bridge's published AsyncAPI now describes all ten of its frame types. Three remote-worker frames were live in both the TypeScript and Rust implementations and in the shared golden fixture, but absent from the document, so anyone integrating against the spec saw an incomplete wire protocol.
