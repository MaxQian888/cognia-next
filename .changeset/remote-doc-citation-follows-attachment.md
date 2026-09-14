---
"cognia-next": patch
---

A Feishu or Google document picked with `@lark:` or `@google:` is now cited on a sent message only when the document was actually attached and its chip was still there at send time. Previously the message recorded the citation even when fetching the document failed, when the attachment limit refused the file, or when you removed the chip before sending, so its backlinks pointed at a document the model never received. A document restored with a saved draft keeps its citation. The "Attached" toast no longer appears for a document the attachment limit turned away, and a failure to attach a fetched document now says so instead of blaming the connection.
