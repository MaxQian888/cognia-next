---
"cognia-next": minor
---

Agent evaluation can now run against real public test sets.

Five deterministic reference-answer scorers — `exact-match`, `contains-any`, `regex-match`, `numeric-match` and `choice-match` — finally consume `reference.expectedOutput`. Nothing did before: only the LLM judge read it, as prompt context, so importing GSM8K or MMLU and running the deterministic tier graded nothing. Each case now carries a grading rule (`reference.grading`) saying how to compare, including answer extraction — pulling `18` out of a chain of thought that ends `#### 18`, or `B` out of "the answer is (B)." — and each scorer stays inert unless a case selects its mode, so tool-use datasets are unaffected.

The import wizard was rebuilt around one pipeline: pick a source → map its columns → preview → import. The HuggingFace tab now discovers a dataset's configs, splits and real column names instead of hardcoding `question`/`answer` (which made every other dataset import zero rows and still report success), pages past the server's 100-row cap so a full test split actually arrives, and previews before writing — as HuggingFace and foreign-tool imports previously went straight to the database on a single click. Imports write through a new chunked, cancellable bulk path with one dataset-version bump instead of four database round-trips per case, and re-importing the same source now updates in place rather than duplicating.

`split` is finally written. The field, the run-dialog filter, the case badge and the CSV column all existed, but no import path ever set it, so "run the test split" could never match an imported case.

Runs now keep the agent's answer (truncated, configurable under Settings → eval, `0` disables) and each judge's reasoning, and run detail rows expand to show them. Previously a failing case was a dead end: no way to see what the model said or why a scorer rejected it.
