---
"cognia-next": patch
---

Fix a crash in the OCR "Try it" confirmation dialog. Its title string is `Run OCR with {provider}?`, but the render passed no `provider` value, so opening the confirm dialog threw `FORMATTING_ERROR: the intl string context variable "provider" was not provided`. The provider id is now passed to the title (matching the description below it), and a co-located test asserts the confirm title interpolates the provider so this can't regress.
