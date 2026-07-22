import type {
  RunControlAction,
  RunPresentationDriver,
  RunPresentationRef,
  RunPresentationTarget,
  RunProjectionSnapshot,
} from "@/types/execution/run"
import type { ConversationDeliveryTarget } from "@/types/connectors/event"

type LarkMethod = "POST" | "PUT" | "PATCH"
export type LarkRunRequest = (method: LarkMethod, path: string, body: unknown) => Promise<unknown>

const CARD_LIMIT_BYTES = 30_000
const CARD_CREATED_AT_KEY = "cardCreatedAt"
const SUMMARY_ELEMENT_ID = "run_summary"
const ACTIONS_ELEMENT_ID = "run_actions"
const MAX_MUTATION_ATTEMPTS = 3

interface PendingCardMutation {
  sequence: number
  uuid: string
  operation: "stream_summary" | "update_actions" | "replace_card"
  method: "PUT"
  path: string
  body: Record<string, unknown>
}

interface PendingCardCreate {
  uuid: string
  target: RunPresentationTarget
  createdAt: number
}

interface LarkCardState {
  cardId: string
  lastAcknowledgedSequence: number
  cardCreatedAt: number
  elementIds: { summary: string; actions: string }
  target: RunPresentationTarget
  pendingMutation?: PendingCardMutation
  hasActions: boolean
}

interface FollowUpControlItem {
  action: RunControlAction | "status"
  content: string
  localizedContent: string
  interruptId?: string
}

interface FollowUpControlState {
  platformMessageId: string
  runId: string
  revision: number
  createdAt: number
  expiresAt: number
  items: FollowUpControlItem[]
}

