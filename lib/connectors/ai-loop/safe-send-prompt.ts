/**
 * PII-aware wrapper around `runAndCaptureAssistantReply` used by the
 * connector subsystem when it drives an auto-mode AI turn on behalf of
 * an inbound IM message.
 *
 * Why the wrapper exists: the same red-line that `lib/twin/ingest/` and
 * `lib/goal/` enforce — "raw user-supplied text MUST be checked by
 * `hasNoLeakingPii` before it leaves the device" — also applies to
 * auto-mode IM replies. The renderer-side chat composer is reviewed by
 * a human; the IM-driven loop is not. So this wrapper:
 *
 *   1. Walks every text-bearing block of the inbound `SendContent` plus
 *      any `appendSystemPrompt` injected by build-options.
 *   2. Calls `hasNoLeakingPii` on each.
 *   3. If anything leaks, aborts before calling the model and writes a
 *      `connector.error` audit row tagged `reason: "pii_blocked"` so the
 *      operator can see why the auto reply did not fire.
 *
 * Returns the same shape as `runAndCaptureAssistantReply` so callers can
 * substitute one for the other without code-path changes.
 */

import { hasNoLeakingPii } from "@cognia/redact"
import {
  RunAndCaptureError,
  runAndCaptureAssistantReply,
  type RunAndCaptureOptions,
  type RunAndCaptureResult,
} from "@/lib/claude/run-and-capture"
import type { SendContent, SendOptions } from "@cognia/agent-config-types"
import { appendAudit } from "@/lib/connectors/audit"
import { recordProviderOutcome } from "@/lib/claude/provider-telemetry"
import { recordConnectorUsage, swallowUsageWrite } from "@/lib/db/session-usage"
import { groundSendOptionsAnswer } from "@/lib/rag/chat-grounding"
import { acquireWorkspaceBundle } from "@/lib/task-workspace/client"
import {
  openWorkspaceBundleTurnLease,
  type WorkspaceBundleTurnLease,
} from "@/lib/task-workspace/run-lease"
import type { AcquireWorkspaceBundle, BeginTaskWorkspaceTurn } from "@/lib/task-workspace/types"

export interface SafeSendPromptOptions extends RunAndCaptureOptions {
  /**
   * The adapter the auto-mode call originated from. Used as the
   * `adapterId` of the audit row when PII gating aborts the call.
   */
  adapterId: string
  /**
   * The conversation key on the adapter side — surfaced in the audit
   * row so the operator can jump straight to the offending thread.
   */
  conversationKey: string
}

/**
 * Bounded memo for the *system-prompt* PII scan. The `appendSystemPrompt`
 * build-options injects (character prompt + twin/memory/skills/capability
 * sections) is large and largely stable across a conversation's turns, so the
 * same string is otherwise rescanned (≈12 regex sweeps) every turn. Caching the
 * boolean by exact content skips the sweep on a repeat.
 *
 * This does NOT weaken the gate: `hasNoLeakingPii` is a pure, stateless function
 * of its text (redact.ts:388), so a cached `true` is permanently valid for that
 * exact string. A never-seen OR PII-leaking prompt is a cache miss that runs the
 * real scan and still throws. The inbound user prompt (line ~78) is intentionally
 * NOT cached — it changes every turn, so a cache would only add overhead.
 */
const SYSTEM_PROMPT_PII_CACHE_CAP = 64
const systemPromptPiiCache = new Map<string, boolean>()

export function hasNoLeakingPiiCached(text: string): boolean {
  const hit = systemPromptPiiCache.get(text)
  if (hit !== undefined) {
    // Refresh LRU recency (delete + re-set moves the key to the newest slot).
    systemPromptPiiCache.delete(text)
    systemPromptPiiCache.set(text, hit)
    return hit
  }
  const result = hasNoLeakingPii(text)
  if (systemPromptPiiCache.size >= SYSTEM_PROMPT_PII_CACHE_CAP) {
    const oldest = systemPromptPiiCache.keys().next().value
    if (oldest !== undefined) systemPromptPiiCache.delete(oldest)
  }
  systemPromptPiiCache.set(text, result)
  return result
}

/** Test-only — clear the system-prompt PII memo between cases. */
export function _resetSystemPromptPiiCacheForTest(): void {
  systemPromptPiiCache.clear()
}

export class PiiGateBlocked extends Error {
  constructor(
    readonly source: "prompt" | "appendSystemPrompt",
    readonly adapterId: string,
    readonly conversationKey: string
  ) {
    super(`PII gate blocked auto-mode send (${source}) on ${adapterId}/${conversationKey}`)
    this.name = "PiiGateBlocked"
  }
}

export class GroundingGateBlocked extends Error {
  readonly code = "grounding_below_threshold"

  constructor(
    readonly adapterId: string,
    readonly conversationKey: string,
    readonly supportRatio: number
  ) {
    super(`Grounding gate blocked auto-mode reply on ${adapterId}/${conversationKey}`)
    this.name = "GroundingGateBlocked"
  }
}

interface ConnectorWritableRoot {
  logicalRootId: string
  role: "primary" | "additional"
  sourceRoot: string
}

