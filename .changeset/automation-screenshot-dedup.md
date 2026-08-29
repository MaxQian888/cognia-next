---
"cognia-next": patch
---

Automation: "Skip unchanged screenshots" now skips them.

The setting has shipped switched on, describing itself as sending a short text note in place of a duplicate frame — but nothing read it, so every `get_app_state` inlined a full image even when the screen had not moved. A computer-use turn reads state before and after each action, so a still window cost two identical images per step.

`get_app_state` now withholds a frame that is byte-identical to the one the same app session last showed, and returns a note naming the revision the model already holds. The frame's dimensions survive, so pixel targeting still works. Comparison happens after redaction, and only for model-facing callers — the Settings → Automation Inspector keeps rendering every capture. Engaging the kill switch forgets the remembered frames, so whatever runs next starts from an image it can see.

The Inspector also shows its "no screenshot" empty state for a frame with no bytes, instead of a broken image.
