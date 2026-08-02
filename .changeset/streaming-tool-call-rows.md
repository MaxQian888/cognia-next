---
"cognia-next": minor
---

Chat now shows tool calls while they are still being generated. The Claude Agent SDK's partial-message stream carries a tool call's `content_block_start` (id + name) well before the block closes, but the renderer was dropping those frames and waiting for the complete assistant message — so a long `Write`, `Edit`, or `TodoWrite` argument list left the transcript blank for seconds. The tool row is now painted in `input-streaming` the moment the model names the tool, its `input_json_delta` fragments are accumulated off-message (no duplicate payload written to IndexedDB mid-call), and the parsed input lands at `content_block_stop`. Also fixes text streamed after a tool call being welded onto the text part from before it.