interface ConnectorWorkspaceTurn {
  lease: WorkspaceBundleTurnLease
  options: SendOptions
}

let connectorTurnSequence = 0

function compareRootPaths(left: string, right: string): number {
  return right.length - left.length || (left < right ? -1 : left > right ? 1 : 0)
}

function connectorWritableRoots(options: SendOptions | undefined): ConnectorWritableRoot[] {
  const cwd = options?.cwd?.trim()
  const unique = new Set<string>()
  if (cwd) unique.add(cwd)
  for (const value of options?.additionalDirectories ?? []) {
    const path = value.trim()
    if (path) unique.add(path)
  }
  if (unique.size === 0) return []

  const sorted = [...unique].sort(compareRootPaths)
  const primaryPath = cwd ?? sorted[0]
  const ordered = [primaryPath, ...sorted.filter((path) => path !== primaryPath)]
  return ordered.map((sourceRoot, index) => ({
    logicalRootId: `connector-root-${index}`,
    role: index === 0 ? "primary" : "additional",
    sourceRoot,
  }))
}

function connectorBoundaryId(prefix: string, value: string): string {
  return `${prefix}${value.replace(/[^a-zA-Z0-9_.:-]/g, "_")}`.slice(0, 128)
}

function remapExactRoots(values: string[], aliasesBySource: ReadonlyMap<string, string>): string[] {
  return values.map((value) => aliasesBySource.get(value.trim()) ?? value)
}

async function openConnectorWorkspaceTurn(
  sessionId: string,
  options: SendOptions | undefined,
  opts: SafeSendPromptOptions
): Promise<ConnectorWorkspaceTurn | null> {
  const roots = connectorWritableRoots(options)
  if (roots.length === 0) return null
  if (options?.sandboxRuntimeRef) {
    // The send already carries a resolved sandbox placement, bound against the
    // pre-remap roots. Remapping `cwd` onto bundle aliases underneath it would
    // leave the two describing different directories, so the bundle stands
    // down and the sandbox placement — the stricter, already-authoritative one
    // — governs the turn. Refusing outright is not an option: `resolveSendOptions`
    // stamps this ref for every session with the sandbox or Computer Use on,
    // so throwing here failed every inbound auto-reply for those users.
    return null
  }

  const acquire: AcquireWorkspaceBundle = {
    ownerType: "session",
    ownerRef: sessionId,
    environmentKind: "managed",
    base: { kind: "remoteDefault" },
    roots,
  }
  const bundle = await acquireWorkspaceBundle(acquire)
  const turnId =
    options?.turnId?.trim() || `connector-${Date.now()}-${(connectorTurnSequence += 1)}`
  const taskId = connectorBoundaryId("task:connector:", sessionId)
  const runId = connectorBoundaryId("run:connector:", `${sessionId}:${turnId}`)
  const primaryRoot = roots[0]
  const run: BeginTaskWorkspaceTurn = {
    taskId,
    sessionId,
    runId,
    executionRunId: runId,
    turnId,
    attemptId: "a1",
    surface: "connector",
    agentId: opts.adapterId,
    agentKind: "connector",
    workspaceRoot: primaryRoot.sourceRoot,
  }
  const lease = await openWorkspaceBundleTurnLease(bundle, primaryRoot.logicalRootId, run)
  if (!lease) throw new Error("Connector workspace Bundle Turn is unavailable")
  const aliases = [lease.primaryAlias, ...lease.additionalAliases]
  if (aliases.length !== roots.length) {
    await lease.abort().catch(() => undefined)
    throw new Error("Connector workspace Bundle Turn returned an incomplete root alias mapping")
  }
  const aliasesBySource = new Map(
    roots.map((root, index) => [root.sourceRoot, aliases[index]] as const)
  )

  return {
    lease,
    options: {
      ...options,
      cwd: lease.primaryAlias,
      additionalDirectories: lease.additionalAliases,
      ...(options?.confinement
        ? {
            confinement: {
              ...options.confinement,
              roots: remapExactRoots(options.confinement.roots, aliasesBySource),
            },
          }
        : {}),
      ...(options?.trustedWorkspaceRoots
        ? {
            trustedWorkspaceRoots: remapExactRoots(options.trustedWorkspaceRoots, aliasesBySource),
          }
        : {}),
      taskWorkspace: {
        taskId,
        runId: lease.run.runId,
        workspaceRoot: primaryRoot.sourceRoot,
        agentId: opts.adapterId,
        agentKind: "connector",
      },
    },
  }
}

/**
 * Drive a Claude turn for the connector auto-mode loop, gating on the
 * PII red-line first.
 *
 * Throws `PiiGateBlocked` when the prompt OR the appendSystemPrompt
 * carries leakable PII; the audit row is written before the throw so
 * the caller can simply propagate.
 *
 * Throws `RunAndCaptureError` on the same conditions as the underlying
 * `runAndCaptureAssistantReply` — the wrapper is transparent past the
 * PII gate.
 */
