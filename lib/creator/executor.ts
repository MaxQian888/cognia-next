/**
 * The nine-step Creator executor (ADR-0117, Phase 3).
 *
 * `steps.ts` says which step may run; this runs it. The split matters: the
 * gating rules are pure and exhaustively tested, and the executor's only job is
 * to consult them, invoke one handler, and record the outcome in the durable
 * run log.
 *
 * Everything that touches the outside world — the generator, the toolchain, the
 * sandbox preview, the reviewer subagent — arrives as an injected handler. That
 * is not test scaffolding: those four live in four different runtimes (agent
 * session, host shell, plugin scope, subagent), and an executor that reached
 * into all four directly could not run in the renderer at all, let alone be
 * exercised without a desktop host.
 *
 * Two invariants the executor is responsible for, both re-checked here rather
 * than assumed from the caller:
 *
 *  - No step runs out of order or through an ungranted approval (`canAdvance`).
 *  - No file is written before the permission diff is approved (`canWrite`,
 *    enforced again inside `writeCreatorFile`).
 */

import { canAdvance, canWrite, creatorStep, firstIncompleteStep } from "./steps"
import type { CreatorAdvanceState } from "./steps"
import { computePermissionDiff, approvalCoversDiff } from "./permission-diff"
import { buildReviewerBrief, computeReviewVerdict } from "./reviewer"
import { writeCreatorFile } from "./file-writer"
import type { CreatorWriterDeps } from "./file-writer"
import type { CreatorRunLog } from "./run-log"
import type {
  AuthoringRoot,
  CreatorArtifactKind,
  CreatorPermissionDiff,
  CreatorReviewFinding,
  CreatorReviewVerdict,
  CreatorStepId,
} from "@/types/creator"

/** A file the plan proposes. Contents are produced by the generator handler. */
export interface PlannedFile {
  /** Path relative to the authoring root. */
  relativePath: string
  contents: string
}

export interface ScaffoldPlan {
  files: readonly PlannedFile[]
  /** Capabilities the proposed artifact declares. */
  capabilities: readonly string[]
  rationales?: Readonly<Record<string, string>>
}

export interface VerificationResult {
  lint: boolean
  typecheck: boolean
  build: boolean
  contract: boolean
  /** Machine-readable failure detail, surfaced to the reviewer and the user. */
  detail?: string
}

export interface ExistingImplementation {
  /** Repo-relative path of something that already does this. */
  path: string
  why: string
}

/** Everything a handler needs. Deliberately closed — no ambient access. */
export interface CreatorRunContext {
  runId: string
  root: AuthoringRoot
  artifactKind: CreatorArtifactKind
  /** Recorded at step 1 and handed to the reviewer verbatim. */
  requirements: string
  /** Capabilities the currently-installed artifact holds. */
  currentCapabilities: readonly string[]
  /** Capability additions the user has approved for this run. */
  approvedAdditions: readonly string[]
}

/**
 * The four outside-world ports.
 *
 * Steps with no port (`approve-permissions`, `approve-delivery`) are pure
 * gates: the executor computes and records, and the user decides.
 */
export interface CreatorHandlers {
  collectRequirements(ctx: CreatorRunContext): Promise<{ requirements: string }>
  surveyExisting(ctx: CreatorRunContext): Promise<{ findings: ExistingImplementation[] }>
  planScaffold(ctx: CreatorRunContext): Promise<ScaffoldPlan>
  verify(ctx: CreatorRunContext): Promise<VerificationResult>
  preview(ctx: CreatorRunContext): Promise<{ clean: boolean; leaked: readonly string[] }>
  review(
    ctx: CreatorRunContext,
    brief: ReturnType<typeof buildReviewerBrief>
  ): Promise<{ findings: CreatorReviewFinding[]; reviewerAuthority: string }>
  deliver(ctx: CreatorRunContext): Promise<{ delivered: "install" | "export" | "publish" }>
}

