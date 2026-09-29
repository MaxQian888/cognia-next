/**
 * Cross-object request validation the JSON Schema cannot express (DESIGN §25.6),
 * idempotency hashing (§15.1) and the chat-compat strict subset (§15, API-04).
 *
 * Parsing a request successfully is not the same as the request being allowed:
 * a mode outside `allowed_modes`, a delegate without an authorized workspace,
 * or a budget above what the account permits are refused here with the
 * precise error code, before a run exists.
 */

import { z } from "zod"

import {
  ChatRequestSchema,
  RunRequestSchema,
  type ChatRequest,
  type ExecutionMode,
  type RunRequest,
} from "../contracts/schemas"
import { usdToMicrousd, type Microusd } from "../money/microusd"
import { canonicalJson, sha256Hex } from "../util/sha256"

export type ApiErrorCode =
  | "SCHEMA_INVALID"
  | "UNSUPPORTED_PARAMETER"
  | "MODE_NOT_ALLOWED"
  | "WORKSPACE_REQUIRED"
  | "ACCEPTANCE_PROFILE_REQUIRED"
  | "PROFILE_BELOW_MINIMUM"
  | "BUDGET_MODE_NOT_ENABLED"
  | "BUDGET_ABOVE_LIMIT"
  | "DEGRADE_NOT_PERMITTED"
  | "DELEGATE_REQUIRES_RUN_API"

export interface ApiIssue {
  status: 409 | 422
  code: ApiErrorCode
  message: string
  details: Record<string, unknown>
}

export interface RunRequestPolicy {
  /** Whether the account enabled tracked budgets (ADR-0188 D6 default: yes). */
  trackedBudgetEnabled: boolean
  /** Upper bound per run for the requested modes (per-action run caps). */
  maxRunCapMicrousd: (mode: ExecutionMode | "auto") => Microusd
  workspaceAuthorized: (workspaceId: string) => boolean
  acceptanceProfileExists: (profileId: string) => boolean
  /** Lowest profile name the account permits (profiles only ever tighten). */
  minimumProfile: "economy" | "balanced" | "quality"
  degradeAllowed: boolean
}

const PROFILE_RANK = { economy: 0, balanced: 1, quality: 2 } as const

function issue(
  code: ApiErrorCode,
  message: string,
  details: Record<string, unknown> = {},
  status: 409 | 422 = 422
): ApiIssue {
  return { status, code, message, details }
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; issues: ApiIssue[] }

function unknownKeys(error: z.ZodError): string[] {
  return error.issues.flatMap((i) =>
    i.code === "unrecognized_keys" ? i.keys.map((k) => [...i.path, k].join(".")) : []
  )
}

export function parseRunRequest(body: unknown, policy: RunRequestPolicy): Parsed<RunRequest> {
  const parsed = RunRequestSchema.safeParse(body)
  if (!parsed.success) {
    const extra = unknownKeys(parsed.error)
    return {
      ok: false,
      issues: [
        extra.length > 0
          ? issue("UNSUPPORTED_PARAMETER", `unsupported fields: ${extra.join(", ")}`, {
              fields: extra,
            })
          : issue("SCHEMA_INVALID", "the request does not match RunRequest", {
              paths: parsed.error.issues.map((i) => i.path.join(".")),
            }),
      ],
    }
  }
  const request = parsed.data
  const issues: ApiIssue[] = []
  if (request.mode !== "auto" && !request.allowed_modes.includes(request.mode)) {
    issues.push(
      issue("MODE_NOT_ALLOWED", `mode ${request.mode} is not in allowed_modes`, {
        mode: request.mode,
      })
    )
  }
  const delegatePossible =
    request.mode === "delegate" ||
    (request.mode === "auto" && request.allowed_modes.includes("delegate"))
  if (request.mode === "delegate") {
    if (!request.workspace_id || !policy.workspaceAuthorized(request.workspace_id)) {
      issues.push(issue("WORKSPACE_REQUIRED", "delegate needs an authorized workspace_id"))
    }
    if (
      !request.acceptance_profile_id ||
      !policy.acceptanceProfileExists(request.acceptance_profile_id)
    ) {
      issues.push(
        issue("ACCEPTANCE_PROFILE_REQUIRED", "delegate needs an existing acceptance_profile_id")
      )
    }
  } else if (
    delegatePossible &&
    request.workspace_id &&
    !policy.workspaceAuthorized(request.workspace_id)
  ) {
    issues.push(issue("WORKSPACE_REQUIRED", "workspace_id is not authorized for this key"))
  }
  if (PROFILE_RANK[request.profile] < PROFILE_RANK[policy.minimumProfile]) {
    issues.push(
      issue(
        "PROFILE_BELOW_MINIMUM",
        `profile ${request.profile} is below the account minimum ${policy.minimumProfile}`
      )
    )
  }
  if (request.budget.mode === "tracked" && !policy.trackedBudgetEnabled) {
    issues.push(
      issue("BUDGET_MODE_NOT_ENABLED", "tracked budgets are not enabled for this account")
    )
  }
  const cap = usdToMicrousd(request.budget.max_cost_usd)
  const limit = policy.maxRunCapMicrousd(request.mode)
  if (cap > limit)
    issues.push(
      issue("BUDGET_ABOVE_LIMIT", "max_cost_usd exceeds the run cap", { limit_microusd: limit })
    )
  if (request.allow_degraded && !policy.degradeAllowed) {
    issues.push(issue("DEGRADE_NOT_PERMITTED", "allow_degraded is not permitted for this account"))
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, value: request }
}

