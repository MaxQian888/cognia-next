---
"cognia-next": minor
---

Agent evaluation now reports honest scores. Previously, running a plain question/answer dataset (input + expected output, no tools, no retrieval) reported **100% pass@1 no matter how wrong the answers were**: every reference-based scorer was excluded as "errored", and the two reference-free ones — unbudgeted `cost` and `tool-redundancy` on a run with zero tool calls — faked a passing verdict. The per-case table underneath disagreed and marked every row FAIL, because it applied a different rule than the run header.

Scores now carry an explicit status (`scored` / `not-applicable` / `errored` / `measurement`) instead of overloading a single error string, and only `scored` observations decide pass/fail. Both the run header and the per-case grid call one shared `repetitionVerdict`, so they can no longer disagree. A case no selected scorer could grade is `ungraded` — excluded from the pass-rate denominator and counted explicitly, rather than silently recorded as a pass or a failure. Reports expose per-status counts, so a judge that failed on every case now raises an alert instead of quietly leaving a confident-looking number behind. The quality gate gains a `maxUngradedRatio` threshold (guarding against a perfect pass rate measured over almost nothing) and no longer fails a run over scorers that graded nothing at all.

Runs recorded before this change are badged "legacy scoring", their inflated pass rate is left untouched but their gate verdict is withheld, and comparing them side-by-side with newer runs warns that the two are not comparable.
