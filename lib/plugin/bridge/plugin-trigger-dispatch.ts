/**
 * Plugin trigger dispatch — Phase 2 of ADR-0016 / ADR-0006.
 *
 * (Renamed from `trigger-bridge.ts` in W4.4: two same-named `trigger-bridge`
 * modules — this one and `lib/workflow/runtime/trigger-bridge.ts` — invited
 * wrong-import bugs.)
 *
 * Replaces the Phase-1 stub at `lib/plugin/core/context.ts:1966` that only
 * logged. Now plugin-emitted trigger events resolve to the prefixed kind,
 * verify ownership, and fan out through the same orchestrator path that
 * `lib/db/messages.ts:dispatchChatMessageTriggers` uses for the built-in
 * `trigger.chat.message`.
 *
 * Boundary rules:
 *   1. Pluginlibrary code calls `dispatchPluginTrigger({ pluginId, workflowId,
 *      kind, payload })` — never imports the workflow orchestrator
 *      directly.
 *   2. We prefix `kind` via the shared `prefixPluginKind` helper, then
 *      check the trigger registry to ensure `pluginId` actually owns the
 *      resulting prefixed kind (defense against prototype-pollution-style
 *      misuse of the public API).
 *   3. Dispatch failures are routed through `recordSilentFailure` so the
 *      plugin author sees the issue in the Audit panel rather than only
 *      in the browser console.
 */

import { recordSilentFailure } from "../contracts/diagnostics-store"
import { getWorkflow } from "@/lib/db/workflows"
import {
  getPluginTrigger,
  isTriggerMuted,
  listPluginTriggers,
} from "@/lib/workflow/triggers/registry"
import { prefixPluginKind } from "./kind-prefix"

export interface DispatchPluginTriggerInput {
  pluginId: string
  workflowId: string
  /** Raw kind as the plugin wrote it (e.g. `trigger.bar`). */
  kind: string
  /** Arbitrary JSON-serializable payload that flows to the workflow. */
  payload: unknown
  /** Exact trigger-node root. Required when the workflow has duplicate kinds. */
  triggerId?: string
}

export interface DispatchPluginTriggerResult {
  ok: boolean
  prefixedKind: string
  rejectedReason?:
    "not-registered" | "dispatch-failed" | "muted" | "trigger-node-not-found" | "ambiguous-trigger"
}

/**
 * Resolve the plugin trigger, verify ownership, and call the workflow
 * orchestrator's `dispatchTrigger`. Returns a structured result so the
 * caller (plugin context `emitTriggerEvent`) can decide whether to
 * surface a developer-facing log line in addition to the diagnostic
 * entry written here.
 *
 * Never throws — every failure mode is captured in
 * `recordSilentFailure` and returned as `ok: false`.
 */