export interface LarkRunPresentationDriverOptions {
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

const STATUS_LABEL_EN: Record<RunProjectionSnapshot["status"], string> = {
  queued: "Queued",
  running: "Running",
  waiting: "Waiting",
  paused: "Paused",
  recovery_required: "Recovery required",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
}

const STATUS_LABEL_ZH: Record<RunProjectionSnapshot["status"], string> = {
  queued: "排队中",
  running: "运行中",
  waiting: "等待确认",
  paused: "已暂停",
  recovery_required: "需要恢复",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
}

const ACTION_LABEL_EN: Record<RunControlAction, string> = {
  stop: "Stop",
  pause: "Pause",
  resume: "Resume",
  approve: "Approve",
  deny: "Deny",
  retry: "Retry",
  open_details: "View details",
}

const ACTION_LABEL_ZH: Record<RunControlAction, string> = {
  stop: "停止",
  pause: "暂停",
  resume: "继续",
  approve: "批准",
  deny: "拒绝",
  retry: "重试",
  open_details: "查看详情",
}

function clamp(value: string | undefined, max: number): string | undefined {
  if (!value || value.length <= max) return value
  return `${value.slice(0, max - 14)}… (truncated)`
}

/** Build a compact deterministic UUID whose entropy includes the entire input. */
function deterministicUuid(input: string): string {
  const hash = (seed: number): string => {
    let value = seed >>> 0
    for (let index = 0; index < input.length; index += 1) {
      value ^= input.charCodeAt(index)
      value = Math.imul(value, 0x01000193)
      value ^= value >>> 13
    }
    return (value >>> 0).toString(16).padStart(8, "0")
  }
  const hex = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35].map(hash).join("")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

function cardJson(snapshot: RunProjectionSnapshot, streaming: boolean): Record<string, unknown> {
  const zh = snapshot.locale?.toLowerCase().startsWith("zh") === true
  const statusLabel = zh ? STATUS_LABEL_ZH : STATUS_LABEL_EN
  const actionLabel = zh ? ACTION_LABEL_ZH : ACTION_LABEL_EN
  const stepLines = [...snapshot.activeSteps, ...snapshot.recentSteps]
    .slice(0, 8)
    .map(
      (step) =>
        `- ${step.status === "completed" ? "✅" : step.status === "failed" ? "❌" : "⏳"} ${clamp(step.title, 240)}`
    )
  const progress = snapshot.progress.trustworthy
    ? `${snapshot.progress.completed}/${snapshot.progress.total}${
        snapshot.progress.ratio === undefined
          ? ""
          : ` · ${Math.round(snapshot.progress.ratio * 100)}%`
      }`
    : `${snapshot.progress.completed} steps completed`
  const details = [
    `**${statusLabel[snapshot.status]}** · ${progress} · ${Math.floor(snapshot.elapsedMs / 1_000)}s`,
    clamp(snapshot.waitingReason ?? snapshot.error ?? snapshot.summary, 4_000),
    ...stepLines,
    snapshot.pendingStepCount > 0 ? `_${snapshot.pendingStepCount} more pending_` : undefined,
    snapshot.connectorQueueDepth !== undefined
      ? zh
        ? `队列深度：${snapshot.connectorQueueDepth}`
        : `Queue depth: ${snapshot.connectorQueueDepth}`
      : undefined,
    ...snapshot.artifacts
      .slice(0, 4)
      .map((artifact) =>
        artifact.url ? `[${artifact.title}](${artifact.url})` : `📎 ${artifact.title}`
      ),
  ].filter(Boolean)
  const actions = snapshot.allowedActions.slice(0, 5).map((action) => ({
    tag: "button",
    text: { tag: "plain_text", content: actionLabel[action] },
    type:
      action === "approve"
        ? "primary"
        : action === "deny" || action === "stop"
          ? "danger"
          : "default",
    behaviors:
      action === "open_details"
        ? [
            {
              type: "open_url",
              default_url: snapshot.detailsUrl ?? `cognia://execution-runs/${snapshot.runId}`,
            },
          ]
        : [
            {
              type: "callback",
              value: {
                actionId: `run:${snapshot.runId}:${action}:${snapshot.revision}`,
                surfaceId: `execution-run:${snapshot.runId}`,
                componentId: `run-action-${action}`,
                action,
                runId: snapshot.runId,
                revision: snapshot.revision,
                ...(snapshot.pendingInterrupt ? { interruptId: snapshot.pendingInterrupt.id } : {}),
              },
            },
          ],
  }))
  return {
    schema: "2.0",
    config: {
      update_multi: true,
      streaming_mode: streaming,
      summary: { content: `${snapshot.title}: ${statusLabel[snapshot.status]}` },
      streaming_config: {
        print_frequency_ms: { default: 70, android: 70, ios: 70, pc: 70 },
        print_step: { default: 1, android: 1, ios: 1, pc: 1 },
        print_strategy: "fast",
      },
    },
    header: {
      title: { tag: "plain_text", content: clamp(snapshot.title, 240) },
      template:
        snapshot.status === "failed" ? "red" : snapshot.status === "completed" ? "green" : "blue",
    },
    body: {
      elements: [
        { tag: "markdown", content: details.join("\n\n"), element_id: SUMMARY_ELEMENT_ID },
        ...(actions.length > 0
          ? [{ tag: "action", layout: "bisected", actions, element_id: ACTIONS_ELEMENT_ID }]
          : []),
      ],
    },
  }
}

function serializeCard(snapshot: RunProjectionSnapshot, streaming: boolean): string {
  let json = JSON.stringify(cardJson(snapshot, streaming))
  if (new TextEncoder().encode(json).byteLength <= CARD_LIMIT_BYTES) return json
  json = JSON.stringify(
    cardJson(
      {
        ...snapshot,
        summary: `${clamp(snapshot.summary, 1_000) ?? "Run details"} (truncated)`,
        activeSteps: snapshot.activeSteps.slice(0, 2),
        recentSteps: [],
        artifacts: [],
      },
      streaming
    )
  )
  if (new TextEncoder().encode(json).byteLength > CARD_LIMIT_BYTES) {
    throw new Error("Lark CardKit projection exceeds 30KB after safe trimming")
  }
  return json
}

function summaryContent(snapshot: RunProjectionSnapshot): string {
  const card = cardJson(snapshot, true) as {
    body: { elements: Array<{ content?: string }> }
  }
  return card.body.elements[0]?.content ?? ""
}

function actionsElement(snapshot: RunProjectionSnapshot): Record<string, unknown> {
  const card = cardJson(snapshot, true) as {
    body: { elements: Array<Record<string, unknown> & { element_id?: string }> }
  }
  return (
    card.body.elements.find((element) => element.element_id === ACTIONS_ELEMENT_ID) ?? {
      tag: "action",
      layout: "bisected",
      actions: [],
      element_id: ACTIONS_ELEMENT_ID,
    }
  )
}

function followUpItems(snapshot: RunProjectionSnapshot): FollowUpControlItem[] {
  const actionable = snapshot.allowedActions
    .filter((action) => action !== "open_details")
    .slice(0, 2)
    .map((action) => ({
      action,
      content: ACTION_LABEL_EN[action],
      localizedContent: ACTION_LABEL_ZH[action],
      ...(snapshot.pendingInterrupt ? { interruptId: snapshot.pendingInterrupt.id } : {}),
    }))
  return [
    ...actionable,
    { action: "status" as const, content: "View status", localizedContent: "查看状态" },
  ].slice(0, 3)
}

function state(ref: RunPresentationRef): LarkCardState {
  const cardId = ref.opaqueState?.cardId
  const lastAcknowledgedSequence =
    ref.opaqueState?.lastAcknowledgedSequence ?? ref.opaqueState?.sequence
  const cardCreatedAt = ref.opaqueState?.[CARD_CREATED_AT_KEY]
  const target = ref.opaqueState?.target
  const elementIds = ref.opaqueState?.elementIds
  const pendingMutation = ref.opaqueState?.pendingMutation
  if (
    typeof cardId !== "string" ||
    typeof lastAcknowledgedSequence !== "number" ||
    typeof cardCreatedAt !== "number" ||
    !target ||
    typeof target !== "object"
  ) {
    throw new Error("Invalid Lark CardKit presentation reference")
  }
  return {
    cardId,
    lastAcknowledgedSequence,
    cardCreatedAt,
    target: target as RunPresentationTarget,
    elementIds:
      elementIds && typeof elementIds === "object"
        ? (elementIds as LarkCardState["elementIds"])
        : { summary: SUMMARY_ELEMENT_ID, actions: ACTIONS_ELEMENT_ID },
    ...(pendingMutation && typeof pendingMutation === "object"
      ? { pendingMutation: pendingMutation as PendingCardMutation }
      : {}),
    hasActions:
      typeof ref.opaqueState?.hasActions === "boolean" ? ref.opaqueState.hasActions : false,
  }
}

function errorCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === "number" ? code : undefined
}