export async function safeSendPrompt(
  sessionId: string,
  prompt: SendContent,
  options: SendOptions | undefined,
  opts: SafeSendPromptOptions
): Promise<RunAndCaptureResult> {
  // ── 1. Walk prompt content for PII ─────────────────────────────────
  if (!isPiiSafeSendContent(prompt)) {
    await appendAudit({
      adapterId: opts.adapterId,
      kind: "adapter.error",
      at: Date.now(),
      conversationKey: opts.conversationKey,
      reason: "pii_blocked",
      message: "auto-mode prompt rejected by PII gate before sendPrompt",
    })
    throw new PiiGateBlocked("prompt", opts.adapterId, opts.conversationKey)
  }

  // ── 2. Walk the model-side system-prompt tail (build-options may
  //     inject capability context, twin runtime hints, etc.). We don't
  //     redact — we abort, because the auto-mode loop has no human to
  //     decide what to redact.
  if (options?.appendSystemPrompt && !hasNoLeakingPiiCached(options.appendSystemPrompt)) {
    await appendAudit({
      adapterId: opts.adapterId,
      kind: "adapter.error",
      at: Date.now(),
      conversationKey: opts.conversationKey,
      reason: "pii_blocked",
      message: "auto-mode appendSystemPrompt rejected by PII gate",
    })
    throw new PiiGateBlocked("appendSystemPrompt", opts.adapterId, opts.conversationKey)
  }

  const workspaceTurn = await openConnectorWorkspaceTurn(sessionId, options, opts)
  const sendOptions = workspaceTurn?.options ?? options

  // ── 3. Delegate to the existing capture wrapper ────────────────────
  // Forward the FULL capture surface, not just signal/timeout/onPartial:
  // the primary inbound ai-run wires `onPermissionRequest` (IM tool-approval
  // HITL) and `onEvent` (live-activity card). Dropping them here would
  // silently disable both when the inbound turn is routed through this gate.
  let result: RunAndCaptureResult
  try {
    result = await runAndCaptureAssistantReply(sessionId, prompt, sendOptions, {
      signal: opts.signal,
      timeoutMs: opts.timeoutMs,
      onPartial: opts.onPartial,
      onPermissionRequest: opts.onPermissionRequest,
      onEvent: opts.onEvent,
      execution: {
        kind: "connector",
        label: `${opts.adapterId} · ${opts.conversationKey}`,
      },
    })
    const grounding = groundSendOptionsAnswer(result.text, sendOptions, "external_send")
    if (grounding?.blocked) {
      await appendAudit({
        adapterId: opts.adapterId,
        kind: "adapter.error",
        at: Date.now(),
        conversationKey: opts.conversationKey,
        reason: "grounding_below_threshold",
        message: "auto-mode reply blocked before outbound delivery",
        fields: {
          supportedClaims: grounding.claims.length - grounding.unsupportedClaimIds.length,
          unsupportedClaims: grounding.unsupportedClaimIds.length,
        },
      })
      throw new GroundingGateBlocked(opts.adapterId, opts.conversationKey, grounding.supportRatio)
    }
    if (workspaceTurn) await workspaceTurn.lease.settle("ready")
  } catch (error) {
    if (workspaceTurn) await workspaceTurn.lease.abort().catch(() => undefined)
    throw error
  }
  if (result.usage) {
    const usage = result.usage
    swallowUsageWrite(
      recordConnectorUsage({
        adapterId: opts.adapterId,
        conversationKey: opts.conversationKey,
        usage,
      })
    )
    if (sendOptions?.provider) {
      recordProviderOutcome({
        providerId: sendOptions.provider,
        ok: true,
        latencyMs: usage.durationMs ?? 0,
        estimatedCostUsd: usage.totalCostUsd,
        modelId: sendOptions.model,
        tokensUsed: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadInputTokens,
        cacheCreationTokens: usage.cacheCreationInputTokens,
        sessionId,
        // Provider child span nests under the connector turn's root span
        // (minted by resolveSendOptions with traceSurface "connector").
        traceId: sendOptions.traceId,
        parentSpanId: sendOptions.spanId,
        surface: "connector",
      })
    }
  }
  return result
}

/**
 * Walk every text-bearing block of a `SendContent` value and return true
 * iff every one passes the PII gate. Image / file blocks are skipped —
 * the gate is about leakable text; binary attachments are out of scope
 * (the attachment pipeline encrypts them on disk via attachments.rs).
 *
 * Matches the actual `SendContent` union (`string | SendContentBlock[]`)
 * defined in `lib/claude/types.ts`. SendContentBlock is a discriminated
 * union with `type: "text" | "image" | …` — we only need the `"text"`
 * branch.
 */
export function isPiiSafeSendContent(content: SendContent): boolean {
  if (typeof content === "string") {
    return hasNoLeakingPii(content)
  }
  if (!Array.isArray(content)) return true
  for (const block of content) {
    if (block && typeof block === "object" && block.type === "text") {
      if (!hasNoLeakingPii(block.text)) return false
    }
  }
  return true
}

// Re-export the wrapped error for callers that want to discriminate.
export { RunAndCaptureError }
