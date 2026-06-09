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

import { sendPrompt, interruptSession, onClaudeMessage, approveTool } from "./ipc"
import type {
  ApprovalDecision,
  ClaudeEvent,
  PermissionRequestEvent,
  SendContent,
  SendOptions,
} from "./types"
import type { A2UISegmentContent } from "@/types/connectors/segment"
import { extractUsage, type UsageInfo } from "./adapter"
import { runChatMiddlewareChain } from "@/lib/claude/chat-middleware/runner"
import { listActiveChatMiddlewares } from "@/lib/claude/chat-middleware/registry"
import { isChatMiddlewareExecutionEnabled } from "@/lib/claude/chat-middleware/feature-flag"
import type { ChatMiddlewareRequest } from "@/types/plugin/plugin-chat-middleware"
import type { PluginMessage } from "@/types/plugin/plugin"

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
    readonly code: "session_error" | "no_assistant_text" | "aborted" | "send_failed"
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
  | { type: "tool-call"; toolName: string; input: Record<string, unknown> }

/** Decision returned by a {@link RunAndCaptureOptions.onPermissionRequest} responder. */
export interface CapturePermissionDecision {
  decision: ApprovalDecision
  message?: string
  updatedInput?: unknown
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
  const signal = cap?.signal

  return new Promise<RunAndCaptureResult>((resolve, reject) => {
    let unlisten: (() => void) | null = null
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null
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
    const surfaceAcc: SurfaceAccumulator = { surfaces: new Map(), order: [] }

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
        finishErr(new RunAndCaptureError("sidecar exited mid-run", "session_error"))
        return
      }

      // Every remaining event has a sessionId on it. Discard anything
      // not for us — multiple in-flight runs share the same channel.
      const eventSessionId = (evt as { sessionId?: string }).sessionId
      if (eventSessionId !== sessionId) {
        return
      }

      if (evt.type === "permission_request") {
        handlePermissionRequest(evt)
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
        if (!text && surfaceAcc.surfaces.size === 0) {
          // Genuine no-content turn: no text AND no A2UI surfaces. Older
          // contract: error out. Surface-only turns (assistant called
          // a2ui_create_surface but emitted no text) are a legitimate
          // outcome now — `assistantReplyToSegments` will handle the
          // text-less case by emitting only the a2ui segments.
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
        finishOk({
          text,
          messageId: id,
          a2uiSurfaces: Object.fromEntries(surfaceAcc.surfaces),
          a2uiSurfaceOrder: [...surfaceAcc.order],
          ...(usage ? { usage } : {}),
        })
        return
      }

      if (evt.type === "event") {
        const inner = evt.event as { type?: string; message?: unknown; uuid?: string }
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
                // Surface every tool call to the plugin SDK stream (a2ui
                // bridge calls included — they are real tool invocations).
                emitEvent({
                  type: "tool-call",
                  toolName: block.name,
                  input: block.input,
                })
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
          }
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
