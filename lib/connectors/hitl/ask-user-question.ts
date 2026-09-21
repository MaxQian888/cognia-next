/**
 * `ask_user` elicitation over IM (control-plane HITL), sibling to
 * `tool-approval.ts`.
 *
 * The desktop `ask_user` path (`stores/agent/ask-user-store.ts`) renders a
 * renderer dialog — but for a connector-initiated run nobody is watching the
 * desktop. When `handlePluginToolExec` finds a live IM elicitation context for
 * the calling session (`im-elicitation-context.ts`), it lands here instead:
 *
 *   1. The model's args are normalised by the shared `parseAskUserArgs`.
 *   2. `buildAskUserSurface` projects a bilingual A2UI question card —
 *      one Button per option (`select` resolves immediately for
 *      single-select; `toggle` mutates multi-select state until `submit`),
 *      a TextField when `allowText`, and a Skip button.
 *   3. Every interactive component carries `bindingKind: "ask_user"` +
 *      `bindingPayload: {sessionId, toolUseId, op, value?}` hints, so each
 *      platform mapper persists a kind-tagged `connectorCallbackBindings`
 *      row for the actionId it generates (`a2ui:<surface>:<component>:<verb>`).
 *      The same rows are ALSO pre-recorded here before the card is enqueued,
 *      so the routing rows exist before the card can become visible. The
 *      mapper's delivery-time upsert writes identical values — idempotent.
 *   4. The card is enqueued through the governed outbound gateway and the
 *      tool call suspends on `awaitAskUser` — an in-process Promise in
 *      `ask-user-registry.ts`, keyed by `${sessionId}:${toolUseId}`.
 *   5. `bus.dispatchConnectorCallback`'s `ask_user` short-circuit (plus the
 *      surface-correlated input paths — Telegram ForceReply, Discord modal
 *      submit) feeds `applyAskUserCallback`, which mutates or resolves the
 *      pending entry. TTL expiry and owner abort settle it too.
 *   6. The card is edited/frozen into a bilingual terminal state (answered /
 *      skipped / expired / stopped) — on Lark through `settleApprovalCard`'s
 *      command frame, on the other platforms through a governed edit of the
 *      original card that strips its controls — and the formatted answer
 *      returns to the model.
 *   7. When the turn has a durable Execution Run the wait is mirrored onto an
 *      `ask_user` interrupt, so the run card reflects the suspension and a
 *      recovered run sees the pending prompt.
 *
 * surfaceId convention: `au_<16 hex>` — deliberately short so the generated
 * `a2ui:<surfaceId>:<component>:<verb>` actionIds stay under Telegram's
 * 64-byte `callback_data` cap (hashed wire ids do not round-trip through the
 * binding table). The sessionId/toolUseId correlation lives in the binding
 * payload instead.
 */

import {
  formatAskUserAnswer,
  parseAskUserArgs,
  type AskUserAnswer,
  type AskUserRequest,
} from "@/lib/claude/ask-user-tool"
import type { A2UISegmentContent } from "@/types/connectors/segment"
import type {
  CallbackActorScope,
  ConnectorCallbackBindingRow,
  ConnectorCallbackEvent,
} from "@/types/connectors/interaction"
import { enqueueGoverned } from "@/lib/connectors/delivery-gateway"
import { buildActionId, recordCallbackBinding } from "@/lib/connectors/adapters/_shared/a2ui-mapper"
import { buildA2UISegment } from "@/lib/connectors/a2ui-bridge/a2ui-to-segments"
import { appendAudit } from "@/lib/connectors/audit"
import { waitForOutboundTerminal } from "@/lib/db/outbound-jobs"
import { newIdempotencyKey } from "@/types/connectors/outbound"
import {
  awaitAskUser,
  getPendingAskUser,
  getPendingAskUserBySurface,
  resolveAskUser,
  toggleAskUserValue,
  DEFAULT_ASK_USER_TTL_MS,
  type PendingAskUser,
  type PendingAskUserMeta,
} from "./ask-user-registry"
import { settleApprovalCard, type ApprovalCardState } from "./approval-card-state"
import type { ImElicitationContext } from "./im-elicitation-context"

/** Operations carried by `bindingPayload.op` on every ask_user component. */
export type AskUserOp = "select" | "toggle" | "submit" | "submit_text" | "skip"

export const ASK_USER_OPS: readonly AskUserOp[] = [
  "select",
  "toggle",
  "submit",
  "submit_text",
  "skip",
]

