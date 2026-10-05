import { drainPending } from "../../shared/pending.ts"
import type { ApprovalAnswer } from "../../policy/permission/approval.ts"
import type { PluginToolResponse } from "../../tools/plugin/proxy.ts"

/** Settle host round trips when their session can no longer answer. */
export function drainPendingRoundTrips(
  {
    pendingApprovals,
    pendingPluginToolCalls,
    pendingPluginHookCalls,
    pendingToolResultReviews,
    pendingProtocolExecs,
    ledgerGate,
    pluginToolFailure,
  }: {
    pendingApprovals?: Map<string, { resolve(answer: ApprovalAnswer): void }>
    pendingPluginToolCalls?: Map<string, { resolve(answer: PluginToolResponse): void }>
    pendingPluginHookCalls?: Map<string, { resolve(answer: unknown): void }>
    pendingToolResultReviews?: Map<string, { resolve(answer: unknown): void }>
    pendingProtocolExecs?: Map<
      string,
      { cancel?(reason: string): void; fail(reason: string): void }
    >
    ledgerGate?: { drain(reason: string): void }
    pluginToolFailure?: PluginToolResponse
  } = {},
  reason = "interrupted",
  notifyInterrupted?: (requestId: string) => void
) {
  ledgerGate?.drain(reason)
  drainPending(pendingApprovals, { behavior: "deny", message: reason }, notifyInterrupted)
  drainPending(pendingPluginToolCalls, pluginToolFailure ?? { error: reason })
  drainPending(pendingPluginHookCalls, { error: reason })
  drainPending(pendingToolResultReviews, undefined)
  if (pendingProtocolExecs) {
    for (const [id, channel] of pendingProtocolExecs) {
      pendingProtocolExecs.delete(id)
      try {
        if (channel.cancel) channel.cancel(reason)
        else channel.fail(reason)
      } catch {
        /* a foreign channel cannot block remaining cleanup */
      }
    }
  }
}
