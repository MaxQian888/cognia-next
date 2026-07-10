---
description: In-flight adversarial fresh-context review of a non-trivial decision before it stands (cognia-next doubt-driven).
argument-hint: [the claim/decision to cross-examine]
---

Invoke the `doubt-driven` skill on the decision below (or, if none is given, on
the most recent non-trivial decision in this session).

Run the full cycle from the main session:

1. **CLAIM** — state the decision + why it matters in 2–3 lines.
2. **EXTRACT** — isolate the smallest artifact (diff/function/proposal) and pull
   the applicable CONTRACT clauses (relevant ADR + schema, static-export rule,
   PII gate, i18n parity, ≥90% coverage, Dexie native-version rule, Rust
   guard/detached-task rules). Strip your own reasoning.
3. **DOUBT** — spawn a fresh-context reviewer with the adversarial prompt,
   passing ARTIFACT + CONTRACT only (never the CLAIM). Pick the reviewer by
   domain: `pii-gate-auditor` / `wiring-auditor` / `tauri-rust-reviewer` /
   `static-export-auditor` / `test-gap-auditor` / `i18n-reviewer`, else
   `general-purpose`. Then offer cross-model in Chinese (Codex/Gemini CLI /
   manual / skip) — never silently skip.
4. **RECONCILE** — re-read the artifact against each finding; classify as
   contract-misread / actionable / trade-off / noise.
5. **STOP** — trivial findings, 3 cycles, or the user says 提交/ship it.

Decision to cross-examine: $ARGUMENTS
