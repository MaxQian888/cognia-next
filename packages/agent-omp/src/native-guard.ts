/**
 * Pure OMP 18.6.1 extension factory. The host owns process isolation, integrity
 * verification, policy, and provider egress; this module cannot attest to them.
 *
 * Upstream tool_call fails closed, but user_bash/user_python and
 * before_provider_request swallow thrown handlers. Therefore direct execution
 * always returns a replacement and provider gating is synchronous. A provider
 * failure MUST synchronously kill/revoke egress through the host's terminate.
 * Other extensions must not run after this guard or bypass it through exec().
 */
export interface OmpGuardAgentIdentity {
  kind: "main" | "sub"
  id: string
  name: string
  depth: number
  parentId?: string
}
export interface OmpGuardContext {
  agent: OmpGuardAgentIdentity
  cwd?: string
  model?: { id: string; provider: string }
  abort(): void
  ui: { setStatus(key: string, text: string): void }
  signal?: AbortSignal
}
export interface OmpGuardEvent {
  type: string
  [key: string]: unknown
}
export type OmpGuardHandler = (event: OmpGuardEvent, context: OmpGuardContext) => unknown
/** Structural slice only; bootstrap must adapt this to the upstream ExtensionAPI. */
export interface OmpGuardExtensionApi {
  on(event: string, handler: OmpGuardHandler): void
}
export interface OmpGuardRequest {
  kind: "tool" | "bash" | "python"
  toolName: string
  toolCallId?: string
  input: Record<string, unknown>
}
export interface OmpGuardDecision {
  allow: boolean
  reason?: string
}
export interface OmpDirectResult {
  output: string
  exitCode: number | undefined
  cancelled: boolean
  truncated: boolean
  totalLines: number
  totalBytes: number
  outputLines: number
  outputBytes: number
  displayOutputs?: unknown[]
  stdinRequested?: boolean
  [key: string]: unknown
}
export interface OmpGuardOptions {
  nonce: string
  /** Host assertions, not package-generated runtime certification. */
  enforcement: {
    isolatedExtensions: boolean
    providerEgressControlled: boolean
    rebindingVerified: boolean
  }
  authorize(
    request: OmpGuardRequest,
    context: OmpGuardContext,
    signal: AbortSignal
  ): Promise<OmpGuardDecision>
  /** Scrub all provider-bound result fields (including images/details), not just text. */
  redactResult(
    result: Record<string, unknown>,
    context: OmpGuardContext,
    signal: AbortSignal
  ): Promise<Record<string, unknown>>
  /** Synchronous, total transformation of the final provider payload. Async is rejected. */
  transformOutbound(payload: unknown, context: OmpGuardContext): unknown
  /** Must synchronously terminate the process or revoke its network egress. */
  terminate(reason: string): void
  /** Absent means direct shortcuts are unavailable. Must honor signal cancellation. */
  executeDirect?(
    request: OmpGuardRequest,
    context: OmpGuardContext,
    signal: AbortSignal
  ): Promise<OmpDirectResult>
  /** Per callback deadline, 1..5000ms. Host must retain upstream's >=30s hook timeout. */
  timeoutMs?: number
}
const DENIED = "OMP operation blocked by host policy"
const SANITIZER_FAILED = "OMP tool output withheld by host policy"
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
const isPromiseLike = (value: unknown): value is PromiseLike<unknown> =>
  (typeof value === "object" || typeof value === "function") &&
  value !== null &&
  "then" in value &&
  typeof value.then === "function"

