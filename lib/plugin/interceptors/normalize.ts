/**
 * Normalization — the legacy authoring surfaces, expressed as interceptors.
 *
 * `ctx.chat.use(...)` and the `PluginHooks` bag returned from `activate()` are
 * ergonomics, not runtimes. They stay exactly as they are for plugin authors
 * and are rewritten here into `InterceptorRegistration` records, so there is
 * one store, one ordering rule, one liveness rule and one failure rule no
 * matter which door a plugin came through.
 *
 * Only the hooks whose shape is genuinely an interceptor are normalized:
 *
 *   - `onChatRequest`  → `model.request.prepare`. The legacy dispatcher ran
 *     every plugin against the SAME `messages` array and then returned the last
 *     successful result, so with two plugins installed one of them silently did
 *     nothing. As a transform chain each sees its predecessor's output, which
 *     is what "pipeline" was always supposed to mean.
 *   - `onBuildOptions` → `agent.context.prepare`. Already a serial shallow
 *     merge; the adapter keeps that merge verbatim.
 *   - `onPostToolUse`  → `tool.result.project`. Already an accumulate-and-merge;
 *     the adapter keeps that too.
 *
 * `onPreToolUse` is deliberately NOT normalized: its shape is allow/deny/modify
 * — a guard fused with a transform — and folding it into a transform chain
 * would let a later plugin turn an earlier plugin's `deny` back into `allow`.
 * It keeps its first-non-allow-wins dispatcher; `tool.execute` is its typed
 * successor.
 */

import { nanoid } from "nanoid"
import type {
  ChatMiddlewareRequest,
  ChatMiddlewareResponse,
} from "@/types/plugin/plugin-chat-middleware"
import type {
  BuildOptionsHookInput,
  PluginHooksAll,
  PostToolUseResult,
} from "@/types/plugin/plugin-hooks"
import { resolveInterceptorIdentity } from "./identity"
import { resolveInterceptorTrustTier } from "./trust"
import { requireInterceptorPoint } from "./points"
import type {
  InterceptorFailurePolicy,
  InterceptorHandler,
  InterceptorOrder,
  InterceptorRegistration,
  InterceptorSemantic,
} from "./types"

export interface CreateInterceptorRegistrationInput {
  pluginId: string
  pointId: string
  semantic: InterceptorSemantic
  handler?: InterceptorHandler
  handlerRef?: string
  order?: InterceptorOrder
  timeoutMs?: number
  failurePolicy?: InterceptorFailurePolicy
  source: InterceptorRegistration["source"]
  legacyHookName?: string
  /** Stable id when the surface has one (a middleware id, a hook name). */
  registrationId?: string
}

/**
 * Mint one registration.
 *
 * The host is the only caller. Identity and trust tier are resolved here rather
 * than accepted as arguments precisely so no authoring surface can pass its own
 * — a plugin that could name its generation could keep a torn-down handler
 * alive across a reload, and one that could name its tier would wrap every
 * builtin interceptor on the point.
 */
export function createInterceptorRegistration(
  input: CreateInterceptorRegistrationInput
): InterceptorRegistration {
  const point = requireInterceptorPoint(input.pointId)
  const identity = resolveInterceptorIdentity(input.pluginId)
  const requested = input.timeoutMs ?? point.timeoutCeilingMs
  return {
    registrationId: input.registrationId ?? `${input.pluginId}:${input.pointId}:${nanoid(8)}`,
    pluginId: input.pluginId,
    pluginInstanceId: identity.pluginInstanceId,
    generation: identity.generation,
    realmId: identity.realmId,
    pointId: input.pointId,
    semantic: input.semantic,
    trustTier: resolveInterceptorTrustTier(input.pluginId),
    order: input.order ?? {},
    // The point's ceiling is a ceiling, not a default a registration can raise.
    timeoutMs: Math.max(1, Math.min(requested, point.timeoutCeilingMs)),
    ...(input.handler ? { handler: input.handler } : {}),
    ...(input.handlerRef ? { handlerRef: input.handlerRef } : {}),
    ...(input.failurePolicy ? { failurePolicy: input.failurePolicy } : {}),
    source: input.source,
    ...(input.legacyHookName ? { legacyHookName: input.legacyHookName } : {}),
    runtime: identity.runtime,
  }
}

/* -------------------------------------------------------------------------- */
/* ctx.chat.use → model.request.invoke                                        */
/* -------------------------------------------------------------------------- */

export interface ChatMiddlewareLike {
  pluginId: string
  fullId: string
  priority: number
  timeoutMs: number
  fn: (
    req: ChatMiddlewareRequest,
    next: () => Promise<ChatMiddlewareResponse>
  ) => Promise<ChatMiddlewareResponse>
}

/**
 * Wrap a chat middleware as an `around` interceptor.
 *
 * The legacy `next` takes no argument — a middleware rewrites the request by
 * mutating or rebuilding `req` before delegating, and the old runner ignored
 * that and always forwarded the ORIGINAL request. Forwarding the value the
 * middleware actually holds is the behaviour authors already expect, and it is
 * what makes a request rewrite work at all.
 */