/** Mutable carry-over between steps within one run. */
export interface CreatorRunState {
  plan?: ScaffoldPlan
  diff?: CreatorPermissionDiff
  written: string[]
  verification?: VerificationResult
  verdict?: CreatorReviewVerdict
  survey?: ExistingImplementation[]
}

export function createCreatorRunState(): CreatorRunState {
  return { written: [] }
}

export type CreatorStepOutcome =
  | { status: "completed"; step: CreatorStepId }
  | { status: "awaiting-approval"; step: CreatorStepId; approval: string }
  | { status: "blocked"; step: CreatorStepId; reason: string }
  | { status: "failed"; step: CreatorStepId; message: string }

export interface RunStepDeps {
  ctx: CreatorRunContext
  handlers: CreatorHandlers
  progress: CreatorAdvanceState
  run: CreatorRunState
  log?: CreatorRunLog
  /** Injected write backend, threaded to `writeCreatorFile`. */
  ops?: CreatorWriterDeps["ops"]
}

/**
 * Run exactly one step.
 *
 * Returns rather than throws for every expected outcome — blocked, awaiting
 * approval, a failing toolchain — because all three are normal states of a
 * gated workflow, and a caller that had to distinguish them from thrown errors
 * would end up catching and re-classifying.
 */
export async function runCreatorStep(
  step: CreatorStepId,
  deps: RunStepDeps
): Promise<CreatorStepOutcome> {
  const gate = canAdvance(step, deps.progress)
  if (!gate.allowed) {
    if (gate.reason === "awaiting-approval") {
      return { status: "awaiting-approval", step, approval: gate.approval ?? "unknown" }
    }
    return { status: "blocked", step, reason: gate.reason }
  }

  await deps.log?.stepStarted(step)

  try {
    const outcome = await executeStep(step, deps)
    if (outcome.status === "completed") await deps.log?.stepCompleted(step)
    return outcome
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await deps.log?.stepFailed(step, message)
    return { status: "failed", step, message }
  }
}

