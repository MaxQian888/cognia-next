---
"cognia-next": minor
---

Usage analytics: surface breakdown, live budget meters, reachable per-provider ceilings, and honest cost totals

- The Usage dashboard now ranks spend **by producing surface** (chat, agent team, workflow, connector, OCR, embedding, …), reusing the same aggregation and row component as the `/usage` transcript card.
- The surface filter offers every metered surface that has rows in range, instead of a hard-coded chat / workflow / agent-team. Eleven metered surfaces were previously unreachable.
- Aggregate costs that include turns no pricing layer could price now render as a lower bound, and a fully unpriced bucket shows no figure instead of "$0.00". The top-sessions table no longer drops sessions whose spend could not be priced.
- Spending limits: per-provider daily and monthly ceilings plus the warn and critical thresholds are now editable. They were enforced by the send gate but had no editor.
- Both the settings editor and the Usage dashboard show live spend against every configured ceiling, read from the same rollup the send gate reads.
- The provider Cost tab now shares the app's token and money formatters, and buckets by local calendar day. It previously filtered UTC day keys against locally keyed rows, so a day's spend could be dropped or double-counted near midnight.
