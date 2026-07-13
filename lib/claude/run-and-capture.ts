/**
 * Run a Claude turn and capture the assistant's final reply text.
 *
 * Why this wrapper exists: the sidecar IPC `sendPrompt(...)` is fire-and-
 * forget — the assistant reply streams back as `claude://message` events.
 * The connector runtime needs the final text to enqueue an outbound
 * platform message, so it can't just call `sendPrompt` and hope. This
 * helper subscribes to the event channel before sending, accumulates
 * assistant content, and resolves with `{ text, messageId }` once the
 * session ends.
 *
 * Scope: this helper does NOT save the assistant message itself. The
 * existing renderer-side persistence (`hooks/chat/use-claude-chat.ts`)
 * already does that via the same event channel — both subscribers see
 * each event independently. The bridge only intercepts text for outbound
 * routing.
 *
 * Cancellation: pass an `AbortSignal` to abort early. On abort, the
 * subscription is detached, an `interruptSession` IPC is fired (best
 * effort), and the promise rejects with `AbortError`. Mirrors the
 * `mode-switcher.tsx:invoke("claude_interrupt", ...)` semantics so a
 * mode switch mid-run cleans up properly.
 */

import {
  sendPrompt,
  interruptSession,
  onClaudeMessage,
  approveTool,
  toolResultDecision,
} from "./ipc"
import type {
  ApprovalDecision,
  ClaudeEvent,
  PermissionRequestEvent,
  ToolResultReviewEvent,
  SendContent,
  SendOptions,
} from "@cognia/agent-config-types"
import type { A2UISegmentContent } from "@/types/connectors/segment"
import { extractUsage, type UsageInfo } from "./adapter"
import { runChatMiddlewareChain } from "@/lib/claude/chat-middleware/runner"
import { listActiveChatMiddlewares } from "@/lib/claude/chat-middleware/registry"
import { isChatMiddlewareExecutionEnabled } from "@/lib/claude/chat-middleware/feature-flag"
import type { ChatMiddlewareRequest } from "@/types/plugin/plugin-chat-middleware"
import type { PluginMessage } from "@/types/plugin/plugin"
import { runWithExecutionLease, combineAbortSignals } from "@/lib/execution/admit"
import type { ExecutionLeaseInfo } from "@/lib/execution/types"

export interface RunAndCaptureResult {
  /** The accumulated assistant reply text (concatenated text blocks). */
  text: string
  /**
   * The SDK assistant message uuid we captured the text from. Used by the
   * caller as a stable idempotency key so retries don't double-send.
   */
  messageId: string
  /**
   * A2UI surfaces created or updated during this turn, keyed by
   * `surfaceId`. The keys mirror the order the assistant emitted them
   * in `a2uiSurfaceOrder`. Populated when the assistant calls the
   * `builtin:a2ui-bridge` MCP tools (`a2ui_create_surface` /
   * `a2ui_update_components` / `a2ui_data_model_update`); empty when the
   * reply is plain text.
   *
   * The connector auto-mode loop reads these to project A2UI segments
   * into the outbound MessageSegment[] via `assistantReplyToSegments`.
   */
  a2uiSurfaces: Record<string, A2UISegmentContent>
  /**
   * Surface ids in the order the assistant first introduced them. Used
   * by `assistantReplyToSegments` to keep delivery order deterministic
   * across retries.
   */
  a2uiSurfaceOrder: string[]
  /**
   * Token/cost usage for this turn, extracted from the SDK result message at
   * `session_ended` (`undefined` when the result carried no usage). Consumed
   * by headless turn-loop drivers (e.g. the scheduled-goal runner) that need
   * a per-turn `tokensDelta` to feed the goal budget exit condition.
   */
  usage?: UsageInfo
  /**
   * The SDK `result` message subtype for this turn (e.g. `"success"`,
   * `"error_max_turns"`, `"error_max_budget_usd"`). Headless turn-loop drivers
   * read this to detect a hard-ceiling stop and exit the goal accordingly.
   * Undefined when no result subtype was seen.
   */
  resultSubtype?: string
  /**
   * The SDK-issued session id emitted during this turn (`sdk_session_id`
   * event), when one was seen. Headless multi-turn drivers persist this onto
   * the `ChatSession` row so the next send resumes the conversation. Undefined
   * on the text channel / when no event arrived.
   */
  sdkSessionId?: string
}

/**
 * Internal accumulator: tracks A2UI surface state across the assistant
 * stream so deletion + create-after-delete works correctly. The runner
 * mirrors the same dispatch table the renderer uses, but in memory only —
 * the surfaces are NEVER written to Dexie from this code path. Persistence
 * is the renderer's job; the auto-mode loop just needs to hand the
 * surfaces to the outbound runner.
 */
interface SurfaceAccumulator {
  surfaces: Map<string, A2UISegmentContent>
  order: string[]
}

const A2UI_TOOL_PREFIX = "mcp__a2ui-bridge__"

