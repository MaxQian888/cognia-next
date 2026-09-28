import type { HostSession } from "../sessions/types.ts"
export interface PermissionResponseOptions {
  updatedInput?: Record<string, unknown>
  input?: Record<string, unknown>
  message?: string
  suggestions?: unknown
  interrupt?: boolean
  suppressAlwaysAllowRule?: boolean
  rich?: boolean
}

/**
 * Map a renderer `permission_response` to the SDK `PermissionResult` shape.
 *
 * Pure so the allow/deny mapping is unit-testable. The crux: an `allow` MUST
 * carry an `updatedInput` *record*. The renderer omits `updatedInput` whenever
 * the user approves a call unmodified, so we fall back to the ORIGINAL tool
 * input. Resolving with `updatedInput: undefined` fails the Agent-SDK
 * subprocess's zod schema (which requires a record), surfacing to the user as
 * `Tool permission request failed: ZodError`. When neither an edited input nor
 * a captured original is present, fall back to an empty record `{}` (which the
 * zod schema accepts) so the guarantee lives in THIS function, not solely in
 * the caller.
 *
 * `allow_always` used to be treated as a plain allow, with the "stop asking"
 * half enforced only parent-side. That left the user's intent stranded: the SDK
 * has `updatedPermissions` for exactly this, and without it the CLI's own rule
 * store never learned the decision — so "always allow" held for the renderer's
 * session and nowhere else. It now returns the suggestions the SDK offered
 * alongside the request.
 *
 * Suggestions targeting `localSettings` are dropped. Those write to the user's
 * on-disk settings file, and a click in a chat approval dialog is consent for
 * this session, not consent to edit their configuration.
 *
 * `rich` gates all of it. The legacy `claude_send` queue is still production
 * (ADR-0090 constraint 6: flag-off paths keep byte-identical behaviour), and
 * this is the same function on both rails — so the extra fields appear only for
 * a session carrying a frozen execution spec.
 *
 * @param {"allow"|"allow_always"|"deny"} decision
 * @param {{
 *   updatedInput?: Record<string, unknown>,
 *   message?: string,
 *   input?: Record<string, unknown>,
 *   suggestions?: Array<Record<string, unknown>>,
 *   interrupt?: boolean,
 * }} opts
 */
interface AllowResult {
  behavior: "allow"
  updatedInput: Record<string, unknown>
  updatedPermissions?: Record<string, unknown>[]
  decisionClassification?: string
  interrupt?: never
}
interface DenyResult {
  behavior: "deny"
  message: string
  interrupt?: boolean
  decisionClassification?: string
  updatedPermissions?: never
  updatedInput?: never
}
export function buildPermissionResult(
  decision: "deny",
  options?: PermissionResponseOptions
): DenyResult
export function buildPermissionResult(
  decision: "allow" | "allow_always",
  options?: PermissionResponseOptions
): AllowResult
export function buildPermissionResult(
  decision: string,
  options?: PermissionResponseOptions
): AllowResult | DenyResult
export function buildPermissionResult(
  decision: string,
  {
    updatedInput,
    message,
    input,
    suggestions,
    interrupt,
    suppressAlwaysAllowRule = false,
    rich = false,
  }: PermissionResponseOptions = {}
): AllowResult | DenyResult {
  if (decision === "deny") {
    return {
      behavior: "deny",
      message: message ?? "denied by user",
      ...(rich && interrupt ? { interrupt: true } : {}),
      ...(rich ? { decisionClassification: "user_reject" } : {}),
    }
  }

  const always = decision === "allow_always" && !suppressAlwaysAllowRule
  const durable = rich && always ? persistableSuggestions(suggestions) : []

  return {
    behavior: "allow",
    updatedInput: updatedInput ?? input ?? {},
    ...(durable.length > 0 ? { updatedPermissions: durable } : {}),
    ...(rich ? { decisionClassification: always ? "user_permanent" : "user_temporary" } : {}),
  }
}

/**
 * The suggestions an "always allow" may act on.
 *
 * `localSettings` is excluded on purpose — see {@link buildPermissionResult}.
 * Anything with an unrecognised shape is dropped rather than forwarded: these
 * become permission RULES, so a malformed entry is the one case where guessing
 * is worse than doing nothing.
 */
export function persistableSuggestions(suggestions: unknown): Record<string, unknown>[] {
  if (!Array.isArray(suggestions)) return []
  return suggestions.filter(
    (s: unknown): s is Record<string, unknown> =>
      s !== null &&
      typeof s === "object" &&
      "type" in s &&
      typeof s.type === "string" &&
      "destination" in s &&
      typeof s.destination === "string" &&
      s.destination !== "localSettings"
  )
}

/**
 * Resolve a pending Router + Fusion reservation (ADR-0188). The renderer — the
 * ledger's only writer — answered a `call_reserve_request`. Unknown sessions or
 * request ids are ignored: the waiter already timed out into a bypass or the
 * session closed.
 */
export function routeCallReserveDecision(
  sessionsMap: Map<string, HostSession>,
  msg: { sessionId?: string; [key: string]: unknown } | null
) {
  if (!msg?.sessionId) return false
  const s = sessionsMap.get(msg.sessionId)
  if (!s || typeof s.resolveCallReserve !== "function") return false
  return s.resolveCallReserve(msg) === true
}
