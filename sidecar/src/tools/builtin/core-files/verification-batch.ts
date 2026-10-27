// Explicit foreground batches reuse Bash execution and its command-level gate.
// No command rewriting, background escape, or claim of whole-task validation.
import { z } from "zod"
import { performance } from "node:perf_hooks"
import { tool } from "../../kernel/define.ts"
import { toolText } from "../../kernel/result.ts"
import { createBashTool, bashShape } from "./bash.ts"
import type { CoreFileToolContext } from "./context.ts"
import { assertToolCallWithinRoots } from "../../../policy/confinement/enforce.ts"

export const VERIFICATION_BATCH_NAME = "verification_batch"
export const verificationBatchShape = {
  commands: z
    .array(
      z.object({
        label: z.string().min(1).max(200),
        command: z.string().min(1),
        workdir: z.string().optional(),
        timeout_ms: z.number().int().min(1).max(120_000).optional(),
      })
    )
    .min(1)
    .max(4)
    .describe(
      "Up to four explicit validation commands, executed sequentially under one shared batch deadline."
    ),
  max_duration_ms: z.number().int().min(1).max(120_000).optional(),
}

export function createVerificationBatchTool(context: CoreFileToolContext) {
  const bash = createBashTool(context)
  return tool(
    VERIFICATION_BATCH_NAME,
    "Run a small named verification batch in the foreground. Each command retains Bash permissions, sandbox and cancellation. " +
      "The shared runtime budget bounds the batch; unexecuted commands are returned as pending. " +
      "Split large sweeps into incremental batches and retain every original acceptance check. Batch success does not certify the full task.",
    verificationBatchShape,
    async (input, extra) => {
      const args = z.object(verificationBatchShape).parse(input)
      const budget = context.verificationBudget
      const authorization = context.authorizeVerificationCommand
      const results: Array<{
        label: string
        status: string
        elapsedMs: number
        result?: unknown
        reason?: string
      }> = []
      const lease = budget?.reserveBatch(args.max_duration_ms)
      let reason = lease ? "batch_complete" : "no_verification_time_available"
      const approvedSchema = z.object(bashShape)
      const deadlineAbort = new AbortController()
      const signal = extra?.signal
        ? AbortSignal.any([extra.signal, deadlineAbort.signal])
        : deadlineAbort.signal
      const timer = lease
        ? setTimeout(
            () => deadlineAbort.abort(new Error("Verification batch deadline elapsed")),
            lease.remainingMs()
          )
        : undefined
      const boundedApproval = (input: unknown) =>
        new Promise<unknown>((resolve, reject) => {
          const abort = () => reject(signal.reason ?? new Error("Verification batch interrupted"))
          if (signal.aborted) {
            abort()
            return
          }
          signal.addEventListener("abort", abort, { once: true })
          Promise.resolve()
            .then(() => authorization!(input, signal))
            .then(resolve, reject)
            .finally(() => signal.removeEventListener("abort", abort))
        })
      try {
        if (lease && authorization)
          for (const command of args.commands) {
            if (signal.aborted || !lease.current() || lease.remainingMs() < 1) {
              reason = signal.aborted ? "interrupted" : "batch_deadline_or_turn_changed"
              break
            }
            const started = performance.now()
            try {
              const granted = await boundedApproval({
                command: command.command,
                description: command.label,
                ...(command.workdir ? { workdir: command.workdir } : {}),
                timeout: Math.max(
                  1,
                  Math.floor(Math.min(command.timeout_ms ?? 120_000, lease.remainingMs()))
                ),
              })
              const approved = approvedSchema.parse(granted)
              if (approved.run_in_background || approved.detach)
                throw new Error("Verification batches cannot run in background or detach")
              if (approved.command !== command.command || approved.workdir !== command.workdir) {
                throw new Error(
                  "Changed commands or working directories require a new verification batch"
                )
              }
              if (signal.aborted || !lease.current() || lease.remainingMs() < 1) {
                reason = signal.aborted ? "interrupted" : "budget_elapsed_during_approval"
                break
              }
              assertToolCallWithinRoots(
                context.builtinProcessSandbox,
                "bash",
                approved,
                context.cwd
              )
              const result = await bash.handler(
                {
                  command: approved.command,
                  ...(approved.description ? { description: approved.description } : {}),
                  ...(approved.workdir ? { workdir: approved.workdir } : {}),
                  timeout: Math.max(
                    1,
                    Math.floor(
                      Math.min(
                        approved.timeout ?? 120_000,
                        command.timeout_ms ?? 120_000,
                        lease.remainingMs()
                      )
                    )
                  ),
                  run_in_background: false,
                  detach: false,
                },
                { ...extra, signal }
              )
              results.push({
                label: command.label,
                status: result.isError ? "failed" : "passed",
                elapsedMs: performance.now() - started,
                result,
              })
            } catch (error) {
              results.push({
                label: command.label,
                status: "denied_or_invalid",
                elapsedMs: performance.now() - started,
                reason: error instanceof Error ? error.message : String(error),
              })
              reason = "command_not_authorized_or_invalid"
              break
            }
          }
        if (!authorization) reason = "command_authorization_unavailable"
      } finally {
        if (timer !== undefined) clearTimeout(timer)
        lease?.finish()
      }
      const executedCount = results.filter((row) => row.status !== "denied_or_invalid").length
      const pending = args.commands.slice(executedCount).map(({ label }) => label)
      return toolText(
        JSON.stringify({
          status: pending.length
            ? "incomplete"
            : results.every((row) => row.status === "passed")
              ? "batch_passed"
              : "batch_failed",
          reason,
          results,
          pending,
          allDeclaredCommandsExecuted:
            pending.length === 0 && results.every((row) => row.status !== "denied_or_invalid"),
          fullTaskValidationCertified: false,
          budget: budget?.snapshot() ?? null,
        })
      )
    },
    { searchHint: "verification validation tests checks batches deadline budget" }
  )
}
