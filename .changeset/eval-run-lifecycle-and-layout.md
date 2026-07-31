---
"cognia-next": minor
---

Evaluation runs are now cancellable, observable and honest about how far they got, and the eval UI's layout defects are fixed.

A run's state moved out of the run dialog and into a store. Cancel is available from the moment a run starts rather than only after the first case finishes — which on a real target meant minutes with no way out. Closing the dialog no longer strands the run: it keeps going, stays visible in a persistent bar at the top of the eval workspace, and can still be cancelled from any tab. Runs also record a status: a run is claimed in the database _before_ its first case, so an interrupted run no longer leaves per-case rows behind an id no row owns, and a run that stopped part-way is badged as cancelled and withholds its quality-gate verdict instead of passing one computed over an arbitrary prefix.

Fixed: annotations written in the trace-analysis panel could silently vanish — the rows read a saved note into local state on mount, but the notes and traces load through independent queries, so when the traces arrived first the note rendered blank and pressing Save overwrote it with an empty string. Judge scorers no longer render checked-but-greyed-out when no judge is configured, and are excluded from the run rather than appearing to be included. The cost guard re-arms when the run configuration changes, instead of one acknowledgement pre-approving every later, larger run.

Layout: the import, run and gate panels no longer draw their own title, border and close button inside a dialog that already provides them (the title used to appear twice, with three ways to dismiss). The dataset list/detail split now derives its grid from the same source as its pane logic, fixing a blank half-screen on tablet-sized native shells. The comparison grid labels rows with the case prompt instead of a raw id. Run detail gains the small-screen card layout the comparison view already had, plus loading skeletons and restrained enter transitions that honour `prefers-reduced-motion`.
