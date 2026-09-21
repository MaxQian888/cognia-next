---
"cognia-next": minor
---

Redesign the composer attachment experience: the context row now lives inside the input card as compact 112×80 landscape tiles (real image thumbnails, video posters, icon tiles for documents with middle-truncated filenames) instead of square tiles in a strip above it. Images open the shared `ImageLightbox` directly — now with floating gradient chrome matching the prototype, trackpad pinch zoom, horizontal-swipe navigation, pan-while-zoomed, double-click zoom, and pull-to-dismiss — while documents, videos, and rejected attachments open a centered `AttachmentPreviewDialog` carrying the file/model audit tabs, OCR, redaction, and video-sampling controls.
