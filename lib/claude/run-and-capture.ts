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

import { sendPrompt, interruptSession, onClaudeMessage } from "./ipc"
import type { ClaudeEvent, SendContent, SendOptions } from "./types"

export interface RunAndCaptureResult {
  /** The accumulated assistant reply text (concatenated text blocks). */
  text: string
  /**
   * The SDK assistant message uuid we captured the text from. Used by the
   * caller as a stable idempotency key so retries don't double-send.
   */
  messageId: string
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
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000

/**
 * Drive a Claude turn and resolve with the assistant's captured text
 * once the session ends. See module-level docs for behavioural notes.
 */
export async function runAndCaptureAssistantReply(
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

      if (evt.type === "session_ended") {
        if (evt.error) {
          finishErr(new RunAndCaptureError(evt.error, "session_error"))
          return
        }
        // Prefer assembled text from the assistant event because it has
        // the model's exact output blocks. Fall back to the SDK result's
        // `.result` string if the assistant blocks were empty (rare).
        const text = assembledText.trim() || evt.result?.result?.trim() || ""
        if (!text) {
          finishErr(
            new RunAndCaptureError(
              `session ${sessionId} ended with no assistant text`,
              "no_assistant_text"
            )
          )
          return
        }
        const id = lastMessageId || evt.result?.uuid || crypto.randomUUID()
        finishOk({ text, messageId: id })
        return
      }

      if (evt.type === "event") {
        const inner = evt.event as { type?: string; message?: unknown; uuid?: string }
        if (inner.type === "assistant") {
          // SDKAssistantMessage shape: message.content is BetaContentBlock[].
          // Extract every `text` block and join with empty string —
          // matches the way the SDK surfaces split blocks (preamble,
          // tool-use, follow-up text, etc.).
          const message = inner.message as
            | { content?: Array<{ type?: string; text?: string }> }
            | undefined
          if (Array.isArray(message?.content)) {
            const parts: string[] = []
            for (const block of message.content) {
              if (block?.type === "text" && typeof block.text === "string") {
                parts.push(block.text)
              }
            }
            const text = parts.join("")
            if (text.length > 0) {
              assembledText = text
              if (typeof inner.uuid === "string" && inner.uuid.length > 0) {
                lastMessageId = inner.uuid
              }
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