export function createOmpNativeGuard(
  options: OmpGuardOptions
): (api: OmpGuardExtensionApi) => void {
  if (!options.nonce || typeof options.nonce !== "string")
    throw new Error("OMP guard nonce is required")
  for (const callback of ["authorize", "redactResult", "transformOutbound", "terminate"] as const) {
    if (typeof options[callback] !== "function")
      throw new Error(`OMP guard ${callback} callback is required`)
  }
  if (
    !options.enforcement?.isolatedExtensions ||
    !options.enforcement.providerEgressControlled ||
    !options.enforcement.rebindingVerified
  )
    throw new Error("OMP guard requires verified host enforcement controls")
  const timeoutMs = options.timeoutMs ?? 5000
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000)
    throw new Error("OMP guard timeout must be between 1 and 5000ms")
  return (api) => {
    // Each rebound extension instance owns its own state; no cross-session grants.
    let terminated = false
    const terminate = (ctx: OmpGuardContext) => {
      terminated = true
      try {
        options.terminate(DENIED)
      } catch {
        /* Do not let OMP restore the original payload. */
      }
      try {
        ctx.abort()
      } catch {
        /* The host egress barrier remains authoritative. */
      }
    }
    async function bounded<T>(
      ctx: OmpGuardContext,
      fn: (signal: AbortSignal) => Promise<T>
    ): Promise<T> {
      if (terminated || ctx.signal?.aborted) throw new Error(DENIED)
      const controller = new AbortController()
      let timer: ReturnType<typeof setTimeout> | undefined
      let rejectAbort: (() => void) | undefined
      const interrupted = new Promise<never>((_, reject) => {
        rejectAbort = () => {
          controller.abort()
          reject(new Error(DENIED))
        }
        timer = setTimeout(rejectAbort, timeoutMs)
        ctx.signal?.addEventListener("abort", rejectAbort, { once: true })
      })
      try {
        return await Promise.race([
          Promise.resolve().then(() => fn(controller.signal)),
          interrupted,
        ])
      } finally {
        if (timer !== undefined) clearTimeout(timer)
        if (rejectAbort) ctx.signal?.removeEventListener("abort", rejectAbort)
        controller.abort()
      }
    }
    const announceReady: OmpGuardHandler = (_event, ctx) => {
      if (!terminated) ctx.ui.setStatus("cognia-omp-ready", options.nonce)
    }
    // OMP reuses the runner on session switches and branches; session_start
    // does not fire again for those successful transitions.
    api.on("session_start", announceReady)
    api.on("session_switch", announceReady)
    api.on("session_branch", announceReady)
    api.on("tool_call", async (event, ctx) => {
      if (typeof event.toolName !== "string" || !isRecord(event.input))
        return { block: true, reason: DENIED }
      try {
        const request: OmpGuardRequest = {
          kind: "tool",
          toolName: event.toolName,
          toolCallId: typeof event.toolCallId === "string" ? event.toolCallId : undefined,
          input: event.input,
        }
        const decision = await bounded(ctx, (signal) => options.authorize(request, ctx, signal))
        return decision?.allow === true ? { block: false } : { block: true, reason: DENIED }
      } catch {
        return { block: true, reason: DENIED }
      }
    })
    api.on("tool_result", async (event, ctx) => {
      try {
        const result = await bounded(ctx, (signal) =>
          options.redactResult(
            { content: event.content, details: event.details, isError: event.isError },
            ctx,
            signal
          )
        )
        if (
          !isRecord(result) ||
          !Array.isArray(result.content) ||
          !result.content.every(isContentBlock)
        )
          throw new Error(SANITIZER_FAILED)
        // A details replacement must be present: upstream otherwise falls back to original details.
        return {
          content: result.content,
          details: result.details ?? {},
          isError: event.isError === true || result.isError === true,
        }
      } catch {
        return { content: [{ type: "text", text: SANITIZER_FAILED }], details: {}, isError: true }
      }
    })
    const direct = async (event: OmpGuardEvent, ctx: OmpGuardContext, kind: "bash" | "python") => {
      try {
        if (!options.executeDirect) return { result: deniedDirect(kind) }
        const value = kind === "bash" ? event.command : event.code
        if (typeof value !== "string") return { result: deniedDirect(kind) }
        const request: OmpGuardRequest = {
          kind,
          toolName: kind,
          input: {
            [kind === "bash" ? "command" : "code"]: value,
            cwd: event.cwd,
            excludeFromContext: event.excludeFromContext === true,
          },
        }
        const decision = await bounded(ctx, (signal) => options.authorize(request, ctx, signal))
        if (decision?.allow !== true) return { result: deniedDirect(kind) }
        const result = await bounded(ctx, (signal) => options.executeDirect!(request, ctx, signal))
        const clean = await bounded(ctx, (signal) => options.redactResult(result, ctx, signal))
        if (!isDirectResult(clean, kind)) return { result: deniedDirect(kind) }
        return { result: clean }
      } catch {
        return { result: deniedDirect(kind) }
      }
    }
    api.on("user_bash", (event, ctx) => direct(event, ctx, "bash"))
    api.on("user_python", (event, ctx) => direct(event, ctx, "python"))
    api.on("before_provider_request", (event, ctx) => {
      try {
        if (terminated || ctx.signal?.aborted) throw new Error(DENIED)
        const clean = options.transformOutbound(event.payload, ctx)
        if (isPromiseLike(clean)) {
          // Consume rejection so a broken bootstrap does not cause an unhandled rejection.
          void Promise.resolve(clean).catch(() => {})
          throw new Error(DENIED)
        }
        if (!isRecord(clean)) throw new Error(DENIED)
        return clean
      } catch {
        terminate(ctx)
        // Never return undefined: upstream interprets it as "keep original payload".
        return {}
      }
    })
  }
}
function isContentBlock(value: unknown): boolean {
  return (
    isRecord(value) &&
    ((value.type === "text" && typeof value.text === "string") ||
      (value.type === "image" &&
        typeof value.data === "string" &&
        typeof value.mimeType === "string"))
  )
}
function isDirectResult(value: unknown, kind: "bash" | "python"): value is OmpDirectResult {
  if (
    !isRecord(value) ||
    typeof value.output !== "string" ||
    typeof value.cancelled !== "boolean" ||
    typeof value.truncated !== "boolean"
  )
    return false
  if (
    value.exitCode !== undefined &&
    (typeof value.exitCode !== "number" || !Number.isInteger(value.exitCode))
  )
    return false
  for (const field of ["totalLines", "totalBytes", "outputLines", "outputBytes"])
    if (typeof value[field] !== "number" || !Number.isFinite(value[field]) || value[field] < 0)
      return false
  return (
    kind === "bash" ||
    (Array.isArray(value.displayOutputs) && typeof value.stdinRequested === "boolean")
  )
}
function deniedDirect(kind: "bash" | "python"): OmpDirectResult {
  const bytes = new TextEncoder().encode(DENIED).byteLength
  return {
    output: DENIED,
    exitCode: 1,
    cancelled: false,
    truncated: false,
    totalLines: 1,
    totalBytes: bytes,
    outputLines: 1,
    outputBytes: bytes,
    ...(kind === "python" ? { displayOutputs: [], stdinRequested: false } : {}),
  }
}
