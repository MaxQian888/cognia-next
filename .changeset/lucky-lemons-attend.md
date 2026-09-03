---
"cognia-next": patch
---

Main chat runs an external agent end to end from a browser paired to a headless server again. A workspace whose repository has no commits no longer claims Git isolation it cannot provide, which used to strand the conversation on "managed workspace is not active" from its second turn onward. A page reload no longer reuses the previous turn's run id. Pi's extension handshake is given the budget its extension policy implies, so an agent that loads the user's own Pi extensions is not refused while they start. A copied agent appears once in the runtime picker, named by where it runs, instead of twice. And a turn the provider refused now shows what the provider said instead of an empty assistant bubble marked Complete.