export async function dispatchPluginTrigger(
  input: DispatchPluginTriggerInput
): Promise<DispatchPluginTriggerResult> {
  const { pluginId, workflowId, kind, payload, triggerId } = input
  const prefixedKind = prefixPluginKind(pluginId, kind)

  // No explicit not-owned check: `prefixPluginKind` always namespaces
  // under the calling pluginId, so by construction the resulting kind is
  // owned. A bypass would require an attacker who can already call
  // `dispatchPluginTrigger` with a forged pluginId, in which case there
  // is no namespace boundary to enforce in the first place.

  // Mute gate: per-(plugin, kind, workflow) preference set from the
  // plugin detail Triggers tab. Muted triggers resolve silently as
  // `muted` so the caller can distinguish "user paused this" from a
  // genuine routing failure.
  if (isTriggerMuted(pluginId, prefixedKind, workflowId)) {
    return { ok: false, prefixedKind, rejectedReason: "muted" }
  }

  // The trigger must be registered with a version. We don't know which
  // version the workflow is bound to, so we look up the latest match by
  // scanning the registry; this is cheap because plugin trigger counts
  // stay small (≤ a few per plugin).
  const registration = findAnyTriggerVersion(prefixedKind)
  if (!registration) {
    recordSilentFailure(
      pluginId,
      {
        site: "trigger.dispatch",
        message: `Plugin trigger ${prefixedKind} has no live registration; emit ignored`,
        expected: false,
      },
      new Error("not-registered")
    )
    return { ok: false, prefixedKind, rejectedReason: "not-registered" }
  }

  try {
    const workflow = await getWorkflow(workflowId)
    const matchingNodes =
      workflow?.nodes.filter((node) => node.type === prefixedKind && node.data.disabled !== true) ??
      []
    const explicitTriggerId = triggerId?.trim()
    const triggerNode = explicitTriggerId
      ? matchingNodes.find((node) => node.id === explicitTriggerId)
      : matchingNodes.length === 1
        ? matchingNodes[0]
        : undefined

    if (!triggerNode) {
      const ambiguous = !explicitTriggerId && matchingNodes.length > 1
      const rejectedReason = ambiguous ? "ambiguous-trigger" : "trigger-node-not-found"
      const message = ambiguous
        ? `Plugin trigger ${prefixedKind} has multiple enabled nodes on workflow ${workflowId}; emitTriggerEvent must include triggerId`
        : `Plugin trigger ${prefixedKind} has no enabled node ${explicitTriggerId ?? ""} on workflow ${workflowId}`
      recordSilentFailure(
        pluginId,
        { site: "trigger.dispatch", message, expected: false },
        new Error(rejectedReason)
      )
      return { ok: false, prefixedKind, rejectedReason }
    }

    // Bind to the exact node-authored version. A newer registration must not
    // silently execute a workflow node that still targets an older contract.
    if (!getPluginTrigger(prefixedKind, triggerNode.typeVersion)) {
      recordSilentFailure(
        pluginId,
        {
          site: "trigger.dispatch",
          message: `Plugin trigger ${prefixedKind}@${triggerNode.typeVersion} has no live registration; emit ignored`,
          expected: false,
        },
        new Error("not-registered")
      )
      return { ok: false, prefixedKind, rejectedReason: "not-registered" }
    }

    // Lazy-load the orchestrator to keep startup paths cheap — same
    // pattern as `lib/db/messages.ts:dispatchChatMessageTriggers`.
    const { dispatchTrigger } = await import("@/lib/workflow/runtime/trigger-bridge")
    await dispatchTrigger({
      workflowId,
      // Plugin-contributed kinds extend the canonical WorkflowNodeKind
      // union at runtime; cast through `never` to satisfy the closed
      // type while preserving the prefixed string for the orchestrator
      // catalog lookup. Same pattern as `lib/plugin/core/context.ts`.
      kind: prefixedKind as never,
      triggerId: triggerNode.id,
      payload,
      originAt: Date.now(),
    })
    return { ok: true, prefixedKind }
  } catch (error) {
    recordSilentFailure(
      pluginId,
      {
        site: "trigger.dispatch",
        message: `Plugin trigger dispatch failed for ${prefixedKind} on workflow ${workflowId}`,
        // Orchestrator failures are real bugs whether or not we're in
        // Tauri — the workflow runtime lives in TS, not Rust.
        expected: false,
      },
      error
    )
    return { ok: false, prefixedKind, rejectedReason: "dispatch-failed" }
  }
}

/**
 * Find the highest-versioned registration of `kind` by scanning the actual
 * registrations (W4.4). The previous implementation brute-forced typeVersion
 * 1..50, so a trigger registered above 50 was silently unfindable.
 */
function findAnyTriggerVersion(prefixedKind: string): ReturnType<typeof getPluginTrigger> {
  let best: ReturnType<typeof getPluginTrigger>
  for (const reg of listPluginTriggers()) {
    if (reg.kind !== prefixedKind) continue
    if (!best || reg.typeVersion > best.typeVersion) best = reg
  }
  return best
}
