---
"cognia-next": patch
---

Make the chat message column stop resizing when a tool call is expanded or collapsed, and tighten the space between consecutive tool calls. The assistant column was `w-fit`, so its width tracked the widest _mounted_ child — collapsing a tool card unmounts its body, which snapped the whole column narrow and made it jump back out on expand; the assistant side is now pinned to the full row so the width is constant either way. Consecutive tool calls also no longer carry a strip of chrome between them: a turn made up of only tool calls renders no action bar (it has no prose to copy, quote, read aloud or turn into a card, but the bar still reserved a ~40px row while invisible), the plugin context-menu wrapper no longer reserves a slot when no plugin contributed items, and an empty text part — what a model emits when it writes no prose between two tool calls — now renders nothing and no longer splits one tool-activity group into two.