const ASK_USER_OP_SET: ReadonlySet<string> = new Set(ASK_USER_OPS)

/** Component ids — fixed so the pre-recorded bindings and the mapper's
 *  delivery-time bindings agree on `a2ui:<surface>:<component>:<verb>`. */
const TEXT_COMPONENT_ID = "answer_text"
const SUBMIT_COMPONENT_ID = "submit"
const SKIP_COMPONENT_ID = "skip"
const optionComponentId = (index: number) => `opt_${index}`

/** Binding identity stamped on every interactive component of the card. */
export interface AskUserBindingHints {
  sessionId: string
  toolUseId: string
  actorScope: CallbackActorScope
  /** Absolute expiry (epoch ms) — the prompt's own deadline. */
  expiresAt: number
}

/** One interactive component of a question card, for binding pre-recording. */
interface AskUserComponentPlan {
  componentId: string
  /** The A2UI action verb — the last leg of the generated actionId. */
  action: string
  op: AskUserOp
  /** Option value for select/toggle components. */
  value?: string
}

/**
 * Enumerate the interactive components a question card will render, in the
 * same shape `buildAskUserSurface` emits. Single source of truth so the
 * binding rows pre-recorded before enqueue match the components the
 * platform mappers later serialize.
 */
function askUserComponentPlan(request: AskUserRequest): AskUserComponentPlan[] {
  const plan: AskUserComponentPlan[] = request.options.map((option, index) => ({
    componentId: optionComponentId(index),
    action: request.multiSelect ? "toggle" : "select",
    op: request.multiSelect ? "toggle" : "select",
    value: option.value,
  }))
  if (request.allowText) {
    plan.push({ componentId: TEXT_COMPONENT_ID, action: "submit_text", op: "submit_text" })
  }
  if (request.multiSelect && request.options.length > 0) {
    plan.push({ componentId: SUBMIT_COMPONENT_ID, action: "submit", op: "submit" })
  }
  plan.push({ componentId: SKIP_COMPONENT_ID, action: "skip", op: "skip" })
  return plan
}

function bindingHintProps(
  binding: AskUserBindingHints,
  op: AskUserOp,
  value?: string
): Record<string, unknown> {
  return {
    bindingKind: "ask_user",
    bindingPayload: {
      sessionId: binding.sessionId,
      toolUseId: binding.toolUseId,
      op,
      ...(value !== undefined ? { value } : {}),
    },
    bindingActorScope: binding.actorScope,
    bindingExpiresAt: binding.expiresAt,
  }
}

/**
 * Pure builder for the interactive question card. `selected` carries the
 * currently toggled option values — on a multi-select toggle the card is
 * re-projected with the picked options highlighted (`✓` prefix + primary
 * variant), which is the only cross-platform selection affordance (Lark has
 * no inline checkbox; Telegram has none at all).
 */
export function buildAskUserSurface(input: {
  request: AskUserRequest
  binding: AskUserBindingHints
  selected?: readonly string[]
}): A2UISegmentContent {
  const { request, binding } = input
  const selected = new Set(input.selected ?? [])
  const title = "需要你的回答 / Your answer is needed"
  const components: Record<string, unknown> = {
    root: { component: "Card", title, children: ["q"] },
    q: { component: "Text", text: request.question },
  }
  const rootChildren = components.root as { children: string[] }

  if (request.options.length > 0) {
    const optIds: string[] = []
    request.options.forEach((option, index) => {
      const id = optionComponentId(index)
      const picked = selected.has(option.value)
      optIds.push(id)
      components[id] = {
        component: "Button",
        text: picked ? `✓ ${option.label}` : option.label,
        action: request.multiSelect ? "toggle" : "select",
        ...(picked ? { variant: "primary" } : {}),
        ...bindingHintProps(binding, request.multiSelect ? "toggle" : "select", option.value),
      }
    })
    components["opts"] = { component: "Column", children: optIds }
    rootChildren.children.push("opts")
  }

  if (request.allowText) {
    components[TEXT_COMPONENT_ID] = {
      component: "TextField",
      label: "输入回答 / Type an answer",
      placeholder: "在此输入，或直接点选 / Type here, or pick an option",
      action: "submit_text",
      ...bindingHintProps(binding, "submit_text"),
    }
    rootChildren.children.push(TEXT_COMPONENT_ID)
  }

  const actionChildren: string[] = []
  if (request.multiSelect && request.options.length > 0) {
    components[SUBMIT_COMPONENT_ID] = {
      component: "Button",
      text: "提交 / Submit",
      variant: "primary",
      action: "submit",
      ...bindingHintProps(binding, "submit"),
    }
    actionChildren.push(SUBMIT_COMPONENT_ID)
  }
  components[SKIP_COMPONENT_ID] = {
    component: "Button",
    text: "跳过 / Skip",
    action: "skip",
    ...bindingHintProps(binding, "skip"),
  }
  actionChildren.push(SKIP_COMPONENT_ID)
  components["actions"] = { component: "Row", children: actionChildren }
  rootChildren.children.push("actions")

  const mirrorLines = [`# ${title}`, request.question]
  request.options.forEach((option, index) => {
    mirrorLines.push(`${index + 1}) ${option.label}`)
  })
  if (request.allowText) {
    mirrorLines.push("（可直接回复文本 / or reply with text）")
  }
  mirrorLines.push("[跳过 / Skip]")

  return {
    components,
    dataModel: {},
    rootId: "root",
    surfaceType: "inline",
    title,
    widget: { fallbackText: mirrorLines.join("\n") },
  }
}

