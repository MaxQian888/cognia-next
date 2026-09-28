export interface SmokeState {
  sawAssistantText: boolean
  sawError: boolean
  errorReason?: string | null
  timedOut?: boolean
  timeoutMs?: number
}
interface SmokeFrame {
  [key: string]: unknown
  type?: string
  event?: {
    type?: string
    message?: { content?: { type?: string; text?: unknown }[] }
    is_error?: boolean
    subtype?: string
  }
  error?: string
  message?: string
}

// ---- Main read loop -------------------------------------------------------

/** The credential variables the SDK accepts. One of them must be set. */
export const SMOKE_CREDENTIAL_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
]

export const SMOKE_DEFAULT_TIMEOUT_MS = 60_000

/** Names of the missing credential variables, or null when one is present. */
export function smokeCredentialGap(env: NodeJS.ProcessEnv = process.env) {
  const present = SMOKE_CREDENTIAL_ENV.some(
    (name) => typeof env[name] === "string" && env[name] !== ""
  )
  return present ? null : SMOKE_CREDENTIAL_ENV
}

/**
 * Fold one outbound frame into the smoke state. Assistant text is any text
 * block on an `assistant` SDK message. An error is an error frame, a session
 * that ended with an error, or an SDK result flagged `is_error`.
 */
export function smokeObserveFrame(state: SmokeState, payload: SmokeFrame | null | undefined) {
  if (!payload || typeof payload !== "object") return state
  if (payload.type === "event") {
    const event = payload.event
    if (event?.type === "assistant") {
      const blocks = event.message?.content ?? []
      if (
        blocks.some(
          (block) =>
            block?.type === "text" && typeof block.text === "string" && block.text.length > 0
        )
      ) {
        state.sawAssistantText = true
      }
    } else if (event?.type === "result" && event.is_error) {
      state.sawError = true
      state.errorReason ??= `result ${event.subtype ?? "error"}`
    }
  } else if (payload.type === "error") {
    state.sawError = true
    state.errorReason ??= payload.error ?? payload.message ?? "error frame"
  } else if (payload.type === "session_ended" && payload.error) {
    state.sawError = true
    state.errorReason ??= String(payload.error)
  }
  return state
}

/**
 * Exit code for a smoke run. `0` only when assistant text arrived and no
 * error did. `1` for an error frame, `3` for the wall-clock deadline, and
 * `1` again for a session that ended silently with nothing to show.
 */
export function smokeOutcome(state: SmokeState) {
  if (state.sawError) return { code: 1, reason: `error frame: ${state.errorReason ?? "unknown"}` }
  if (state.timedOut) return { code: 3, reason: `no assistant text within ${state.timeoutMs}ms` }
  if (state.sawAssistantText) return { code: 0, reason: "assistant text received" }
  return { code: 1, reason: "session ended without assistant text or an error frame" }
}
