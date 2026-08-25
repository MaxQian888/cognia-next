---
"cognia-next": minor
---

Template drafts can now be edited. The Template Studio could create a draft and publish it, but never change what was in it — the save path had no caller anywhere in the app, and the per-domain "Open editor" link sent two of the six domains to `?mode=template-authoring`, a parameter nothing in the app handles. Drafts (and the conflict drafts a clashing save produces) now get an inline editor for name, description and portable payload, which reports JSON and validation errors instead of silently doing nothing, and says so explicitly when a concurrent change forces the edit into a separate draft.