/** Terminal card states. */
export type AskUserCardState = "answered" | "cancelled" | "expired" | "failed"

/**
 * The frozen card projected over the question once the prompt settles on a
 * non-Lark platform (Lark uses the approval-card command frame instead). No
 * interactive components — the mappers record nothing new, so presses are
 * impossible once the edit lands.
 */
export function askUserTerminalSurface(input: {
  request: AskUserRequest
  answer?: AskUserAnswer
  state: AskUserCardState
}): A2UISegmentContent {
  const { request, answer, state } = input
  const title = {
    answered: "✓ 已回答 / Answered",
    cancelled: "⊘ 已跳过 / Skipped",
    expired: "◷ 已过期 / Expired",
    failed: "✕ 已失效 / Unavailable",
  }[state]
  const children: string[] = ["q"]
  const components: Record<string, unknown> = {
    root: { component: "Card", title, children },
    q: { component: "Text", text: request.question },
  }
  if (state === "answered" && answer) {
    const lines: string[] = []
    if (answer.selected.length > 0) {
      const labels = answer.selected.map(
        (v) => request.options.find((o) => o.value === v)?.label ?? v
      )
      lines.push(`已选择 / Selected: ${labels.join(", ")}`)
    }
    if (answer.text.trim()) lines.push(`回答 / Answer: ${answer.text.trim()}`)
    components["result"] = {
      component: "Text",
      text: lines.join("\n") || "（空回答 / Empty answer）",
    }
    children.push("result")
  } else {
    components["closed"] = {
      component: "Text",
      text: "此问题已结束，操作已移除。 / This question is closed; its controls have been removed.",
    }
    children.push("closed")
  }
  const mirrorLines = [`# ${title}`, request.question]
  if (state === "answered" && answer?.text.trim()) mirrorLines.push(answer.text.trim())
  return {
    components,
    dataModel: {},
    rootId: "root",
    surfaceType: "inline",
    title,
    widget: { fallbackText: mirrorLines.join("\n") },
  }
}

/** Test seams — production callers leave these undefined. */
export interface AskUserDeps {
  enqueue?: typeof enqueueGoverned
  recordBinding?: typeof recordCallbackBinding
  audit?: typeof appendAudit
  waitForDelivery?: typeof waitForOutboundTerminal
}

type CardTargetMeta = Pick<
  PendingAskUserMeta,
  "adapterId" | "conversationKey" | "conversationRef" | "deliveryTarget" | "surfaceId" | "jobId"
>

/**
 * Edit the already-delivered question card through the governed outbound
 * queue — the same mechanism `settleApprovalCard` uses. Prefers the
 * platform message id the settling callback carried (`originatingMessageId`)
 * and otherwise resolves it from the outbound job's delivery receipt, which
 * also follows reroutes to sibling adapters. Best-effort: a presentation
 * failure is audited, never thrown — the answer already resolved.
 */
