---
"cognia-next": patch
---

Plugin tools whose manifest name the Anthropic API cannot carry (such as `ocr.extract`) keep their original name on the Cognia side of the Claude Agent SDK. The sidecar registers the model-facing form itself, translates the allow and deny lists it hands the SDK, restores the name before permission rules, plan-mode policy and the approval request see it, and rewrites the streamed messages, so tool cards, the IM permission ceiling and session-wide grants match again on the Anthropic rail.