function sendTarget(target: RunPresentationTarget): ConversationDeliveryTarget {
  if (!target.deliveryTarget) {
    throw new Error("Lark run presentation requires a persisted delivery target")
  }
  return target.deliveryTarget
}

export function createLarkRunPresentationDriver(
  request: LarkRunRequest,
  options: LarkRunPresentationDriverOptions = {}
): RunPresentationDriver {
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
  const now = options.now ?? Date.now

  async function requestMutation(mutation: PendingCardMutation): Promise<void> {
    let lastError: unknown
    for (let attempt = 0; attempt < MAX_MUTATION_ATTEMPTS; attempt += 1) {
      try {
        await request(mutation.method, mutation.path, mutation.body)
        return
      } catch (error) {
        lastError = error
        const code = errorCode(error)
        if ([200740, 200750, 300317].includes(code ?? -1)) throw error
        if (code !== undefined && code !== 200810 && code !== 230002 && code !== 99991400) {
          throw error
        }
        if (attempt + 1 >= MAX_MUTATION_ATTEMPTS) break
        await sleep(code === 200810 ? 150 * (attempt + 1) : 100 * 2 ** attempt)
      }
    }
    throw lastError
  }

  async function sendCard(
    target: RunPresentationTarget,
    cardId: string,
    snapshot: RunProjectionSnapshot
  ): Promise<string | undefined> {
    const delivery = sendTarget(target)
    const content = JSON.stringify({ type: "card", data: { card_id: cardId } })
    const uuid = deterministicUuid(
      `card-send:${snapshot.runId}:${delivery.address.conversationKey}`
    )
    if (delivery.address.topicId) {
      const anchor = delivery.sourceMessageId ?? target.sourceMessageId
      if (!anchor) throw new Error("Lark topic presentation has no valid reply anchor")
      const sent = (await request("POST", `/im/v1/messages/${encodeURIComponent(anchor)}/reply`, {
        msg_type: "interactive",
        content,
        reply_in_thread: true,
        uuid,
      })) as { data?: { message_id?: string } }
      return sent.data?.message_id
    }
    const sent = (await request("POST", "/im/v1/messages?receive_id_type=chat_id", {
      receive_id: delivery.address.containerId,
      msg_type: "interactive",
      content,
      uuid,
    })) as { data?: { message_id?: string } }
    return sent.data?.message_id
  }

  async function ensureFollowUpControl(
    ref: RunPresentationRef,
    target: RunPresentationTarget,
    snapshot: RunProjectionSnapshot,
    checkpoint?: (ref: RunPresentationRef) => Promise<void>
  ): Promise<RunPresentationRef> {
    const platformMessageId = ref.platformMessageId
    if (
      !platformMessageId ||
      target.deliveryTarget?.address.scopeKind !== "private" ||
      snapshot.allowedActions.length === 0 ||
      ref.opaqueState?.followUpControl
    ) {
      return ref
    }
    const pending = ref.opaqueState?.pendingFollowUpControl as FollowUpControlState | undefined
    const createdAt = now()
    const followUpControl: FollowUpControlState = pending ?? {
      platformMessageId,
      runId: snapshot.runId,
      revision: snapshot.revision,
      createdAt,
      expiresAt: createdAt + 600_000,
      items: followUpItems(snapshot),
    }
    const pendingRef: RunPresentationRef = {
      ...ref,
      opaqueState: { ...ref.opaqueState, pendingFollowUpControl: followUpControl },
    }
    await checkpoint?.(pendingRef)
    try {
      await request(
        "POST",
        `/im/v1/messages/${encodeURIComponent(platformMessageId)}/push_follow_up`,
        {
          follow_ups: followUpControl.items.map((item) => ({
            content: item.content,
            i18n_contents: [
              { language: "zh_cn", content: item.localizedContent },
              { language: "en_us", content: item.content },
            ],
          })),
        }
      )
      const acknowledged = {
        ...ref,
        opaqueState: {
          ...ref.opaqueState,
          pendingFollowUpControl: undefined,
          followUpFallbackReason: undefined,
          followUpControl,
        },
      }
      await checkpoint?.(acknowledged)
      return acknowledged
    } catch (error) {
      const code = errorCode(error)
      if (code === 230008) {
        const reconciled = {
          ...ref,
          opaqueState: {
            ...ref.opaqueState,
            pendingFollowUpControl: undefined,
            followUpFallbackReason: undefined,
            followUpControl,
          },
        }
        await checkpoint?.(reconciled)
        return reconciled
      }
      const degraded = {
        ...ref,
        opaqueState: {
          ...ref.opaqueState,
          ...(code === undefined ? { pendingFollowUpControl: followUpControl } : {}),
          followUpFallbackReason:
            code === undefined ? "delivery_unknown" : `lark_follow_up_${code}`,
        },
      }
      await checkpoint?.(degraded)
      return degraded
    }
  }

  async function openCard(
    target: RunPresentationTarget,
    snapshot: RunProjectionSnapshot,
    checkpoint?: (ref: RunPresentationRef) => Promise<void>,
    previousRef?: RunPresentationRef
  ): Promise<RunPresentationRef> {
    const previousCreate = previousRef?.opaqueState?.pendingCreate as PendingCardCreate | undefined
    const pendingCreate: PendingCardCreate = previousCreate ?? {
      uuid: deterministicUuid(`card-create:${snapshot.runId}:${target.conversationKey}`),
      target,
      createdAt: now(),
    }
    await checkpoint?.({
      ...previousRef,
      opaqueState: { ...previousRef?.opaqueState, pendingCreate },
    })
    const created = (await request("POST", "/cardkit/v1/cards", {
      type: "card_json",
      data: serializeCard(snapshot, true),
      uuid: pendingCreate.uuid,
    })) as { data?: { card_id?: string } }
    const cardId = created.data?.card_id
    if (!cardId) throw new Error("Lark CardKit create response omitted card_id")
    const provisional: RunPresentationRef = {
      opaqueState: {
        cardId,
        lastAcknowledgedSequence: 0,
        [CARD_CREATED_AT_KEY]: now(),
        elementIds: { summary: SUMMARY_ELEMENT_ID, actions: ACTIONS_ELEMENT_ID },
        target,
        hasActions: snapshot.allowedActions.length > 0,
        pendingCreate: undefined,
      },
    }
    await checkpoint?.(provisional)
    const platformMessageId = await sendCard(target, cardId, snapshot)
    const result = await ensureFollowUpControl(
      { ...provisional, platformMessageId },
      target,
      snapshot,
      checkpoint
    )
    await checkpoint?.(result)
    return result
  }

  async function mutate(
    ref: RunPresentationRef,
    snapshot: RunProjectionSnapshot,
    operation: PendingCardMutation["operation"],
    checkpoint?: (ref: RunPresentationRef) => Promise<void>
  ): Promise<RunPresentationRef> {
    const current = state(ref)
    if (now() - current.cardCreatedAt >= 14 * 24 * 60 * 60 * 1_000) {
      return openCard(current.target, snapshot, checkpoint)
    }
    const sequence = current.lastAcknowledgedSequence + 1
    const mutationUuid = (kind: string) =>
      deterministicUuid(`card-mutation:${snapshot.runId}:${sequence}:${kind}`)
    const desired: PendingCardMutation =
      operation === "stream_summary"
        ? {
            sequence,
            uuid: mutationUuid("summary"),
            operation,
            method: "PUT",
            path: `/cardkit/v1/cards/${current.cardId}/elements/${current.elementIds.summary}/content`,
            body: {
              content: summaryContent(snapshot),
              sequence,
              uuid: mutationUuid("summary"),
            },
          }
        : operation === "update_actions"
          ? {
              sequence,
              uuid: mutationUuid("actions"),
              operation,
              method: "PUT",
              path: `/cardkit/v1/cards/${current.cardId}/elements/${current.elementIds.actions}`,
              body: {
                element: actionsElement(snapshot),
                sequence,
                uuid: mutationUuid("actions"),
              },
            }
          : {
              sequence,
              uuid: mutationUuid("replace"),
              operation,
              method: "PUT",
              path: `/cardkit/v1/cards/${current.cardId}`,
              body: {
                card: { type: "card_json", data: serializeCard(snapshot, false) },
                sequence,
                uuid: mutationUuid("replace"),
              },
            }
    const pending = current.pendingMutation ?? desired
    const pendingRef: RunPresentationRef = {
      ...ref,
      opaqueState: { ...ref.opaqueState, pendingMutation: pending },
    }
    await checkpoint?.(pendingRef)
    try {
      await requestMutation(pending)
    } catch (error) {
      if ([200740, 200750, 300317].includes(errorCode(error) ?? -1)) {
        return openCard(current.target, snapshot, checkpoint)
      }
      throw error
    }
    const acknowledged: RunPresentationRef = {
      ...ref,
      opaqueState: {
        ...ref.opaqueState,
        lastAcknowledgedSequence: pending.sequence,
        pendingMutation: undefined,
        hasActions: snapshot.allowedActions.length > 0,
      },
    }
    await checkpoint?.(acknowledged)
    if (
      pending.operation !== desired.operation ||
      JSON.stringify(pending.body) !== JSON.stringify(desired.body)
    ) {
      return mutate(acknowledged, snapshot, operation, checkpoint)
    }
    return acknowledged
  }

  return {
    capabilities: {
      topicIsolation: true,
      textStreaming: true,
      componentMutation: true,
      fullReplacement: true,
      messageEditing: true,
      appendFallback: true,
      interactiveControls: true,
      followUpBubbles: true,
    },
    async open(target, snapshot, options) {
      const provisional = options?.previousRef
      if (!provisional?.opaqueState?.cardId) {
        return openCard(target, snapshot, options?.checkpoint, provisional)
      }
      if (provisional.platformMessageId) {
        const current = state(provisional)
        return ensureFollowUpControl(provisional, current.target, snapshot, options?.checkpoint)
      }
      const current = state(provisional)
      const platformMessageId = await sendCard(current.target, current.cardId, snapshot)
      const result: RunPresentationRef = {
        platformMessageId,
        opaqueState: provisional.opaqueState,
      }
      await options?.checkpoint?.(result)
      return ensureFollowUpControl(result, current.target, snapshot, options?.checkpoint)
    },
    async update(ref, snapshot, mutationOptions) {
      const current = state(ref)
      if (current.hasActions !== snapshot.allowedActions.length > 0) {
        return mutate(ref, snapshot, "replace_card", mutationOptions?.checkpoint)
      }
      const streamed = await mutate(ref, snapshot, "stream_summary", mutationOptions?.checkpoint)
      if (snapshot.allowedActions.length === 0) return streamed
      return mutate(streamed, snapshot, "update_actions", mutationOptions?.checkpoint)
    },
    finish(ref, snapshot, mutationOptions) {
      return mutate(ref, snapshot, "replace_card", mutationOptions?.checkpoint)
    },
  }
}