async function editAskUserCard(
  meta: CardTargetMeta,
  surface: A2UISegmentContent,
  stateTag: string,
  messageId: string | undefined,
  deps: AskUserDeps
): Promise<void> {
  const enqueue = deps.enqueue ?? enqueueGoverned
  const waitForDelivery = deps.waitForDelivery ?? waitForOutboundTerminal
  try {
    const delivery = !messageId && meta.jobId ? await waitForDelivery(meta.jobId, 5000) : undefined
    const target = messageId ?? delivery?.platformMessageId
    if (!target) return
    await enqueue({
      adapterId: delivery?.adapterId ?? meta.adapterId,
      conversationKey: delivery?.conversationKey ?? meta.conversationKey,
      request: {
        conversationRef: delivery?.request.conversationRef ?? meta.conversationRef,
        ...(delivery?.request.deliveryTarget
          ? { deliveryTarget: delivery.request.deliveryTarget }
          : meta.deliveryTarget
            ? { deliveryTarget: meta.deliveryTarget }
            : {}),
        editTargetMessageId: target,
        segments: [buildA2UISegment(meta.surfaceId, surface)],
        metadata: { idempotencyKey: `ask-user-edit:${meta.surfaceId}:${stateTag}` },
      },
      source: "ai-run",
    })
  } catch {
    await (deps.audit ?? appendAudit)({
      adapterId: meta.adapterId,
      conversationKey: meta.conversationKey,
      kind: "adapter.error",
      at: Date.now(),
      reason: "ask_user_card_update_failed",
      fields: { surfaceId: meta.surfaceId, state: stateTag },
    }).catch(() => undefined)
  }
}

/**
 * Freeze the question card into its terminal bilingual state. On Lark the
 * approval-card command frame owns the edit (same look as tool approvals);
 * other platforms get the A2UI terminal surface through a governed edit.
 * Best-effort — the settlement already resolved the tool call.
 */
export async function settleAskUserCard(
  meta: PendingAskUserMeta,
  state: AskUserCardState,
  answer?: AskUserAnswer,
  messageId?: string,
  deps: AskUserDeps = {}
): Promise<void> {
  if (meta.conversationRef.platform === "lark") {
    const approvalState: ApprovalCardState =
      state === "answered"
        ? "answered"
        : state === "expired"
          ? "expired"
          : state === "cancelled"
            ? "skipped"
            : "cancelled"
    const formatted =
      state === "answered" && answer ? formatAskUserAnswer(meta.request, answer) : undefined
    await settleApprovalCard({
      adapterId: meta.adapterId,
      conversationKey: meta.conversationKey,
      conversationRef: meta.conversationRef,
      surfaceId: meta.surfaceId,
      jobId: meta.jobId,
      ...(messageId ? { messageId } : {}),
      state: approvalState,
      ...(formatted
        ? { detail: `**${meta.request.question.slice(0, 200)}**\n> ${formatted.slice(0, 280)}` }
        : {}),
    })
    return
  }
  await editAskUserCard(
    meta,
    askUserTerminalSurface({ request: meta.request, answer, state }),
    state,
    messageId,
    deps
  )
}

/**
 * Re-render the card after a multi-select `toggle` press so the picked
 * options show `✓`. Fresh idempotency key per press — each toggle is a
 * distinct render, not a retry of one logical update. Presentation-only:
 * a failed repaint never blocks the pending prompt.
 */
export async function refreshAskUserCard(
  entry: PendingAskUser,
  messageId: string | undefined,
  deps: AskUserDeps = {}
): Promise<void> {
  const meta = entry.meta
  const surface = buildAskUserSurface({
    request: meta.request,
    selected: entry.selected,
    binding: {
      sessionId: entry.sessionId,
      toolUseId: entry.toolUseId,
      actorScope: meta.actorScope,
      expiresAt: meta.bindingExpiresAt ?? Date.now() + DEFAULT_ASK_USER_TTL_MS,
    },
  })
  await editAskUserCard(meta, surface, `toggle-${newIdempotencyKey()}`, messageId, deps)
}

/**
 * Actor-scope re-check for callbacks that arrive WITHOUT an `ask_user`
 * binding row — Telegram ForceReply replies resolve no binding at all, and
 * Discord modal submits resolve the `modal_open` row (which has no
 * ask_user actorScope). The bound path already passed the bus's unified
 * authorization guard; this covers the binding-less correlations.
 */
