---
"cognia-next": minor
---

Artifacts and Canvas documents can now be exported as PNG and PDF. Both formats were members of the export type and offered by no adapter, while the model was told on every send that chart artifacts were "exportable" — charts, diagrams and equations could only ever be saved as their source JSON.

Charts, Mermaid diagrams, equations, SVG and HTML now render to an image; documents, code and notebooks lay out as selectable text in a PDF rather than a picture of themselves. The Canvas export menu also stops using a download anchor, which silently did nothing inside the mobile app.
