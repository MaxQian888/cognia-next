---
"cognia-next": minor
---

The Canvas AI workbench now shows its work. Every action runs through one prompt builder and one redaction gate (the plugin path had a different builder and no gate at all), and the panel renders what came back: streamed output, a stop button that actually aborts the request, a retry that replays the last instruction, and an explanation when a run is blocked rather than a raw error string.

`review` produces anchored suggestions you can accept one at a time instead of a paragraph nothing rendered. `explain` keeps its answer on screen. `run` executes the code in the execution panel instead of asking a model to imagine the output. Suggestions come back schema-validated rather than parsed out of whatever the model wrapped its JSON in.

The prompt draft, chosen preset, staged attachments, action history and command-palette state now live on the document, so they survive switching away and coming back.