// ── Cognia's extension of a Run API request ────────────────────────────────────

/**
 * The top-level field a Run API body carries Cognia-only options in.
 *
 * The contract (`contracts/spec/*`) is vendored and its `RunRequest` is strict
 * (`additionalProperties: false`), so an option this app adds cannot live
 * inside it without forking the spec every other implementation reads. It
 * travels BESIDE the contract object instead — the same shape the config
 * uses, where Cognia's `ActionExtension` sits beside the contract's
 * `ActionConfig` — under the OpenAPI vendor-extension prefix, so no future
 * contract field can collide with it. The contract part is still parsed by
 * the strict mirror, exactly as before; a body without this field is exactly
 * a contract request.
 */
export const RUN_REQUEST_EXTENSION_FIELD = "x-cognia" as const

/**
 * The extension's own schema, strict like the contract's: an option this
 * build does not know is refused, never ignored.
 *
 * `delegate_delivery` — how a delegate run delivers its verified change.
 * `patch_only` (the default) hands back a patch; `workspace_updated` writes it
 * into the workspace, but only after a person approves exactly that patch on
 * exactly that base (DEL-04). Only a request that may run delegate may ask.
 */
export const RunRequestExtensionSchema = z.strictObject({
  delegate_delivery: z.enum(["patch_only", "workspace_updated"]).optional(),
})
export type RunRequestExtension = z.infer<typeof RunRequestExtensionSchema>

export interface ParsedRunApiRequest {
  request: RunRequest
  extension: RunRequestExtension
}

/**
 * Parse a `/v1/runs` body: the contract request, validated exactly as
 * {@link parseRunRequest} validates it, plus Cognia's extension beside it.
 */
