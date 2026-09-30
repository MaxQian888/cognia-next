---
"cognia-next": minor
---

Office workbooks now compute their formulas: every create and edit recalculates the workbook (own parser plus the MIT `@formulajs/formulajs` function library) and stores each formula's real value instead of a number the agent asserted, turning cycles into `#REF!`, keeping the cached value of anything it cannot evaluate, and reporting error cells and unevaluated formulas back to the agent. People can now fix a cell directly in the workbook preview (Enter / F2 / double-click or just type; Delete clears; each edit is a new, recalculated version with a conflict notice if the agent changed it meanwhile). And a new `artifact_capture` tool lets the agent see any artifact the way the user does — workbooks, PDFs, documents, charts, pages — as an image, so it can catch clipped, blank or wrong-looking output before calling the work done.