async function executeStep(step: CreatorStepId, deps: RunStepDeps): Promise<CreatorStepOutcome> {
  const { ctx, handlers, run } = deps
  const completed = { status: "completed" as const, step }

  switch (step) {
    case "collect-requirements": {
      const { requirements } = await handlers.collectRequirements(ctx)
      ctx.requirements = requirements
      return completed
    }

    case "survey-existing": {
      // Working Rule 1 as a workflow step. The findings are advisory — the
      // executor does not refuse to continue when something similar exists,
      // because "similar" is a judgement the user makes.
      run.survey = (await handlers.surveyExisting(ctx)).findings
      return completed
    }

    case "plan-scaffold": {
      const plan = await handlers.planScaffold(ctx)
      run.plan = plan
      // The diff is computed as soon as the plan exists, so the approval step
      // has something to show and the log records it before any approval.
      run.diff = computePermissionDiff({
        current: ctx.currentCapabilities,
        proposed: plan.capabilities,
        ...(plan.rationales ? { rationales: plan.rationales } : {}),
      })
      await deps.log?.permissionDiff(run.diff)
      return completed
    }

    case "approve-permissions": {
      // A pure gate. `canAdvance` already confirmed the approval was granted;
      // what is re-checked here is that it covers THIS diff — a regenerated,
      // wider plan must not ride in on an approval given for a smaller one.
      const diff = run.diff
      if (!diff) return { status: "blocked", step, reason: "no-plan" }
      if (!approvalCoversDiff(ctx.approvedAdditions, diff)) {
        return { status: "awaiting-approval", step, approval: "permission-widening" }
      }
      return completed
    }

    case "apply-changes": {
      const plan = run.plan
      if (!plan) return { status: "blocked", step, reason: "no-plan" }
      // Belt and braces: `canAdvance` got us here, but the write gate is
      // re-evaluated because approval can be withdrawn between steps.
      if (!canWrite(deps.progress)) {
        return { status: "awaiting-approval", step, approval: "permission-widening" }
      }
      for (const file of plan.files) {
        const result = await writeCreatorFile(
          { relativePath: file.relativePath, contents: file.contents },
          { root: ctx.root, state: deps.progress, log: deps.log, ops: deps.ops }
        )
        if (!result.ok) {
          // Stop at the first refusal rather than writing the rest: a partially
          // applied plan is harder to reason about than a failed one.
          return { status: "failed", step, message: `${file.relativePath}: ${result.detail}` }
        }
        run.written.push(result.relativePath)
      }
      return completed
    }

    case "verify": {
      const verification = await handlers.verify(ctx)
      run.verification = verification
      if (!allPassed(verification)) {
        return {
          status: "failed",
          step,
          message: verification.detail ?? failedChecks(verification).join(", "),
        }
      }
      return completed
    }

    case "preview": {
      const report = await handlers.preview(ctx)
      if (!report.clean) {
        // A leaked preview is a named release blocker, so it fails the step
        // rather than warning — the resources are still held either way, and a
        // warning would let the run reach delivery with them held.
        return {
          status: "failed",
          step,
          message: `preview leaked ${report.leaked.length} resource(s): ${report.leaked.join(", ")}`,
        }
      }
      return completed
    }

    case "review": {
      const verification = run.verification
      const diff = run.diff
      if (!verification || !diff) return { status: "blocked", step, reason: "no-verification" }

      const brief = buildReviewerBrief({
        artifactKind: ctx.artifactKind,
        changedPaths: run.written,
        permissionDiff: diff,
        requirements: ctx.requirements,
        verification,
      })
      const { findings, reviewerAuthority } = await handlers.review(ctx, brief)
      const verdict = computeReviewVerdict({ verification }, findings, reviewerAuthority)
      run.verdict = verdict
      await deps.log?.reviewVerdict(verdict)
      if (!verdict.approved) {
        return { status: "failed", step, message: "reviewer found blocking issues" }
      }
      return completed
    }

    case "approve-delivery": {
      if (!run.verdict?.approved) return { status: "blocked", step, reason: "not-reviewed" }
      await handlers.deliver(ctx)
      return completed
    }

    default:
      return { status: "blocked", step, reason: "unknown-step" }
  }
}

function allPassed(result: VerificationResult): boolean {
  return result.lint && result.typecheck && result.build && result.contract
}

function failedChecks(result: VerificationResult): string[] {
  return (["lint", "typecheck", "build", "contract"] as const).filter((key) => !result[key])
}

/**
 * Repeatable steps that produce in-memory state a later step needs.
 *
 * `CreatorRunState` lives in one process; the durable log carries *progress*,
 * not the plan — file contents have no business in a record meant to be
 * attachable to a bug report. So a run resumed after a reload arrives with its
 * steps marked complete and its plan gone, and `apply-changes` would block on
 * `no-plan` forever.
 *
 * The fix is to re-derive rather than to persist: each entry names the step
 * whose output is missing and the repeatable producer that regenerates it.
 * Re-running the generator also means a resumed run re-computes its permission
 * diff, so an approval granted before the reload is re-checked against the
 * fresh proposal instead of being trusted.
 */
const INPUT_PRODUCERS: ReadonlyArray<{
  needs: (run: CreatorRunState) => boolean
  producer: CreatorStepId
  requiredBy: readonly CreatorStepId[]
}> = [
  {
    needs: (run) => run.plan === undefined || run.diff === undefined,
    producer: "plan-scaffold",
    requiredBy: ["approve-permissions", "apply-changes", "review"],
  },
  {
    needs: (run) => run.verification === undefined,
    producer: "verify",
    requiredBy: ["review"],
  },
]

