---
"cognia-next": minor
---

Visual Workflows: auto-gate risky nodes behind an approval (ADR-0070 Phase 3)

Before a medium/high-risk node runs — connector send/forward, git push, mobile
share, desktop automation, real shell, connector delete — the engine now asks for
approval, unless an `action.approval.request` node already gates that path. The
wait reuses the approval node's own machinery, so it resumes after a crash
identically and the existing pending-approval UI answers it. Low-risk nodes are
untouched.

Headless runs (cron / webhook / IM / API) fail closed with a reason naming the
risk surfaces, rather than pausing on a modal nobody will see.

**Existing workflows are unaffected.** Risk gating is opt-in per workflow:
workflows authored before this ship have no `riskGating` field and stay ungated,
so nothing that runs today starts pausing or failing. Newly created workflows are
gated by default; set `riskGating: false` on a workflow to opt out.
