---
"cognia-next": patch
---

Agent Modes: "Include A2UI template" now produces something you can see and keep. The generator has always been able to build a template for a custom mode, but the editor discarded the result, never persisted one, and never handed one to the preview card — so the card was permanently its own "No template selected" empty state, and the mode saved with no template at all. The editor now holds the generated template, saves it with the mode, and shows it: component count, the flattened component tree, and the raw spec. The preview's `Show/Hide spec` control is real too — it was declared, wired by the editor, and then ignored by the component, with the editor's own test asserting against a mock button that did not exist in the shipped code.
