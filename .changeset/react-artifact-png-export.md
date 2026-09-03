---
"cognia-next": minor
---

React artifacts can be exported as PNG and PDF. They previously offered the raw source only, because their preview runs in a sandboxed frame the exporter cannot read into, and re-rendering the source off-screen captures JSX that has not run. The live preview is now asked for a snapshot of what it actually drew, so the export needs the artifact open, and says so instead of producing a blank image when it is not.