function askUserActorAllowed(
  entry: PendingAskUser,
  event: ConnectorCallbackEvent,
  operatorIds: string[]
): boolean {
  const scope = entry.meta.actorScope
  const actorId = event.user.remoteUserId || event.user.id
  switch (scope.mode) {
    case "anyone":
      return true
    case "conversation":
      return (
        !entry.meta.conversationKey ||
        !event.conversationKey ||
        entry.meta.conversationKey === event.conversationKey
      )
    case "initiator":
    case "operators":
      return new Set([...(scope.allowedUserIds ?? []), ...operatorIds]).has(actorId)
  }
}

export interface ApplyAskUserCallbackInput {
  event: ConnectorCallbackEvent
  /**
   * The binding row the bus resolved for `triggerId` — an `ask_user` row for
   * bound presses, `modal_open` for a Discord modal submit, or undefined for
   * Telegram ForceReply correlations.
   */
  binding?: ConnectorCallbackBindingRow
  /** Surface id after the bus's binding resolution (binding wins over inline). */
  surfaceId?: string
  /** Adapter `settings.runOperatorUserIds` — widens initiator/operator scope. */
  operatorIds?: string[]
  deps?: AskUserDeps
}

export interface ApplyAskUserCallbackResult {
  /** The event belonged to an ask_user card (or a correlated input path). */
  handled: boolean
  /** The pending prompt was settled by this event. */
  resolved: boolean
  op?: AskUserOp
}

/**
 * Apply one connector callback to the pending ask_user registry. Called by
 * the bus's `ask_user` short-circuit AFTER binding resolution + unified
 * authorization. Never starts a digest/model turn.
 *
 * Dispatch rules:
 *   - `binding.kind === "ask_user"` — the payload's `{sessionId, toolUseId,
 *     op, value?}` addresses the pending prompt directly.
 *   - otherwise — surface correlation (`getPendingAskUserBySurface`):
 *     `actionType "input"` (Telegram ForceReply, any platform's binding-less
 *     text reply) and `actionType "submit"` on a `modal_open` binding
 *     (Discord modal) both mean `submit_text`; `dismiss` means `skip`.
 *     These paths re-check actor scope here because their binding rows do
 *     not carry the ask_user scope.
 */
