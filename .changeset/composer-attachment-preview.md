---
"cognia-next": minor
---

Chat composer attachments: you can now see what the model will actually receive before you send. Clicking an attachment chip opens a preview panel with two views — the file as you read it (PDFs, code and text render inline) and the payload the model gets, showing a document's extracted text with its token cost and any PII the redaction gate substituted. Documents are now parsed the moment they are staged rather than at send time, so chips carry a live token badge and an unreadable file is flagged immediately instead of being silently dropped after the message has gone out.

Staged attachments now survive switching sessions, reloading and restarting: their binary and cached extraction are saved with the draft, under a global 150 MB budget that evicts the oldest session's binaries first (those fall back to the previous "re-attach these" reminder). Attachment chips can be dragged to reorder, and the model receives them in the order shown.

Sent messages read better too: images keep their filename, and an attached document appears as a collapsed file card instead of dumping its entire extracted text into your own chat bubble.

Fixes a batch of composer defects: the attachment size hint never rendered (it only understood `data:` URLs while staged files carry `blob:` URLs), removing the last attachment skipped its exit animation, the context bar popped in and out while neighbouring bands animated, the remove button permanently covered the end of a filename on touch, and an image chip stretched the whole bar to 80px. Image OCR moved into the preview panel with an explicit "also send OCR text" opt-in, so it no longer silently sends both the picture and its transcription.
