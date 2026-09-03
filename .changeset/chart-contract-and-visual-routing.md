---
"cognia-next": patch
---

Charts now say what they could not draw. A pie whose series was not literally called `value` used to render blank. That is fixed, and the six other contract rules that failed in silence (an unsupported chart type, a series missing from the first row, rows with no name, non-numeric values, scatter rows without x/y, a multi-series pie) now appear as a non-blocking note above the chart, which still draws whatever it can. Mermaid diagrams beyond the original ten grammars, including mind maps, timelines, kanban boards and quadrant charts, can finally reach the artifact dock. A fenced chart payload can express its shape instead of always arriving as a line chart.