/**
 * Re-run any repeatable producer whose output the next step needs.
 *
 * Returns the outcome of a producer that did not complete, so the pipeline
 * surfaces "regenerating the plan failed" rather than the downstream step's
 * misleading `no-plan`.
 */
async function rebuildMissingInputs(
  next: CreatorStepId,
  deps: RunStepDeps
): Promise<CreatorStepOutcome | null> {
  for (const entry of INPUT_PRODUCERS) {
    if (!entry.requiredBy.includes(next)) continue
    if (!entry.needs(deps.run)) continue
    if (entry.producer === next) continue

    // Through `runCreatorStep`, not `executeStep`: a producer that throws must
    // become a failed step attributed to the PRODUCER, and must reach the run
    // log. Calling the raw executor here let the exception escape the pipeline.
    const outcome = await runCreatorStep(entry.producer, deps)
    if (outcome.status !== "completed") return outcome
  }

  // Re-deriving the plan re-opens the permission question, and `canAdvance`
  // will not ask it again because `approve-permissions` is already marked
  // complete in the durable log. Without this check a run resumed after a
  // reload would write files under an approval granted for a narrower diff —
  // the same smuggling `approvalCoversDiff` blocks on the first pass.
  if (deps.run.diff && !approvalCoversDiff(deps.ctx.approvedAdditions, deps.run.diff)) {
    return {
      status: "awaiting-approval",
      step: "approve-permissions",
      approval: "permission-widening",
    }
  }

  return null
}

export interface PipelineOutcome {
  /** Why the pipeline stopped. `completed` means all nine steps are done. */
  status: "completed" | "awaiting-approval" | "blocked" | "failed"
  /** The step the pipeline stopped on, absent when everything completed. */
  step?: CreatorStepId
  detail?: string
  /** Steps this invocation completed, in order. */
  ran: CreatorStepId[]
}

/**
 * Run forward until the workflow needs the user.
 *
 * Deliberately stops rather than prompts: an approval is a decision the user
 * makes in the UI, and an executor that blocked waiting for one would hold the
 * run open across a reload. The caller re-invokes after the approval lands, and
 * `readCreatorProgress` reconstructs where it was.
 */
export async function runCreatorPipeline(deps: RunStepDeps): Promise<PipelineOutcome> {
  const ran: CreatorStepId[] = []
  // Progress is carried locally so a step completed in this loop unblocks the
  // next one without a round-trip through the durable log.
  let progress: CreatorAdvanceState = {
    completed: [...deps.progress.completed],
    approvals: [...deps.progress.approvals],
  }

  for (;;) {
    const next = firstIncompleteStep(progress.completed)
    if (!next) return { status: "completed", ran }

    const rebuilt = await rebuildMissingInputs(next, { ...deps, progress })
    if (rebuilt) {
      return {
        status: rebuilt.status === "completed" ? "blocked" : rebuilt.status,
        step: rebuilt.step,
        detail:
          rebuilt.status === "failed"
            ? rebuilt.message
            : rebuilt.status === "blocked"
              ? rebuilt.reason
              : rebuilt.status === "awaiting-approval"
                ? rebuilt.approval
                : undefined,
        ran,
      }
    }

    const outcome = await runCreatorStep(next, { ...deps, progress })
    if (outcome.status !== "completed") {
      return {
        status: outcome.status,
        step: outcome.step,
        detail:
          outcome.status === "failed"
            ? outcome.message
            : outcome.status === "blocked"
              ? outcome.reason
              : outcome.approval,
        ran,
      }
    }

    ran.push(next)
    progress = { ...progress, completed: [...progress.completed, next] }

    // A repeatable step that just completed would otherwise be chosen again by
    // `firstIncompleteStep` — it is not "incomplete" now, so the loop advances.
    if (
      creatorStep(next).requiresApproval &&
      !progress.approvals.includes(creatorStep(next).requiresApproval!)
    ) {
      return { status: "awaiting-approval", step: next, ran }
    }
  }
}
