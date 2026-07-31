---
"cognia-next": minor
---

Four fixes that make the eval subsystem's "look at your data" loop actually usable.

The trace-analysis list counted **spans, not traces**: asking for 50 recent traces returned however few traces the last 50 spans happened to cover, so a single chatty session collapsed the whole list to one row, and there was no way to page further back. It now pages by trace, 25 at a time.

Promoting a trace into an eval case used the trace **preview** — a truncated, PII-gated span field — as the case input, so every case built from real traffic was a clipped fragment of what the user actually asked, and the agent was then graded on the fragment. The original prompt is recovered from the session's message log, with the preview kept only as a fallback. This applies both to the trace panel's "save as case" and to the bulk history import.

Dataset version snapshots stored a full frozen **copy** of every case. Every case edit bumps the dataset version and the next run snapshots it, so a thousand-case benchmark wrote roughly half a megabyte of duplicated case text into IndexedDB per edit-then-run cycle — for data already sitting in `evalCases`. Snapshots now store case ids plus the existing content hash; older snapshots stay readable.

Judge calibration can be **seeded from a run**. Measuring whether a judge agrees with a human previously required retyping every (request, answer) pair by hand, so no set got built and no judge's agreement was ever measured. Run detail can now turn a run's judged cases into calibration items in one step, pre-labelled with the judge's own verdict for a human to confirm or flip, with its reasoning attached. Calibration runs are also cancellable — the runner always accepted an abort signal, the panel simply never passed one.