export function interceptorFromChatMiddleware(entry: ChatMiddlewareLike): InterceptorRegistration {
  const handler = (
    input: ChatMiddlewareRequest,
    next: (value?: ChatMiddlewareRequest) => Promise<ChatMiddlewareResponse>
  ): Promise<ChatMiddlewareResponse> => entry.fn(input, () => next(input))

  return createInterceptorRegistration({
    pluginId: entry.pluginId,
    pointId: "model.request.invoke",
    semantic: "around",
    handler: handler as unknown as InterceptorHandler,
    order: { priority: entry.priority },
    timeoutMs: entry.timeoutMs,
    source: "chat-middleware",
    registrationId: entry.fullId,
  })
}

/* -------------------------------------------------------------------------- */
/* PluginHooks → interceptor points                                           */
/* -------------------------------------------------------------------------- */

export interface ToolResultProjectValue {
  toolName: string
  toolArgs: unknown
  toolResult: unknown
  sessionId: string
  projection: PostToolUseResult
}

/** Legacy hook names this module knows how to express as an interceptor. */
export const NORMALIZED_LEGACY_HOOKS = ["onChatRequest", "onBuildOptions", "onPostToolUse"] as const

export type NormalizedLegacyHook = (typeof NORMALIZED_LEGACY_HOOKS)[number]

const LEGACY_HOOK_POINTS: Readonly<Record<NormalizedLegacyHook, string>> = Object.freeze({
  onChatRequest: "model.request.prepare",
  onBuildOptions: "agent.context.prepare",
  onPostToolUse: "tool.result.project",
})

export function legacyHookPointId(hookName: NormalizedLegacyHook): string {
  return LEGACY_HOOK_POINTS[hookName]
}

function adaptChatRequest(
  hooks: PluginHooksAll
): ((value: ChatMiddlewareRequest) => Promise<ChatMiddlewareRequest>) | undefined {
  const hook = hooks.onChatRequest
  if (typeof hook !== "function") return undefined
  return async (value) => {
    const produced = await hook(value.messages, value.model)
    // A hook that returns nothing leaves the chain's value alone; returning a
    // non-array would replace the transcript with garbage, so it is refused
    // here rather than at the model. The hook only ever saw the messages, so
    // only the messages can come back — `sessionId` and `signal` are carried
    // across untouched, which is also what the point's invariant check asserts.
    if (!Array.isArray(produced)) return value
    return { ...value, messages: produced }
  }
}

function adaptBuildOptions(
  hooks: PluginHooksAll
): ((value: BuildOptionsHookInput) => Promise<BuildOptionsHookInput>) | undefined {
  const hook = hooks.onBuildOptions
  if (typeof hook !== "function") return undefined
  return async (value) => {
    const patch = await hook(value)
    if (!patch || typeof patch !== "object") return value
    // Shallow per-field merge, exactly as `dispatchBuildOptions` did: an
    // omitted field is "leave it alone", and an explicit `undefined` must not
    // null out a host-set value.
    const next: BuildOptionsHookInput = { ...value }
    for (const [key, entry] of Object.entries(patch)) {
      if (entry !== undefined) {
        ;(next as unknown as Record<string, unknown>)[key] = entry
      }
    }
    return next
  }
}

function adaptPostToolUse(
  hooks: PluginHooksAll
): ((value: ToolResultProjectValue) => Promise<ToolResultProjectValue>) | undefined {
  const hook = hooks.onPostToolUse
  if (typeof hook !== "function") return undefined
  return async (value) => {
    const produced = await hook(
      value.toolName,
      value.toolArgs,
      // Each plugin sees the projection so far, not the untouched original —
      // otherwise a redaction by an earlier plugin is invisible to a later one
      // and can be undone by it.
      value.projection.modifiedResult ?? value.toolResult,
      value.sessionId
    )
    if (!produced || typeof produced !== "object") return value
    const projection: PostToolUseResult = { ...value.projection }
    if (produced.modifiedResult !== undefined) {
      projection.modifiedResult = produced.modifiedResult
    }
    if (produced.additionalMessages?.length) {
      projection.additionalMessages = [
        ...(projection.additionalMessages ?? []),
        ...produced.additionalMessages,
      ]
    }
    return { ...value, projection }
  }
}

const LEGACY_ADAPTERS: Readonly<
  Record<NormalizedLegacyHook, (hooks: PluginHooksAll) => InterceptorHandler | undefined>
> = Object.freeze({
  onChatRequest: (hooks) => adaptChatRequest(hooks) as unknown as InterceptorHandler | undefined,
  onBuildOptions: (hooks) => adaptBuildOptions(hooks) as unknown as InterceptorHandler | undefined,
  onPostToolUse: (hooks) => adaptPostToolUse(hooks) as unknown as InterceptorHandler | undefined,
})

/**
 * Express whichever of a plugin's hooks are interceptor-shaped as registrations.
 *
 * The registration id is derived from the plugin id and hook name rather than
 * randomized, so re-registering after a hot reload replaces the record instead
 * of stacking a second copy of the same handler on the chain.
 */
export function interceptorsFromLegacyHooks(
  pluginId: string,
  hooks: PluginHooksAll,
  priority = 0
): InterceptorRegistration[] {
  const registrations: InterceptorRegistration[] = []
  for (const hookName of NORMALIZED_LEGACY_HOOKS) {
    const handler = LEGACY_ADAPTERS[hookName](hooks)
    if (!handler) continue
    registrations.push(
      createInterceptorRegistration({
        pluginId,
        pointId: LEGACY_HOOK_POINTS[hookName],
        semantic: "transform",
        handler,
        order: { priority },
        source: "legacy-hooks",
        legacyHookName: hookName,
        registrationId: `${pluginId}:${hookName}`,
      })
    )
  }
  return registrations
}
