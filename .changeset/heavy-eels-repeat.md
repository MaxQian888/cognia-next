---
"cognia-next": patch
---

Skill recorder: make window and application capture scope real. The setup screen now enumerates open windows (`record_list_capture_targets`) and builds the scope from the chosen target, so a scoped recording carries the identity fields the native side requires instead of failing to deserialize; a scoped choice with no target can no longer start, and the preflight retry re-checks permissions instead of quietly starting a whole-desktop recording. Unanswered variable suggestions now block generation, so recorded input values are never sent to the model or hard-coded into the skill. The controlled trial loads the skill it was opened to exercise. On Windows, overlay windows that fail to become non-activating now report the failure instead of leaving a focus-stealing strip on screen.
