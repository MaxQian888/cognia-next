---
"cognia-next": patch
---

Fix the download button on an artifact card in chat: it ignored the artifact's export contract, always wrote `text/plain`, and built the filename from the artifact's type — so a chart downloaded as `chart.chart`. It now goes through the same exporter the artifact panel uses, and reports a failure instead of doing nothing.
