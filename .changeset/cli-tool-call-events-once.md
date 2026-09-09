---
"cognia-next": patch
---

Surface each tool call once. The canonical event mapper used to record a `tool-call` for every assistant snapshot that repeated a sealed `tool_use` block, and once more when a streamed block opened with empty arguments, so `cognia-agent -p --output-format stream-json`, the TUI transcript and the persisted session log showed one call three to four times, the first copy with arguments the model never sent. The CLI's idle deadline now also pauses while a tool is executing, so a dispatched sub-agent or a long build no longer ends the turn with "the provider stream stalled".
