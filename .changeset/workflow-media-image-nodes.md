---
"cognia-next": minor
---

Workflows can work with images and video. Four image nodes read an image's dimensions, transform it (crop, scale, rotate and flip in one pass), adjust it across eleven sliders, and re-encode it. Four media nodes probe a video, pull a frame out of it, trim it and join several together.

Results that have no file path now go to a run-scoped encrypted store instead of into the run log, and a step output carries a short reference to them. Any image node and the OCR node can read that reference, so extracting a frame and running OCR over it is two nodes with nothing in between. The artifacts outlive their run so you can still open them from the run history, and expire on their own after a day.

Video nodes are desktop-only and say so up front rather than failing halfway through: they need FFmpeg, which is reachable only from the desktop app, so a run on a cloud host stops before it starts rather than throwing mid-flight. A machine with no FFmpeg on its PATH gets told exactly that. Trimming and joining leave their output in a temporary area that file nodes cannot read yet, which the node descriptions say plainly.