function applyA2UIToolCall(
  acc: SurfaceAccumulator,
  toolName: string,
  input: Record<string, unknown>
): void {
  if (!toolName.startsWith(A2UI_TOOL_PREFIX)) return
  const op = toolName.slice(A2UI_TOOL_PREFIX.length)
  const surfaceId = typeof input.surfaceId === "string" ? input.surfaceId : null
  if (!surfaceId) return

  switch (op) {
    case "a2ui_create_surface": {
      const surface: A2UISegmentContent = {
        components: {},
        dataModel: {},
        rootId: "root",
        surfaceType: (input.surfaceType as A2UISegmentContent["surfaceType"]) ?? "inline",
        catalogId: typeof input.catalogId === "string" ? input.catalogId : undefined,
        title: typeof input.title === "string" ? input.title : undefined,
        widget:
          input.widget && typeof input.widget === "object"
            ? (input.widget as Record<string, unknown>)
            : undefined,
      }
      // Re-create overwrites any prior in-flight state for this surfaceId
      // — mirrors the renderer dispatch.
      acc.surfaces.set(surfaceId, surface)
      if (!acc.order.includes(surfaceId)) acc.order.push(surfaceId)
      break
    }
    case "a2ui_update_components": {
      const existing =
        acc.surfaces.get(surfaceId) ??
        ({
          components: {},
          dataModel: {},
          rootId: "root",
          surfaceType: "inline",
        } as A2UISegmentContent)
      const components = Array.isArray(input.components)
        ? (input.components as Array<Record<string, unknown>>)
        : []
      const map: Record<string, Record<string, unknown>> = { ...existing.components } as Record<
        string,
        Record<string, unknown>
      >
      for (const comp of components) {
        if (comp && typeof comp.id === "string") {
          map[comp.id] = comp
        }
      }
      // Pick a sensible root: first component's id if no `root` key
      // present yet. Mirrors the renderer's "first component is root"
      // convention for assistant-emitted updates.
      const firstId = components[0]?.id as string | undefined
      const rootId = "root" in map ? "root" : (firstId ?? existing.rootId)
      acc.surfaces.set(surfaceId, { ...existing, components: map, rootId })
      if (!acc.order.includes(surfaceId)) acc.order.push(surfaceId)
      break
    }
    case "a2ui_data_model_update": {
      const existing =
        acc.surfaces.get(surfaceId) ??
        ({
          components: {},
          dataModel: {},
          rootId: "root",
          surfaceType: "inline",
        } as A2UISegmentContent)
      const data =
        input.data && typeof input.data === "object" ? (input.data as Record<string, unknown>) : {}
      const merge = input.merge !== false // default true
      const dataModel = merge ? { ...existing.dataModel, ...data } : data
      acc.surfaces.set(surfaceId, { ...existing, dataModel })
      if (!acc.order.includes(surfaceId)) acc.order.push(surfaceId)
      break
    }
    case "a2ui_delete_surface": {
      acc.surfaces.delete(surfaceId)
      acc.order = acc.order.filter((id) => id !== surfaceId)
      break
    }
    default:
      // Unknown A2UI tool — ignore so future additions don't break the loop.
      break
  }
}

export class RunAndCaptureError extends Error {
  constructor(
    message: string,
    readonly code:
      "session_error" | "no_assistant_text" | "aborted" | "send_failed" | "sidecar_exited"
  ) {
    super(message)
    this.name = "RunAndCaptureError"
  }
}

/**
 * Typed incremental events surfaced from the SAME assistant-block parse loop
 * the capture already walks. Consumed by the plugin Agent SDK's `runStreamed`
 * so it doesn't have to re-parse `onClaudeMessage`. Best-effort: a throwing
 * callback is swallowed and never affects capture.
 */
export type CaptureStreamEvent =
  | { type: "text-delta"; delta: string }
  | { type: "thinking-delta"; delta: string }
  | {
      type: "tool-call"
      toolName: string
      input: Record<string, unknown>
      /** The originating `tool_use` block id, when the SDK supplies one. A stable
       * per-call identity so consumers can pair a later `tool-result` exactly and
       * distinguish two concurrent calls with identical name+input. */
      id?: string
    }
  | {
      type: "tool-result"
      toolName: string
      /** Tool arguments correlated from the originating `tool_use` block, when known. */
      input?: Record<string, unknown>
      /** The `tool_use_id` this result answers, when known (see `tool-call.id`). */
      id?: string
      result: unknown
      isError?: boolean
    }
  /**
   * Token/cost usage for the turn, surfaced from the SDK `result` message as it
   * streams. The native Anthropic sidecar emits `session_ended` WITHOUT a
   * `result` payload, so consumers that want live usage (the CLI TUI footer)
   * cannot rely on the resolved `RunAndCaptureResult.usage` alone — this event
   * delivers it from the in-stream result message instead.
   */
  | {
      type: "usage"
      usage: UsageInfo
      /**
       * True for a MID-run per-assistant-message snapshot (not cumulative);
       * consumers that want a live figure SUM these and let the final
       * authoritative (non-partial) `result`-message usage replace the sum.
       * Absent/false = the end-of-turn authoritative usage.
       */
      partial?: boolean
    }
  /**
   * A context-compaction boundary crossed mid-stream. Both dispatch paths emit
   * the same `system` / `compact_boundary` message — the generic AI-SDK path
   * (`sidecar/dispatch/ai-sdk.mjs`) when it summarizes older turns, and the
   * Anthropic Agent SDK when it auto/manually compacts. Surfaced here so the CLI
   * TUI can mark the boundary inline (the desktop renders it from the raw
   * `claude://message` event independently). `trigger` is `"manual"` for a
   * user-requested `/compact` and `"auto"` for the threshold-driven one.
   */
  | { type: "compact"; trigger: "manual" | "auto"; preTokens: number; postTokens: number }

