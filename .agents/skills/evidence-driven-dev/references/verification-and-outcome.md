# Independent verification, residual risk, and outcome

Two different questions, kept apart on purpose:

- **Verification**: did we build what the frame and obligations specify?
  (Does the permission check block unauthorized access?)
- **Validation**: did that actually improve the original problem?
  (Do users now finish cross-device work without the workaround?)

A change can pass every verification and still fail validation. That failure
is "built the wrong thing", and only the Outcome section catches it.

## 1. Independence: who checks matters

A closed loop of `builder → reviewer that read the builder's reasoning →
summary that says done` repeats one premise three times. Order of preference,
weakest first (record the level in the Independence column):

```
self  <  subagent (sees your reasoning)  <  fresh-reviewer (artifact + contract only)
      <  tool (deterministic test/gate)  <  other-model  <  human / real-env
```

How to get real independence with what exists here:

- **Fresh reviewer**: run `doubt-driven` with the ledger as the **contract**.
  Hand over the problem frame, the C (constraint) items, and the claims with
  their "Refuted by" columns. Do not hand over your design rationale. Ask it to
  find a counterexample to each claim.
- **Auditors**: `preflight` dispatches the six project auditors over the diff.
  Pass the ledger path in their scope statement so they can check the claims
  as well as the generic rules.
- **Tools beat opinions**: wherever an obligation can become a test, a gate,
  or a fault-injection run, do that instead of a model judgment.
- **Other model**: `codex-agent` for an adversarial second opinion on
  high-severity design or security claims (each run needs the user's explicit
  authorization).
- **Real environment**: `tauri-smoke`, the Android device recipe, a
  real-provider run, the always-on host box. These are the obligations that
  most often end up `blocked`. That is fine as long as they are recorded.

The obligations themselves are under independent change control (see
`risk-evidence.md` §6). The builder does not get to relax them after the fact.

## 2. What counts as evidence

Record evidence so someone else could re-run it and get a comparable result:

- the **command** (or procedure) and the **result excerpt** (test counts,
  error text, measured numbers), or a commit / artifact path;
- the **environment** when it matters (platform, versions, provider, data set);
- **coverage**: the conditions exercised, and the ones not exercised.

Judge it on six properties, and say which ones are weak:

| Property       | Question                                                          |
| -------------- | ----------------------------------------------------------------- |
| independence   | Is this only the designer's own judgment?                         |
| reproducibility| Could someone else re-run it and compare?                         |
| relevance      | Does it test the claim, or something adjacent that's easier?      |
| coverage       | Which situations were exercised; which were not?                  |
| falsifiability | Could this check have failed? (A test that cannot fail is not evidence.) |
| freshness      | Is it still valid after dependency/environment changes?           |

"Verified that it recovers from network loss" is not evidence. Which network
condition, at which phase, with which in-flight tool call, and checked for
duplicate execution? That makes it evidence. "Should pass" and "looks fine" are
predictions; `ledger.mjs check` rejects them as evidence.

**Evidence decays.** When a dependency, platform version, protocol, or the code
under a Verified item changes, its state is stale. Set it back to Hypothesized
(or Contested), and re-run the obligation if it still matters. An Invalidated
assumption makes everything that depends on it suspect; `check` flags Verified
items and decisions that rest on Invalidated ones.

## 3. Residual risk: what we still don't know

Passing all checks is not the same as being correct. Every round ends by writing
down what is **not** known or not verified:

- each obligation that is planned/blocked/failed/waived (a residual row with
  `From: V<n>`). `check` enforces this once Status is verifying/closed;
- complexity dimensions still at unknown;
- risks only covered by weak (self) evidence;
- environments and conditions outside every obligation's Coverage.

Describe each by **source, impact, scope, and next action**. Do not attach a
confidence percentage you can't justify; a made-up number is worse than "not
measured". Only the user can move a residual to `accepted`. Present it in
Chinese with the consequence spelled out, and record their answer.

## 4. Outcome validation

Seed Outcome (M rows) during problem discovery, while the original problem is
still in view. For development work, typical signals are:

- the original repro no longer reproduces in the **real** shell or device,
  not just in jest;
- the real-provider / real-host / paired-client run the change exists for;
- the user confirms the workflow they actually care about now works;
- a before/after measurement (latency, completion rate, failure count) on the
  same procedure.

Many outcomes can't be measured inside one session. That's normal. Leave the M
row `pending`, set the ledger Status to `verifying`, and commit it. `node
.agents/skills/evidence-driven-dev/scripts/ledger.mjs open` lists every pending
outcome, blocked obligation and open residual across all ledgers. That is the
durable, queryable home for "smoke pending" items, which otherwise end up
scattered across memory notes. Still add a one-line memory pointer to the
ledger so the next session finds it.

If the outcome comes back `not-met`, that's a finding about the **problem frame**,
not just the code: reopen problem discovery with the new O items.

## 5. Closing

Set Status `closed` only when every obligation passed or is carried as a
residual, every residual is closed or accepted by the user, and every outcome is
measured or explicitly carried. `ledger.mjs check` enforces exactly this.