export async function applyAskUserCallback(
  input: ApplyAskUserCallbackInput
): Promise<ApplyAskUserCallbackResult> {
  const { event, binding } = input
  const deps = input.deps ?? {}
  const audit = deps.audit ?? appendAudit
  const operatorIds = input.operatorIds ?? []
  const surfaceId = input.surfaceId ?? event.surfaceId ?? ""

  let entry: PendingAskUser | undefined
  let op: AskUserOp | undefined
  let payloadValue: string | undefined

  if (binding?.kind === "ask_user") {
    const p = (binding.payload ?? {}) as Record<string, unknown>
    const sessionId = typeof p.sessionId === "string" ? p.sessionId : ""
    const toolUseId = typeof p.toolUseId === "string" ? p.toolUseId : ""
    const rawOp =
      typeof p.op === "string" && ASK_USER_OP_SET.has(p.op) ? (p.op as AskUserOp) : undefined
    // A platform dismiss wins over whatever op the component baked in.
    op = event.actionType === "dismiss" ? "skip" : rawOp
    payloadValue = typeof p.value === "string" ? p.value : undefined
    entry = sessionId && toolUseId ? getPendingAskUser(sessionId, toolUseId) : undefined
    if (!entry) {
      // Bound press on a prompt that already settled (TTL, earlier answer,
      // owner abort) — swallow it; never a digest turn.
      await audit({
        adapterId: event.adapterId,
        kind: "ask_user.answered",
        at: Date.now(),
        conversationKey: event.conversationKey,
        fields: { sessionId, toolUseId, op: op ?? "unknown", resolved: false, stale: true },
      }).catch(() => undefined)
      return { handled: true, resolved: false, op }
    }
  } else {
    entry = surfaceId ? getPendingAskUserBySurface(surfaceId) : undefined
    if (!entry) return { handled: false, resolved: false }
    // Surface-correlated events carry no ask_user binding row — the card can
    // only be pressed inside its own conversation, so adapter + key equality
    // is the correlation proof, then the prompt's own actor scope decides.
    if (entry.meta.adapterId !== event.adapterId) return { handled: false, resolved: false }
    if (event.actionType === "input") {
      op = "submit_text"
      payloadValue = event.value
    } else if (event.actionType === "submit" && binding?.kind === "modal_open") {
      op = "submit_text"
      const componentKey = entry.meta.textComponentId ?? TEXT_COMPONENT_ID
      const submitted = event.payload?.[componentKey]
      payloadValue =
        typeof submitted === "string"
          ? submitted
          : Array.isArray(submitted)
            ? submitted.filter((v): v is string => typeof v === "string").join("\n")
            : ""
    } else if (event.actionType === "dismiss") {
      op = "skip"
    } else {
      return { handled: false, resolved: false }
    }
    if (!askUserActorAllowed(entry, event, operatorIds)) {
      await audit({
        adapterId: event.adapterId,
        kind: "callback.forbidden",
        at: Date.now(),
        conversationKey: event.conversationKey,
        reason: "actor_forbidden",
        fields: { surfaceId, kindClass: "ask_user", op },
      }).catch(() => undefined)
      return { handled: true, resolved: false, op }
    }
  }

  const auditBase = {
    adapterId: event.adapterId,
    at: Date.now(),
    conversationKey: entry.meta.conversationKey ?? event.conversationKey,
    fields: { sessionId: entry.sessionId, toolUseId: entry.toolUseId, op },
  }

  switch (op) {
    case "select": {
      const candidate = payloadValue ?? event.value
      // Validate against the offered options — on Slack `event.value` is the
      // action verb, not the option, and a press must never mint an option
      // the model never offered.
      if (!candidate || !entry.meta.request.options.some((o) => o.value === candidate)) {
        return { handled: true, resolved: false, op }
      }
      const resolved = resolveAskUser(
        entry.sessionId,
        entry.toolUseId,
        { selected: [candidate], text: "", cancelled: false },
        "answered",
        event.originatingMessageId
      )
      await audit({
        ...auditBase,
        kind: "ask_user.answered",
        fields: { ...auditBase.fields, resolved },
      }).catch(() => undefined)
      return { handled: true, resolved, op }
    }
    case "toggle": {
      const candidate = payloadValue ?? event.value
      if (!candidate || !entry.meta.request.options.some((o) => o.value === candidate)) {
        return { handled: true, resolved: false, op }
      }
      toggleAskUserValue(entry.sessionId, entry.toolUseId, candidate)
      // Reflect the pick on the card. Presentation-only — never blocks.
      await refreshAskUserCard(entry, event.originatingMessageId, deps)
      return { handled: true, resolved: false, op }
    }
    case "submit":
    case "submit_text": {
      const payloadValues = Array.isArray(event.payload?.values)
        ? event.payload.values.filter(
            (v): v is string =>
              typeof v === "string" && entry.meta.request.options.some((o) => o.value === v)
          )
        : []
      const selected = [...new Set([...entry.selected, ...payloadValues])]
      const text = op === "submit_text" ? (payloadValue ?? event.value ?? "") : ""
      const resolved = resolveAskUser(
        entry.sessionId,
        entry.toolUseId,
        { selected, text, cancelled: false },
        "answered",
        event.originatingMessageId
      )
      // The answer TEXT never enters audit fields — op + resolved only.
      await audit({
        ...auditBase,
        kind: "ask_user.answered",
        fields: { ...auditBase.fields, resolved },
      }).catch(() => undefined)
      return { handled: true, resolved, op }
    }
    case "skip": {
      const resolved = resolveAskUser(
        entry.sessionId,
        entry.toolUseId,
        { selected: [], text: "", cancelled: true },
        "cancelled",
        event.originatingMessageId
      )
      await audit({
        ...auditBase,
        kind: "ask_user.cancelled",
        fields: { ...auditBase.fields, resolved },
      }).catch(() => undefined)
      return { handled: true, resolved, op }
    }
    default: {
      await audit({
        adapterId: event.adapterId,
        kind: "callback.unbound",
        at: Date.now(),
        conversationKey: event.conversationKey,
        reason: "ask_user:unknown_op",
        fields: { triggerId: event.triggerId, surfaceId },
      }).catch(() => undefined)
      return { handled: true, resolved: false }
    }
  }
}

export interface RunImAskUserInput {
  ctx: ImElicitationContext
  /** The sidecar's tool_use id — dedupes re-delivered exec events and keys
   *  the pending registry. */
  toolUseId: string
  args: Record<string, unknown>
  /** Extra caller signal (`plugin_tool_exec`'s abortSignal). Combined with
   *  the context's own run-lifetime signal inside. */
  signal?: AbortSignal
  deps?: AskUserDeps
}