/**
 * Read a `compact_boundary` system message into the typed {@link CaptureStreamEvent}
 * `compact` shape, or return `null` when `inner` is not a compaction boundary.
 * Shared by the in-stream capture loop and the CLI's between-turn manual-compact
 * runner so both agree on the wire shape (`sidecar/dispatch/ai-sdk.mjs` emits it).
 */
export function compactBoundaryFromInner(
  inner: unknown
): Extract<CaptureStreamEvent, { type: "compact" }> | null {
  const ev = inner as {
    type?: string
    subtype?: string
    compact_metadata?: { trigger?: string; pre_tokens?: unknown; post_tokens?: unknown }
  } | null
  if (!ev || ev.type !== "system" || ev.subtype !== "compact_boundary") return null
  const meta = ev.compact_metadata ?? {}
  const toNum = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0)
  return {
    type: "compact",
    trigger: meta.trigger === "manual" ? "manual" : "auto",
    preTokens: toNum(meta.pre_tokens),
    postTokens: toNum(meta.post_tokens),
  }
}

/** Decision returned by a {@link RunAndCaptureOptions.onPermissionRequest} responder. */
export interface CapturePermissionDecision {
  decision: ApprovalDecision
  message?: string
  updatedInput?: unknown
}

/** Tool result + correlated call passed to an {@link RunAndCaptureOptions.onToolResultReview} responder. */
export interface CaptureToolResult {
  toolName: string
  input: Record<string, unknown>
  result: unknown
  isError: boolean
}

/** Decision returned by an {@link RunAndCaptureOptions.onToolResultReview} responder. */
export interface CaptureToolResultDecision {
  /** Rewrite the tool output the model sees. Honored only on the review round-trip. */
  updatedToolOutput?: unknown
}