export function parseRunApiRequest(
  body: unknown,
  policy: RunRequestPolicy
): Parsed<ParsedRunApiRequest> {
  let contractBody = body
  let rawExtension: unknown = undefined
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const { [RUN_REQUEST_EXTENSION_FIELD]: extensionValue, ...rest } = body as Record<
      string,
      unknown
    >
    if (RUN_REQUEST_EXTENSION_FIELD in (body as Record<string, unknown>)) {
      contractBody = rest
      rawExtension = extensionValue
    }
  }
  const issues: ApiIssue[] = []
  let extension: RunRequestExtension = {}
  if (rawExtension !== undefined) {
    const parsedExtension = RunRequestExtensionSchema.safeParse(rawExtension)
    if (parsedExtension.success) {
      extension = parsedExtension.data
    } else {
      const extra = unknownKeys(parsedExtension.error)
      issues.push(
        extra.length > 0
          ? issue("UNSUPPORTED_PARAMETER", `unsupported fields: ${extra.join(", ")}`, {
              fields: extra.map((field) => `${RUN_REQUEST_EXTENSION_FIELD}.${field}`),
            })
          : issue("SCHEMA_INVALID", `the request's ${RUN_REQUEST_EXTENSION_FIELD} is invalid`, {
              paths: parsedExtension.error.issues.map((i) =>
                [RUN_REQUEST_EXTENSION_FIELD, ...i.path].join(".")
              ),
            })
      )
    }
  }
  const parsed = parseRunRequest(contractBody, policy)
  if (!parsed.ok) return { ok: false, issues: [...parsed.issues, ...issues] }
  const request = parsed.value
  const delegatePossible =
    request.mode === "delegate" ||
    (request.mode === "auto" && request.allowed_modes.includes("delegate"))
  if (extension.delegate_delivery === "workspace_updated" && !delegatePossible) {
    issues.push(
      issue(
        "UNSUPPORTED_PARAMETER",
        "delegate_delivery applies only to a request that may run delegate",
        { fields: [`${RUN_REQUEST_EXTENSION_FIELD}.delegate_delivery`] }
      )
    )
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, value: { request, extension } }
}

/**
 * Idempotency hash over tenant scope, endpoint and the exact request body.
 * Whitespace inside strings is significant; key order is not.
 */
export function idempotencyRequestHash(
  scope: { actorKeyId: string; endpoint: string },
  body: unknown
): string {
  return sha256Hex(canonicalJson({ actor: scope.actorKeyId, endpoint: scope.endpoint, body }))
}

export type IdempotencyDecision =
  { kind: "new" } | { kind: "replay"; runId: string } | { kind: "conflict" }

export function decideIdempotency(
  existing: { requestHash: string; runId: string } | undefined,
  requestHash: string
): IdempotencyDecision {
  if (!existing) return { kind: "new" }
  return existing.requestHash === requestHash
    ? { kind: "replay", runId: existing.runId }
    : { kind: "conflict" }
}

/** Cognia's documented virtual model names map onto the spec's router models. */
export const VIRTUAL_MODEL_ALIASES: Record<string, ChatRequest["model"]> = {
  "cognia/auto": "router/auto",
  "cognia/direct": "router/direct",
  "cognia/cascade": "router/cascade",
  "cognia/panel": "router/panel",
}

export function isVirtualRouterModel(model: unknown): boolean {
  return (
    typeof model === "string" && (model in VIRTUAL_MODEL_ALIASES || model.startsWith("router/"))
  )
}

/**
 * Strict chat-compat parsing: unknown parameters (tools, logprobs, temperature,
 * vendor reasoning fields, n > 1) are refused with 422 UNSUPPORTED_PARAMETER,
 * never silently ignored. `router/delegate` does not exist here by design.
 */
export function parseChatCompatRequest(body: unknown): Parsed<ChatRequest> {
  let candidate = body
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const record = body as Record<string, unknown>
    if (record.model === "cognia/delegate" || record.model === "router/delegate") {
      return {
        ok: false,
        issues: [issue("DELEGATE_REQUIRES_RUN_API", "delegate is only available through /v1/runs")],
      }
    }
    if (typeof record.model === "string" && record.model in VIRTUAL_MODEL_ALIASES) {
      candidate = { ...record, model: VIRTUAL_MODEL_ALIASES[record.model] }
    }
    if (typeof record.n === "number" && record.n !== 1) {
      return {
        ok: false,
        issues: [issue("UNSUPPORTED_PARAMETER", "n must be 1", { fields: ["n"] })],
      }
    }
  }
  const parsed = ChatRequestSchema.safeParse(candidate)
  if (parsed.success) return { ok: true, value: parsed.data }
  const extra = unknownKeys(parsed.error)
  if (extra.length > 0) {
    return {
      ok: false,
      issues: [
        issue("UNSUPPORTED_PARAMETER", `unsupported parameters: ${extra.join(", ")}`, {
          fields: extra,
        }),
      ],
    }
  }
  return {
    ok: false,
    issues: [
      issue("SCHEMA_INVALID", "the request does not match the chat-compat subset", {
        paths: parsed.error.issues.map((i) => i.path.join(".")),
      }),
    ],
  }
}