/**
 * IM-side `ask_user` entry point — the `handlePluginToolExec` branch calls
 * this when the session has a live elicitation context. Returns the same
 * formatted answer string the desktop path produces, so the model sees one
 * contract on both transports.
 */
export async function runImAskUser(input: RunImAskUserInput): Promise<string> {
  const { ctx, toolUseId } = input
  const deps = input.deps ?? {}
  const enqueue = deps.enqueue ?? enqueueGoverned
  const recordBinding = deps.recordBinding ?? recordCallbackBinding
  const audit = deps.audit ?? appendAudit
  const request = parseAskUserArgs(input.args)
  const auditFields = { toolUseId, sessionId: ctx.sessionId }
  const cancelledAnswer: AskUserAnswer = { selected: [], text: "", cancelled: true }

  // A draft-prepare turn has no live audience — same premise the permission
  // responder uses to auto-deny ask-tier tools while drafting.
  if (ctx.drafting) {
    await audit({
      adapterId: ctx.adapterId,
      kind: "ask_user.cancelled",
      at: Date.now(),
      conversationKey: ctx.conversationKey,
      fields: { ...auditFields, reason: "drafting" },
    }).catch(() => undefined)
    return "The user was not asked: this turn is preparing a draft and has no live audience."
  }

  const ttlMs = ctx.ttlMs !== undefined && ctx.ttlMs > 0 ? ctx.ttlMs : DEFAULT_ASK_USER_TTL_MS
  const expiresAt = Date.now() + ttlMs
  // Short surfaceId — see the module header: keeps generated actionIds under
  // Telegram's 64-byte callback_data cap so bindings round-trip unhashed.
  const surfaceId = `au_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`
  const actorScope: CallbackActorScope =
    ctx.actorScope ??
    (ctx.initiatorUserId
      ? { mode: "initiator", allowedUserIds: [ctx.initiatorUserId] }
      : { mode: "operators" })
  const binding: AskUserBindingHints = {
    sessionId: ctx.sessionId,
    toolUseId,
    actorScope,
    expiresAt,
  }

  const interruptId = ctx.runId ? `ask-user:${ctx.runId}:${toolUseId}` : undefined
  if (ctx.runId && interruptId) {
    const { createRunInterrupt } = await import("@/lib/execution/run-control")
    await createRunInterrupt({
      id: interruptId,
      runId: ctx.runId,
      type: "ask_user",
      status: "pending",
      title: request.question.slice(0, 80),
      toolName: "ask_user",
      requestDigest: toolUseId,
      expiresAt,
      createdAt: Date.now(),
    }).catch(() => undefined)
  }

  // Register the pending prompt BEFORE the card exists anywhere, so a press
  // can never arrive at a surface the registry doesn't know.
  const signal =
    ctx.signal && input.signal
      ? AbortSignal.any([ctx.signal, input.signal])
      : (ctx.signal ?? input.signal)
  const pendingMeta: PendingAskUserMeta = {
    surfaceId,
    request,
    adapterId: ctx.adapterId,
    conversationKey: ctx.conversationKey,
    conversationRef: ctx.conversationRef,
    ...(ctx.deliveryTarget ? { deliveryTarget: ctx.deliveryTarget } : {}),
    actorScope,
    ...(ctx.initiatorUserId ? { initiatorUserId: ctx.initiatorUserId } : {}),
    ...(request.allowText ? { textComponentId: TEXT_COMPONENT_ID } : {}),
    bindingExpiresAt: expiresAt,
  }
  const settlementPromise = awaitAskUser(ctx.sessionId, toolUseId, {
    ttlMs,
    ...(signal ? { signal } : {}),
    meta: pendingMeta,
  })

  // The owner died between context lookup and registration — `awaitAskUser`
  // returned an already-resolved settlement without registering. Posting the
  // card now would put a dead question in the chat.
  if (signal?.aborted) {
    if (ctx.runId && interruptId) {
      const { resolveRunInterruptFromSource } = await import("@/lib/execution/run-control")
      await resolveRunInterruptFromSource(ctx.runId, interruptId, "deny").catch(() => undefined)
    }
    await audit({
      adapterId: ctx.adapterId,
      kind: "ask_user.cancelled",
      at: Date.now(),
      conversationKey: ctx.conversationKey,
      fields: { ...auditFields, reason: "run_aborted" },
    }).catch(() => undefined)
    await settlementPromise
    return formatAskUserAnswer(request, cancelledAnswer)
  }

  const surface = buildAskUserSurface({ request, binding })

  let jobId: string | undefined
  try {
    // Pre-record one binding row per interactive component — identical to
    // what the mappers persist at delivery (same actionId, kind, payload,
    // scope, expiry), so the rows are durable before the card is visible
    // and the mapper's upsert is a no-op write.
    await Promise.all(
      askUserComponentPlan(request).map((part) =>
        recordBinding({
          adapterId: ctx.adapterId,
          actionId: buildActionId(surfaceId, part.componentId, part.action),
          surfaceId,
          componentId: part.componentId,
          conversationKey: ctx.conversationKey,
          kind: "ask_user",
          payload: {
            sessionId: ctx.sessionId,
            toolUseId,
            op: part.op,
            ...(part.value !== undefined ? { value: part.value } : {}),
          },
          actorScope,
          expiresAt,
        })
      )
    )
    const job = await enqueue({
      adapterId: ctx.adapterId,
      conversationKey: ctx.conversationKey,
      request: {
        conversationRef: ctx.conversationRef,
        ...(ctx.deliveryTarget ? { deliveryTarget: ctx.deliveryTarget } : {}),
        segments: [buildA2UISegment(surfaceId, surface)],
        metadata: { idempotencyKey: `ask-user:${ctx.sessionId}:${toolUseId}` },
      },
      source: "ai-run",
    })
    jobId = job?.id
    // The job id lets a `toggle` re-render or the settle edit resolve the
    // platform message id from the delivery receipt when a callback didn't
    // carry `originatingMessageId`.
    const entry = getPendingAskUser(ctx.sessionId, toolUseId)
    if (entry && jobId) entry.meta.jobId = jobId
  } catch {
    // The card never went out — release the pending entry, close the
    // interrupt, and hand the model a readable failure instead of hanging
    // the turn on a question nobody can see.
    resolveAskUser(ctx.sessionId, toolUseId, cancelledAnswer, "cancelled")
    if (ctx.runId && interruptId) {
      const { resolveRunInterruptFromSource } = await import("@/lib/execution/run-control")
      await resolveRunInterruptFromSource(ctx.runId, interruptId, "deny").catch(() => undefined)
    }
    await audit({
      adapterId: ctx.adapterId,
      kind: "ask_user.failed",
      at: Date.now(),
      conversationKey: ctx.conversationKey,
      fields: auditFields,
    }).catch(() => undefined)
    await settlementPromise.catch(() => undefined)
    return "Error: the question could not be delivered to the conversation."
  }

  await audit({
    adapterId: ctx.adapterId,
    kind: "ask_user.requested",
    at: Date.now(),
    conversationKey: ctx.conversationKey,
    fields: {
      ...auditFields,
      optionCount: request.options.length,
      multiSelect: request.multiSelect,
      allowText: request.allowText,
    },
  }).catch(() => undefined)

  const settlement = await settlementPromise

  // Freeze the card — fire-and-forget like the approval card settle; the
  // answer is already decided.
  const state: AskUserCardState =
    settlement.reason === "answered"
      ? "answered"
      : settlement.reason === "expired"
        ? "expired"
        : "cancelled"
  void settleAskUserCard(
    pendingMeta,
    state,
    settlement.reason === "answered" ? settlement.answer : undefined,
    settlement.messageId,
    deps
  )

  if (settlement.reason === "expired") {
    await audit({
      adapterId: ctx.adapterId,
      kind: "ask_user.expired",
      at: Date.now(),
      conversationKey: ctx.conversationKey,
      fields: auditFields,
    }).catch(() => undefined)
  } else if (settlement.reason === "aborted") {
    await audit({
      adapterId: ctx.adapterId,
      kind: "ask_user.cancelled",
      at: Date.now(),
      conversationKey: ctx.conversationKey,
      fields: { ...auditFields, reason: "run_aborted" },
    }).catch(() => undefined)
  }

  if (ctx.runId && interruptId) {
    const { resolveRunInterruptFromSource, expireRunInterruptFromSource } =
      await import("@/lib/execution/run-control")
    if (settlement.reason === "expired") {
      await expireRunInterruptFromSource(ctx.runId, interruptId).catch(() => undefined)
    } else {
      await resolveRunInterruptFromSource(
        ctx.runId,
        interruptId,
        settlement.reason === "answered" ? "approve" : "deny"
      ).catch(() => undefined)
    }
  }

  return formatAskUserAnswer(request, settlement.answer)
}