export interface RunAndCaptureOptions {
  /**
   * Optional cancellation signal. When the signal aborts, the wrapper
   * detaches its subscription, fires `interruptSession` (best-effort),
   * and rejects with a `RunAndCaptureError({ code: "aborted" })`.
   */
  signal?: AbortSignal
  /**
   * Maximum wall-clock to wait for `session_ended` before rejecting.
   * Defaults to 5 minutes — matches the platform-side default function
   * timeout (Vercel docs note 300s as the default cap). Pass `0` to
   * disable the timeout entirely.
   */
  timeoutMs?: number
  /**
   * Idle (read) timeout in ms. When set > 0, the turn fails if the provider
   * stream goes silent for this long AFTER it has started producing output —
   * the "socket open, no bytes" stall some OpenAI-compatible relays exhibit.
   * Rejects with a `session_error` (recoverable: the session stays alive). The
   * watchdog arms only after the first streamed event and pauses while a
   * permission request is awaiting the user, so slow cold starts and long
   * approvals never trip it. Default `0` (disabled) — independent of the
   * wall-clock {@link timeoutMs}.
   */
  idleTimeoutMs?: number
  /**
   * Optional incremental-output callback. Fired each time the accumulated
   * assistant text grows (every streamed `assistant` event carries the full
   * text-so-far for our use case, so this receives the running total, not a
   * delta). Used by the connector runtime to drive platform-side streaming
   * replies (WeCom 智能机器人 `aibot_respond_msg` stream frames). Best-effort:
   * a throwing or rejecting callback is swallowed and never affects capture.
   * Default `undefined` → zero behaviour change for chat / non-streaming
   * connectors.
   */
  onPartial?: (accumulatedText: string) => void | Promise<void>
  /**
   * Typed incremental events (text deltas + tool calls) from the assistant
   * stream. Used by the plugin Agent SDK's `runStreamed`. Best-effort: a
   * throwing callback is swallowed. Default `undefined` → no events emitted.
   */
  onEvent?: (event: CaptureStreamEvent) => void
  /**
   * Headless permission responder. When the sidecar emits a
   * `permission_request` (an *ask*-tier tool) for this session, the wrapper
   * calls this and forwards the decision via `approveTool` — including a
   * rewritten `updatedInput`. This is the seam the plugin Agent SDK's
   * `canUseTool` plugs into. When `undefined`, permission requests are left
   * unanswered (legacy behaviour — the turn relies on the chat UI approver or
   * times out). Best-effort: a throwing/rejecting responder denies the call.
   */
  onPermissionRequest?: (
    request: PermissionRequestEvent
  ) => CapturePermissionDecision | Promise<CapturePermissionDecision>
  /**
   * PostToolUse responder. Called exactly once per tool result: on the ai-sdk
   * channel via the `tool_result_review` round-trip (where a returned
   * `updatedToolOutput` REWRITES what the model sees), and otherwise at
   * observation time (where the return is ignored). The capture loop dedupes so
   * a reviewed tool is never also fired as observation. This is the seam the
   * plugin Agent SDK's `onPostToolUse` hook plugs into. Best-effort: a
   * throwing/rejecting responder leaves the output unchanged.
   */
  onToolResultReview?: (
    request: CaptureToolResult
  ) => CaptureToolResultDecision | void | Promise<CaptureToolResultDecision | void>
  /**
   * Execution-broker admission metadata. This wrapper is the shared chokepoint
   * for every headless leg (connector auto-reply, agent team, scheduled goal,
   * plugin Agent SDK, eval) — none of which went through the foreground chat
   * cap. Admitting here registers the leg with the global {@link
   * getExecutionBroker} so all four subsystems share one ceiling, become
   * observable in one place, and are cancellable as a unit. The broker's
   * `lease.signal` is combined with any {@link signal} above and handed to the
   * underlying capture, so a broker-side cancel actually stops the turn.
   *
   * Defaults: when omitted, the leg is still admitted with kind `"subagent"`
   * and a session-derived label. Set `execution.skip` to bypass admission for a
   * caller that is already governed elsewhere (e.g. a nested re-entry).
   */
  execution?: ExecutionLeaseInfo
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000

/**
 * Drive a Claude turn and resolve with the assistant's captured text once
 * the session ends.
 *
 * Around-style chat middlewares (ADR-0026 §4 §A) wrap the *whole* turn, so
 * they belong on this non-streaming full-reply path — not the streaming UI
 * chat hook, where text is already on screen before any "final response"
 * exists. Execution is gated behind a DEFAULT-OFF flag
 * (`isChatMiddlewareExecutionEnabled`); when off, or when no middleware is
 * registered, the call goes straight to `captureAssistantReplyCore` with zero
 * overhead and identical behaviour. When on, the chain wraps the capture and
 * any text transformation is applied back onto the full result.
 */
export async function runAndCaptureAssistantReply(
  sessionId: string,
  prompt: SendContent,
  options?: SendOptions,
  cap?: RunAndCaptureOptions
): Promise<RunAndCaptureResult> {
  // Admission bypass: a caller that is already governed (or a context with no
  // broker, e.g. some CLI paths) opts out via `execution.skip`.
  if (cap?.execution?.skip) {
    return runCaptureWithMiddleware(sessionId, prompt, options, cap)
  }

  const info = cap?.execution
  return runWithExecutionLease(
    {
      kind: info?.kind ?? "subagent",
      label: info?.label ?? `Headless turn ${sessionId.slice(0, 8)}`,
      sessionId: info?.sessionId ?? sessionId,
      ...(info?.runId ? { runId: info.runId } : {}),
      ...(info?.taskId ? { taskId: info.taskId } : {}),
      ...(info?.projectId ? { projectId: info.projectId } : {}),
      ...(info?.weight ? { weight: info.weight } : {}),
    },
    (lease) => {
      // Combine the broker lease signal with any caller signal so a broker-side
      // cancel (by id / session / project) aborts the underlying turn.
      const combined = combineAbortSignals(cap?.signal, lease.signal)
      const effectiveCap: RunAndCaptureOptions | undefined = combined
        ? { ...cap, signal: combined.signal }
        : cap
      const run = runCaptureWithMiddleware(sessionId, prompt, options, effectiveCap)
      return combined ? run.finally(combined.cleanup) : run
    }
  )
}

/**
 * The middleware-aware capture. Was the body of {@link runAndCaptureAssistantReply}
 * before broker admission was layered on top; kept as a private seam so the
 * admission wrapper stays thin and the middleware logic is unchanged.
 */
async function runCaptureWithMiddleware(
  sessionId: string,
  prompt: SendContent,
  options?: SendOptions,
  cap?: RunAndCaptureOptions
): Promise<RunAndCaptureResult> {
  if (!isChatMiddlewareExecutionEnabled()) {
    return captureAssistantReplyCore(sessionId, prompt, options, cap)
  }
  const active = listActiveChatMiddlewares()
  if (active.length === 0) {
    return captureAssistantReplyCore(sessionId, prompt, options, cap)
  }

  const request: ChatMiddlewareRequest = {
    messages:
      typeof prompt === "string"
        ? [{ id: "turn", role: "user", content: prompt } satisfies PluginMessage]
        : [],
    model: options?.model ?? "",
    sessionId,
    options: {
      systemPrompt: options?.systemPrompt,
      appendSystemPrompt: options?.appendSystemPrompt,
      allowedTools: options?.allowedTools,
    },
    signal: cap?.signal ?? new AbortController().signal,
  }

  // Hold the captured result on an object so TS keeps its union type across
  // the terminal closure (a bare `let` would be narrowed to its only visible
  // synchronous assignment).
  const holder: { value: RunAndCaptureResult | null } = { value: null }
  const { response } = await runChatMiddlewareChain(
    request,
    async () => {
      const result = await captureAssistantReplyCore(sessionId, prompt, options, cap)
      holder.value = result
      return { text: result.text }
    },
    { signal: cap?.signal }
  )

  if (!holder.value) {
    // A middleware short-circuited without calling next() — return its text
    // with empty surfaces (no real turn ran).
    return { text: response.text, messageId: "", a2uiSurfaces: {}, a2uiSurfaceOrder: [] }
  }
  // Apply any text transformation the chain produced onto the captured result.
  return response.text === holder.value.text
    ? holder.value
    : { ...holder.value, text: response.text }
}

/**
 * The actual capture implementation. See module-level docs for behavioural
 * notes. Wrapped by `runAndCaptureAssistantReply` for chat-middleware support.
 */
async function captureAssistantReplyCore(
  sessionId: string,
  prompt: SendContent,
  options?: SendOptions,
  cap?: RunAndCaptureOptions
): Promise<RunAndCaptureResult> {
  const timeoutMs = cap?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const idleTimeoutMs = cap?.idleTimeoutMs ?? 0
  const signal = cap?.signal

  return new Promise<RunAndCaptureResult>((resolve, reject) => {
    let unlisten: (() => void) | null = null
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null
    let idleHandle: ReturnType<typeof setTimeout> | null = null
    let settled = false

    // Accumulated state — the latest assistant message wins. Most turns
    // emit a single `assistant` event with the full text. If the model
    // makes multiple assistant turns in one session (rare for our use
    // case), we keep the last non-empty one.
    let assembledText = ""
    let lastMessageId = ""
    // Tracks the last text handed to `cap.onPartial` so we only fire the
    // callback when the accumulated reply actually grows.
    let lastEmittedPartial = ""
    // Tracks text already surfaced via `cap.onEvent` text-delta events so we
    // emit only the newly-grown suffix.
    let streamedText = ""
    // Same suffix-diffing for `thinking` blocks surfaced as `thinking-delta`
    // events. Kept separate from `streamedText` and never added to
    // `assembledText`, so reasoning is observable live but never leaks into the
    // final `RunAndCaptureResult.text` (desktop output stays byte-identical).
    let streamedThinking = ""
    const surfaceAcc: SurfaceAccumulator = { surfaces: new Map(), order: [] }
    // Correlate `tool_use` blocks (id → name + input) so a later `tool_result`
    // block (which only carries `tool_use_id`) can be surfaced as a `tool-result`
    // event with its tool name + originating args. Powers the plugin SDK's
    // PostToolUse observation.
    const toolCallsById = new Map<string, { name: string; input: Record<string, unknown> }>()
    // Tool-use ids already handled by the review round-trip — so the later
    // observation pass doesn't fire `onToolResultReview` a second time.
    const reviewedToolUseIds = new Set<string>()
    // Tool-use ids whose tool is currently EXECUTING (seen as a `tool_use`, no
    // matching `tool_result` yet). While any tool runs, the provider stream is
    // legitimately silent — a 90s `bash` build is not a stall — so the idle
    // watchdog is paused for the duration and re-armed once the last tool
    // resolves. Without this, a tool slower than `idleTimeoutMs` (default 60s)
    // tripped the watchdog and interrupted the turn mid-tool.
    const inFlightToolIds = new Set<string>()
    // SDK-issued session id (sdk_session_id event) — surfaced on the result so
    // headless multi-turn drivers can persist it for resume.
    let capturedSdkSessionId = ""

    // ── Best-effort typed-event emitter (plugin Agent SDK `runStreamed`). ──
    const emitEvent = (event: CaptureStreamEvent) => {
      if (!cap?.onEvent) return
      try {
        cap.onEvent(event)
      } catch {
        /* swallow — streaming events are best-effort */
      }
    }

    // ── Headless permission responder. Answers `permission_request` events
    //     via `approveTool`, forwarding a rewritten `updatedInput`. Denies on
    //     responder error so a faulty gate can never hang the turn. ──
    const handlePermissionRequest = (req: PermissionRequestEvent) => {
      if (!cap?.onPermissionRequest) return
      void (async () => {
        let outcome: CapturePermissionDecision
        try {
          outcome = await cap.onPermissionRequest!(req)
        } catch {
          outcome = { decision: "deny", message: "permission responder failed" }
        }
        try {
          await approveTool(
            sessionId,
            req.requestId,
            outcome.decision,
            outcome.message,
            outcome.updatedInput
          )
        } catch {
          /* best-effort — the sidecar may have already moved on */
        }
        // Decision dispatched — the model can resume, so re-arm the idle
        // watchdog now instead of waiting for the next streamed event. This
        // closes the gap where a post-approval provider stall went uncaught
        // because `pauseIdle` left the watchdog disabled until something streamed.
        armIdle()
      })()
    }

    // ── Tool-result review responder (plugin SDK PostToolUse rewrite). Answers
    //     `tool_result_review` via `toolResultDecision`, correlating the call's
    //     name + input from the tool_use map. Fail-open: on responder error the
    //     output passes through unchanged. ──
    const handleToolResultReview = (req: ToolResultReviewEvent) => {
      if (req.toolUseId) reviewedToolUseIds.add(req.toolUseId)
      void (async () => {
        let updatedToolOutput: unknown
        if (cap?.onToolResultReview) {
          const call = req.toolUseId ? toolCallsById.get(req.toolUseId) : undefined
          try {
            const decision = await cap.onToolResultReview({
              toolName: req.toolName || call?.name || "",
              input: call?.input ?? {},
              result: req.result,
              isError: req.isError,
            })
            updatedToolOutput = decision ? decision.updatedToolOutput : undefined
          } catch {
            updatedToolOutput = undefined
          }
        }
        try {
          await toolResultDecision(sessionId, req.reviewId, updatedToolOutput)
        } catch {
          /* best-effort — the sidecar may have already moved on */
        }
        // Review dispatched — re-arm the idle watchdog (see handlePermissionRequest).
        armIdle()
      })()
    }

    const cleanup = () => {
      if (settled) return
      settled = true
      try {
        unlisten?.()
      } catch {
        /* idempotent unlisten — swallow secondary errors */
      }
      unlisten = null
      if (timeoutHandle != null) {
        clearTimeout(timeoutHandle)
        timeoutHandle = null
      }
      if (idleHandle != null) {
        clearTimeout(idleHandle)
        idleHandle = null
      }
      if (signal && abortHandler) {
        try {
          signal.removeEventListener("abort", abortHandler)
        } catch {
          /* DOM-shim differences — swallow */
        }
      }
    }

    const finishOk = (result: RunAndCaptureResult) => {
      cleanup()
      resolve(result)
    }

    const finishErr = (err: RunAndCaptureError) => {
      cleanup()
      reject(err)
    }

    // ── Idle (read) watchdog ─────────────────────────────────────────
    // (Re)start the idle timer on each streamed event; if the provider goes
    // silent for `idleTimeoutMs` mid-turn, interrupt and fail. Distinct from
    // the wall-clock timeout: a turn that streams steadily for minutes is fine,
    // but a stalled-open stream (no bytes, never closes) is caught here.
    const armIdle = () => {
      if (idleTimeoutMs <= 0 || settled) return
      if (idleHandle != null) clearTimeout(idleHandle)
      idleHandle = setTimeout(() => {
        void interruptSession(sessionId).catch(() => undefined)
        finishErr(
          new RunAndCaptureError(
            `session ${sessionId} stream idle for ${idleTimeoutMs}ms`,
            "session_error"
          )
        )
      }, idleTimeoutMs)
    }
    // Suspend the watchdog while we wait on the user (a permission prompt or a
    // tool-result review) — human think-time is not a provider stall.
    const pauseIdle = () => {
      if (idleHandle != null) {
        clearTimeout(idleHandle)
        idleHandle = null
      }
    }

    // ── Wire up abort handling first so a synchronous-abort signal
    //     short-circuits before we even subscribe.
    const abortHandler = () => {
      // Best-effort interrupt — the sidecar may already be done.
      void interruptSession(sessionId).catch(() => undefined)
      finishErr(new RunAndCaptureError("aborted by signal", "aborted"))
    }

    if (signal?.aborted) {
      // Don't subscribe at all if already aborted.
      reject(new RunAndCaptureError("aborted before start", "aborted"))
      return
    }

    if (signal) {
      signal.addEventListener("abort", abortHandler, { once: true })
    }

    // ── Timeout watchdog ─────────────────────────────────────────────
    if (timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        // Best-effort interrupt — the sidecar may still be running and
        // without this it continues indefinitely, leaving the session in a
        // stuck state that cascades into every subsequent turn (the renderer
        // reuses the same sessionId, the sidecar queues new messages behind
        // the still-running turn, and every future send times out too).
        void interruptSession(sessionId).catch(() => undefined)
        finishErr(
          new RunAndCaptureError(
            `session ${sessionId} did not end within ${timeoutMs}ms`,
            "session_error"
          )
        )
      }, timeoutMs)
    }

    // ── Subscribe BEFORE sendPrompt so we don't race against fast
    //     completions. Both onClaudeMessage and sendPrompt run via the
    //     same Tauri transport so ordering is enforced by the event
    //     channel itself, but subscribing first removes any window of
    //     ambiguity.
    const onEvent = (evt: ClaudeEvent): void => {
      // Filter to events for our session id. `usage_headers` and the
      // generic `log` / `ready` envelopes have no sessionId — skip them.
      if (evt.type === "ready" || evt.type === "log" || evt.type === "usage_headers") {
        return
      }
      if (evt.type === "sidecar_exited") {
        // Distinct from `session_error`: the sidecar PROCESS died, so the
        // in-process session is unrecoverable and the caller must respawn from
        // scratch. A plain `session_error` (timeout / idle / provider error)
        // leaves the multi-turn session alive, so the caller keeps it.
        finishErr(new RunAndCaptureError("sidecar exited mid-run", "sidecar_exited"))
        return
      }

      // Every remaining event has a sessionId on it. Discard anything
      // not for us — multiple in-flight runs share the same channel.
      const eventSessionId = (evt as { sessionId?: string }).sessionId
      if (eventSessionId !== sessionId) {
        return
      }

      if (evt.type === "permission_request") {
        // Awaiting the user — pause the idle watchdog so think-time on the
        // approval overlay isn't mistaken for a provider stall. It re-arms on
        // the next streamed event once the decision lets the model continue.
        pauseIdle()
        handlePermissionRequest(evt)
        return
      }

      if (evt.type === "tool_result_review") {
        pauseIdle()
        handleToolResultReview(evt)
        return
      }

      // Any other event for our session is provider progress → (re)arm the
      // idle watchdog. Arming on the first event (not before) means a slow
      // cold start is bounded by the wall-clock timeout, not this one.
      //
      // EXCEPT while a tool is in flight: the provider stream is legitimately
      // silent until the tool returns (a `dispatch_agent` subagent run can take
      // minutes), and the SDK re-includes the completed tool_use block in every
      // later assistant snapshot — so an unconditional re-arm here would restart
      // the idle timer off a stray repeat and trip the watchdog mid-tool. The
      // `tool_result` handler re-arms once `inFlightToolIds` drains.
      if (inFlightToolIds.size === 0) armIdle()

      if (evt.type === "sdk_session_id") {
        if (typeof evt.sdkSessionId === "string" && evt.sdkSessionId) {
          capturedSdkSessionId = evt.sdkSessionId
        }
        return
      }

      if (evt.type === "session_ended") {
        if (evt.error) {
          finishErr(new RunAndCaptureError(evt.error, "session_error"))
          return
        }
        // Prefer assembled text from the assistant event because it has
        // the model's exact output blocks. Fall back to the SDK result's
        // `.result` string if the assistant blocks were empty (rare).
        const text = assembledText.trim() || evt.result?.result?.trim() || ""
        if (!text && surfaceAcc.surfaces.size === 0 && toolCallsById.size === 0) {
          // Genuine no-content turn: no text, no A2UI surfaces, AND no tool
          // calls. Older contract: error out. Two outcomes are NOT errors:
          //   • surface-only turns (assistant called a2ui_create_surface but
          //     emitted no text) — `assistantReplyToSegments` emits the a2ui
          //     segments only;
          //   • tool-only turns (the model drove tools across one or more
          //     rounds and stopped without a closing summary) — the tool calls
          //     ARE the turn's content. Erroring there crashed multi-round
          //     tool sessions with "ended with no assistant text".
          finishErr(
            new RunAndCaptureError(
              `session ${sessionId} ended with no assistant text`,
              "no_assistant_text"
            )
          )
          return
        }
        const id = lastMessageId || evt.result?.uuid || crypto.randomUUID()
        const usage = evt.result ? (extractUsage(evt.result) ?? undefined) : undefined
        const resultSubtype = (evt.result as { subtype?: string } | undefined)?.subtype
        finishOk({
          text,
          messageId: id,
          a2uiSurfaces: Object.fromEntries(surfaceAcc.surfaces),
          a2uiSurfaceOrder: [...surfaceAcc.order],
          ...(usage ? { usage } : {}),
          ...(resultSubtype ? { resultSubtype } : {}),
          ...(capturedSdkSessionId ? { sdkSessionId: capturedSdkSessionId } : {}),
        })
        return
      }

      if (evt.type === "event") {
        const inner = evt.event as { type?: string; message?: unknown; uuid?: string }
        // A compaction boundary (auto threshold OR a manual `/compact` that
        // landed mid-turn). Surface it to the typed stream so the CLI marks it;
        // it carries no assistant content, so emit and move on.
        const compactEvent = compactBoundaryFromInner(inner)
        if (compactEvent) {
          if (cap?.onEvent) emitEvent(compactEvent)
          return
        }
        if (inner.type === "assistant") {
          // SDKAssistantMessage shape: message.content is BetaContentBlock[].
          // Extract every `text` block + every `tool_use` block —
          // text accumulates to the model's exact output; tool_use
          // blocks for the a2ui-bridge MCP server get applied to the
          // surface accumulator so the auto-mode loop sees the final
          // surfaces alongside the text.
          const message = inner.message as
            | {
                content?: Array<{
                  type?: string
                  text?: string
                  id?: string
                  name?: string
                  input?: Record<string, unknown>
                }>
              }
            | undefined
          if (Array.isArray(message?.content)) {
            const parts: string[] = []
            for (const block of message.content) {
              if (block?.type === "text" && typeof block.text === "string") {
                parts.push(block.text)
              } else if (
                block?.type === "tool_use" &&
                typeof block.name === "string" &&
                block.input &&
                typeof block.input === "object"
              ) {
                applyA2UIToolCall(surfaceAcc, block.name, block.input)
                // Dedup by tool_use id. Assistant snapshots are emitted on EVERY
                // streaming delta and each one repeats every completed tool_use
                // block, so without this a single tool call surfaces one
                // `tool-call` event per subsequent text delta — flooding the
                // plugin-SDK stream and (in the CLI) committing a fresh running
                // tool cell + an assistant cell on every delta. Emit only the
                // first time an id is seen; blocks without an id can't be
                // deduped, so they still emit (the AI SDK always supplies one).
                const blockId =
                  typeof block.id === "string" && block.id.length > 0 ? block.id : null
                const alreadyEmitted = blockId != null && toolCallsById.has(blockId)
                // Remember the call so a later tool_result can name itself.
                if (blockId) {
                  toolCallsById.set(blockId, { name: block.name, input: block.input })
                }
                // Surface each tool call ONCE to the plugin SDK stream (a2ui
                // bridge calls included — they are real tool invocations).
                if (!alreadyEmitted) {
                  // A new tool is about to execute; the provider stream stays
                  // silent until it returns. Track it and pause the idle watchdog
                  // so a slow tool (long build/test) isn't read as a stalled
                  // stream. Re-armed when its `tool_result` arrives. Only track
                  // calls we can correlate by id (the SDK always supplies one).
                  if (blockId) {
                    inFlightToolIds.add(blockId)
                    pauseIdle()
                  }
                  emitEvent({
                    type: "tool-call",
                    toolName: block.name,
                    input: block.input,
                    ...(blockId ? { id: blockId } : {}),
                  })
                }
              } else if (
                block?.type === "thinking" &&
                typeof (block as { thinking?: unknown }).thinking === "string"
              ) {
                // Reasoning block — surface the newly-grown suffix as a
                // `thinking-delta` so a consumer (the CLI TUI) can render the
                // model's reasoning live. Deliberately NOT pushed into `parts`:
                // thinking never enters `assembledText` / the final result text.
                const full = (block as { thinking: string }).thinking
                if (cap?.onEvent) {
                  const delta = full.startsWith(streamedThinking)
                    ? full.slice(streamedThinking.length)
                    : full
                  if (delta.length > 0) emitEvent({ type: "thinking-delta", delta })
                  streamedThinking = full
                }
              }
            }
            const text = parts.join("")
            if (text.length > 0) {
              assembledText = text
              // Emit the newly-grown suffix as a text-delta. Most turns send
              // the full text each event, so diff against what we've streamed.
              if (cap?.onEvent) {
                const delta = text.startsWith(streamedText) ? text.slice(streamedText.length) : text
                if (delta.length > 0) emitEvent({ type: "text-delta", delta })
                streamedText = text
              }
              if (typeof inner.uuid === "string" && inner.uuid.length > 0) {
                lastMessageId = inner.uuid
              }
              // Fire the incremental-output callback when the accumulated
              // text actually grew. Best-effort: a throwing / rejecting
              // callback must never break the capture loop.
              if (cap?.onPartial && text !== lastEmittedPartial) {
                lastEmittedPartial = text
                try {
                  const r = cap.onPartial(text)
                  if (r && typeof (r as Promise<void>).catch === "function") {
                    void (r as Promise<void>).catch(() => undefined)
                  }
                } catch {
                  /* swallow — partial preview is best-effort */
                }
              }
            } else if (typeof inner.uuid === "string" && inner.uuid.length > 0) {
              // tool-only assistant turn (no text) — still remember the
              // message id so session_ended can attribute correctly.
              lastMessageId = inner.uuid
            }
            // Mid-run usage snapshot: the assistant message carries its own
            // per-call `usage`. Emit it as a `partial` usage event so live
            // telemetry (subagent runtime store, TUI footer) can show a running
            // token figure before the authoritative end-of-turn usage lands.
            if (cap?.onEvent) {
              // extractUsage reads `.usage` / `.message.usage` off any SDK
              // message shape; the assistant message carries per-call usage.
              const partialUsage = extractUsage(inner.message as never)
              if (partialUsage) emitEvent({ type: "usage", usage: partialUsage, partial: true })
            }
          }
        } else if (inner.type === "user") {
          // Tool results arrive as a synthetic `user` message carrying
          // `tool_result` blocks. Surface each as a `tool-result` event
          // (plugin SDK PostToolUse observation). Tool name + args are
          // correlated from the originating `tool_use` block when known.
          const userMessage = inner.message as
            | {
                content?: Array<{
                  type?: string
                  tool_use_id?: string
                  content?: unknown
                  is_error?: boolean
                }>
              }
            | undefined
          if (Array.isArray(userMessage?.content)) {
            for (const block of userMessage.content) {
              if (block?.type === "tool_result") {
                const call =
                  typeof block.tool_use_id === "string"
                    ? toolCallsById.get(block.tool_use_id)
                    : undefined
                emitEvent({
                  type: "tool-result",
                  toolName: call?.name ?? "",
                  ...(call?.input ? { input: call.input } : {}),
                  ...(typeof block.tool_use_id === "string" ? { id: block.tool_use_id } : {}),
                  result: block.content,
                  isError: Boolean(block.is_error),
                })
                // Tool finished — drop it from the in-flight set. Re-arm the idle
                // watchdog only when nothing is executing; if other parallel
                // tools are still running, keep it paused.
                if (typeof block.tool_use_id === "string") {
                  inFlightToolIds.delete(block.tool_use_id)
                }
                if (inFlightToolIds.size === 0) armIdle()
                else pauseIdle()
                // PostToolUse observation: fire the responder for tool results
                // the review round-trip did NOT already handle (so the hook is
                // called once). The returned `updatedToolOutput` is ignored here
                // — the model has already seen this output.
                const reviewed =
                  typeof block.tool_use_id === "string" && reviewedToolUseIds.has(block.tool_use_id)
                if (cap?.onToolResultReview && !reviewed) {
                  try {
                    void Promise.resolve(
                      cap.onToolResultReview({
                        toolName: call?.name ?? "",
                        input: call?.input ?? {},
                        result: block.content,
                        isError: Boolean(block.is_error),
                      })
                    ).catch(() => undefined)
                  } catch {
                    /* observation is best-effort */
                  }
                }
              }
            }
          }
        } else if (inner.type === "result") {
          // End-of-turn SDK result message. Carries token/cost usage for the
          // turn. The native Anthropic sidecar does NOT attach this to its
          // `session_ended` envelope, so surface it from the stream here so the
          // CLI footer can render live usage. Best-effort — a missing/empty
          // usage block simply emits nothing.
          const usage = extractUsage(inner as unknown as Parameters<typeof extractUsage>[0])
          if (usage && cap?.onEvent) emitEvent({ type: "usage", usage })
        }
      }
    }

    onClaudeMessage(onEvent)
      .then((un) => {
        if (settled) {
          // Aborted (or timed out) before we got the unlistener back —
          // detach immediately so we don't leak.
          try {
            un()
          } catch {
            /* swallow */
          }
          return
        }
        unlisten = un
        // Now fire the actual send. If it throws synchronously the
        // catch below cleans up; if it rejects async we still clean up
        // via the same path.
        sendPrompt(sessionId, prompt, options).catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err)
          finishErr(new RunAndCaptureError(`sendPrompt failed: ${message}`, "send_failed"))
        })
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        finishErr(
          new RunAndCaptureError(`failed to subscribe to claude events: ${message}`, "send_failed")
        )
      })
  })
}
