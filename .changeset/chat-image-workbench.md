---
"cognia-next": minor
---

Chat images open in an editing workbench instead of a read-only lightbox. Clicking any image in a message (a Markdown image, an attachment, a tool screenshot) still opens the viewer you had, with the same zoom, rotation, paging and download, and now also crops, resizes, rotates, flips, and adjusts exposure, brightness, contrast, gamma, temperature, tint, saturation, vibrance, hue, blur and sharpen. With an image-editing provider configured it can also edit from a prompt, edit only a region you paint, and remove a background.

Saving is non-destructive: the original is never touched, and the result is added to the same message as another image, with a version rail down the side that always keeps the original one click away. Versions survive a refresh and travel with the conversation, because they live on the message rather than in the editor. Undo, redo and a hold-to-compare control cover the whole session, and closing with unsaved work asks first.

Where an image cannot be edited the workbench says why rather than hiding the controls: an image hosted on another site can be viewed and downloaded but its pixels cannot be read, a provider without mask support still does whole-image prompts, and a streaming or read-only conversation explains that a version cannot land yet.
