---
"cognia-next": patch
---

**Photos, voice notes and documents sent to a bot no longer go to a cloud model by default.**

An image someone sends a bot in a group chat used to be uploaded to whichever model answered — the raw bytes, as part of the prompt. Nobody chose that; it was simply what happened when an attachment arrived.

Now the bytes stay on your device. What the model sees is text a local extractor produced from them — OCR, transcription — and that text is checked for personal information again before it goes, because words read out of a photographed form are not the same as words someone typed. When there is nothing to extract, the model is told an attachment arrived that it cannot see, so it asks instead of answering as if the message were empty. Either way the message itself is still in your history, and the Inbox still shows you the picture.

Sending the raw file to a model is still possible, but it now takes a deliberate grant on that specific conversation, naming the provider it applies to, and you can revoke it or let it expire. Permission for one provider never becomes permission for another, and letting a bot talk to a cloud model has never implied permission to upload what people send it.
