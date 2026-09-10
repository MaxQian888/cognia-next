import type { MessageSegment } from "@/types/connectors/segment"
import { buildRunDetailsUrl } from "@/lib/connectors/entry/deep-links"
import type {
  RunControlAction,
  RunPresentationDriver,
  RunPresentationRef,
  RunPresentationTarget,
  RunProjectionSnapshot,
} from "@/types/execution/run"
import type { ConversationDeliveryTarget } from "@/types/connectors/event"
import {
  formatRunActivityTimeline,
  runTitleForPresentation,
} from "@/lib/connectors/activity/activity-to-a2ui"
import { resolveActivityI18n } from "@/lib/connectors/activity/i18n"
import { sanitizeActivityLabel, safeStableActivityId } from "@/lib/execution/run-activity"
import {
  buildFollowUpItems,
  followUpHintLine,
  RUN_ACTION_LABEL_EN,
  RUN_ACTION_LABEL_ZH,
} from "./follow-up-items"
import { hasNoLeakingPiiDeep } from "@cognia/redact"

type LarkMethod = "POST" | "PUT" | "PATCH" | "DELETE"
export type LarkRunRequest = (method: LarkMethod, path: string, body: unknown) => Promise<unknown>

const CARD_LIMIT_BYTES = 30_000
const CARD_CREATED_AT_KEY = "cardCreatedAt"
const SUMMARY_ELEMENT_ID = "run_summary"
const ACTIONS_ELEMENT_ID = "run_actions"
const MAX_MUTATION_ATTEMPTS = 3
const MUTATION_SAFETY_VERSION = 1

interface PendingCardMutation {
  safetyVersion: typeof MUTATION_SAFETY_VERSION
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

function isSafePendingMutation(
  value: unknown,
  cardId: string,
  elementIds: LarkCardState["elementIds"]
): value is PendingCardMutation {
  if (!value || typeof value !== "object") return false
  const mutation = value as Partial<PendingCardMutation>
  const expectedPath =
    mutation.operation === "stream_summary"
      ? `/cardkit/v1/cards/${cardId}/elements/${elementIds.summary}/content`
      : mutation.operation === "update_actions"
        ? `/cardkit/v1/cards/${cardId}/elements/${elementIds.actions}`
        : mutation.operation === "replace_card"
          ? `/cardkit/v1/cards/${cardId}`
          : undefined
  return (
    mutation.safetyVersion === MUTATION_SAFETY_VERSION &&
    Number.isSafeInteger(mutation.sequence) &&
    typeof mutation.uuid === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/i.test(mutation.uuid) &&
    mutation.method === "PUT" &&
    mutation.path === expectedPath &&
    !!mutation.body &&
    typeof mutation.body === "object" &&
    hasNoLeakingPiiDeep(mutation.body)
  )
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
  statusReactions?: boolean
  webEntryBaseUrl?: string | null
}

// Shared with the generic fallback path, which registers the same verbs so
// run control is not a one-platform feature.
const ACTION_LABEL_EN = RUN_ACTION_LABEL_EN
const ACTION_LABEL_ZH = RUN_ACTION_LABEL_ZH

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

/** A bounded native dependency map; no inferred links or headless image process. */
function workflowElements(snapshot: RunProjectionSnapshot): Record<string, unknown>[] {
  const graph = snapshot.workflowGraph
  if (!graph?.nodes.length) return []
  const zh = snapshot.locale?.toLowerCase().startsWith("zh") === true
  const i18n = resolveActivityI18n(snapshot.locale)
  const marks = {
    pending: "○",
    in_progress: "▶",
    completed: "✓",
    failed: "✕",
    skipped: "⊘",
    blocked: "⏸",
  }
  const nodes = graph.nodes.slice(0, 16)
  const index = new Map(graph.nodes.map((node, i) => [node.id, i + 1]))
  const rows: Record<string, unknown>[] = []
  for (let i = 0; i < nodes.length; i += 2) {
    rows.push({
      tag: "column_set",
      columns: nodes.slice(i, i + 2).map((node) => ({
        tag: "column",
        width: "weighted",
        weight: 1,
        elements: [
          {
            tag: "markdown",
            content: `**${index.get(node.id)} · ${marks[node.status] ?? "○"} ${sanitizeActivityLabel(
              node.title,
              "Step"
            )
              .replace(/([\\`*_\[\]])/g, "\\$1")
              .replace(/</g, "&lt;")
              .replace(/>/g, "&gt;")}**\n${i18n.milestoneStatus(node.status)}`,
          },
        ],
      })),
    })
  }
  const edges = graph.edges.filter((edge) => index.has(edge.source) && index.has(edge.target))
  rows.push({
    tag: "markdown",
    content: `${zh ? "依赖关系" : "Dependencies"}: ${
      edges
        .slice(0, 24)
        .map((edge) => `${index.get(edge.source)} → ${index.get(edge.target)}`)
        .join(" · ") || (zh ? "无节点间依赖" : "No dependencies between nodes")
    }`,
  })
  if (graph.nodes.length > 16 || edges.length > 24)
    rows.push({
      tag: "markdown",
      content: zh
        ? "仅展示部分节点与连线，请打开完整工作流。"
        : "Partial graph shown. Open the full workflow for all nodes and connections.",
    })
  return [{ tag: "markdown", content: `**${zh ? "工作流总览" : "Workflow overview"}**` }, ...rows]
}

function graphSignature(snapshot: RunProjectionSnapshot): string {
  const graph = snapshot.workflowGraph
  return graph
    ? JSON.stringify([
        graph.workflowId,
        graph.sourceRunId,
        graph.nodes.map(({ id, title, status }) => [id, title, status]),
        graph.edges,
      ])
    : ""
}

function cardJson(
  snapshot: RunProjectionSnapshot,
  streaming: boolean,
  webBase?: string | null
): Record<string, unknown> {
  const safeRunId = safeStableActivityId(snapshot.runId)
  const zh = snapshot.locale?.toLowerCase().startsWith("zh") === true
  const i18n = resolveActivityI18n(snapshot.locale)
  const statusLabel = i18n.runStatus(snapshot.status)
  const title = runTitleForPresentation(snapshot, i18n)
  const actionLabel = zh ? ACTION_LABEL_ZH : ACTION_LABEL_EN
  const details = summaryContent(snapshot)
  const runUrl = buildRunDetailsUrl(safeRunId, webBase)
  const detailsUrl =
    runUrl && snapshot.workflowGraph
      ? (() => {
          const url = new URL(runUrl)
          url.pathname = url.pathname.replace(/agent-runs$/, "workflows/run")
          url.search = ""
          url.searchParams.set("id", snapshot.workflowGraph.workflowId)
          url.searchParams.set("runId", snapshot.workflowGraph.sourceRunId)
          return url.href
        })()
      : runUrl
  const actions = snapshot.allowedActions
    .filter((action) => action !== "open_details" || detailsUrl)
    .slice(0, 5)
    .map((action) => ({
      tag: "button",
      text: {
        tag: "plain_text",
        content:
          action === "open_details" && snapshot.workflowGraph
            ? zh
              ? "完整工作流"
              : "Full workflow"
            : actionLabel[action],
      },
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
                default_url: detailsUrl!,
              },
            ]
          : [
              {
                type: "callback",
                value: {
                  actionId: `run:${safeRunId}:${action}:${snapshot.revision}`,
                  surfaceId: `execution-run:${safeRunId}`,
                  componentId: `run-action-${action}`,
                  action,
                  runId: safeRunId,
                  revision: snapshot.revision,
                  ...(snapshot.pendingInterrupt
                    ? { interruptId: safeStableActivityId(snapshot.pendingInterrupt.id) }
                    : {}),
                },
              },
            ],
    }))
  return {
    schema: "2.0",
    config: {
      update_multi: true,
      streaming_mode: streaming,
      summary: { content: `${title}: ${statusLabel}` },
      streaming_config: {
        print_frequency_ms: { default: 70, android: 70, ios: 70, pc: 70 },
        print_step: { default: 1, android: 1, ios: 1, pc: 1 },
        print_strategy: "fast",
      },
    },
    header: {
      title: { tag: "plain_text", content: `${clamp(title, 180)} · ${statusLabel}` },
      template:
        snapshot.status === "completed"
          ? "green"
          : snapshot.status === "failed"
            ? "red"
            : ["waiting", "paused", "recovery_required"].includes(snapshot.status)
              ? "orange"
              : "blue",
      padding: "12px 16px 12px 16px",
    },
    body: {
      padding: "16px",
      vertical_spacing: "12px",
      elements: [
        ...workflowElements(snapshot),
        {
          tag: "collapsible_panel",
          element_id: "run_progress",
          expanded: !snapshot.workflowGraph,
          padding: "12px",
          vertical_spacing: "12px",
          header: {
            title: {
              tag: "plain_text",
              content:
                snapshot.kind === "workflow"
                  ? zh
                    ? "节点与执行活动"
                    : "Nodes and activity"
                  : zh
                    ? "执行过程"
                    : "Execution activity",
            },
            background_color: "grey-100",
            padding: "12px",
            icon: { tag: "standard_icon", token: "down-small-ccm_outlined", size: "16px 16px" },
            icon_position: "right",
          },
          border: { color: "grey-200", corner_radius: "8px" },
          elements: [{ tag: "markdown", content: details, element_id: SUMMARY_ELEMENT_ID }],
        },
        ...(actions.length > 0
          ? [
              {
                tag: "column_set",
                element_id: ACTIONS_ELEMENT_ID,
                columns: actions.map((button) => ({
                  tag: "column",
                  width: "weighted",
                  weight: 1,
                  elements: [button],
                })),
              },
            ]
          : []),
      ],
    },
  }
}

/** Keep fallback edits on the same Card 2.0 schema as native messages. */
export function buildLarkRunFallbackSegment(
  snapshot: RunProjectionSnapshot,
  webBase?: string | null
): MessageSegment {
  return { type: "card", card: { kind: "lark", payload: cardJson(snapshot, false, webBase) } }
}

function serializeCard(
  snapshot: RunProjectionSnapshot,
  streaming: boolean,
  webBase?: string | null
): string {
  let json = JSON.stringify(cardJson(snapshot, streaming, webBase))
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
      streaming,
      webBase
    )
  )
  if (new TextEncoder().encode(json).byteLength > CARD_LIMIT_BYTES) {
    throw new Error("Lark CardKit projection exceeds 30KB after safe trimming")
  }
  return json
}

function summaryContent(snapshot: RunProjectionSnapshot): string {
  const zh = snapshot.locale?.toLowerCase().startsWith("zh") === true
  const i18n = resolveActivityI18n(snapshot.locale)
  const escape = (value: string) =>
    value
      .replace(/([\\`*_\[\]])/g, "\\$1")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
  const safeLabel = (value: unknown, fallback: string) =>
    escape(sanitizeActivityLabel(value, fallback))
  const ratio = snapshot.progress.completed / snapshot.progress.total
  const bar =
    snapshot.progress.trustworthy && snapshot.progress.total > 0 && Number.isFinite(ratio)
      ? "■".repeat(Math.round(Math.max(0, Math.min(1, ratio)) * 10)) +
        "□".repeat(10 - Math.round(Math.max(0, Math.min(1, ratio)) * 10))
      : undefined
  const overview = `**${i18n.runStatus(snapshot.status)}** · ${zh ? "用时" : "Elapsed"} ${i18n.elapsed(Math.max(0, Math.round(snapshot.elapsedMs / 1000)))}`
  const waiting = snapshot.pendingInterrupt
    ? `**${zh ? "需要你的操作" : "Your action is needed"}**\n${zh ? "请使用下方按钮批准或拒绝，再继续执行。" : "Use the controls below to approve or deny before execution continues."}`
    : undefined
  const artifacts =
    snapshot.artifacts.length > 0
      ? `**${zh ? "产物" : "Artifacts"} · ${snapshot.artifacts.length}**\n` +
        snapshot.artifacts
          .slice(0, 5)
          .map((artifact) => `▣ ${safeLabel(artifact.title, "Artifact")}`)
          .join("\n")
      : undefined
  // Reuse the sanitized public timeline; raw tool payloads and errors are not
  // presentation data. The same element updates in place on every revision.
  const timeline = formatRunActivityTimeline(snapshot, i18n)
    .split("\n")
    .slice(1)
    .filter((line) => line !== "│")
    .join("\n\n")
  return [
    overview,
    bar,
    waiting,
    timeline,
    artifacts,
    followUpHintLine(buildFollowUpItems(snapshot), zh),
  ]
    .filter(Boolean)
    .join("\n\n")
}

function actionsElement(
  snapshot: RunProjectionSnapshot,
  webBase?: string | null
): Record<string, unknown> {
  const card = cardJson(snapshot, true, webBase) as {
    body: { elements: Array<Record<string, unknown> & { element_id?: string }> }
  }
  return (
    card.body.elements.find((element) => element.element_id === ACTIONS_ELEMENT_ID) ?? {
      tag: "column_set",
      columns: [],
      element_id: ACTIONS_ELEMENT_ID,
    }
  )
}

const followUpItems = buildFollowUpItems

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
  const resolvedElementIds =
    elementIds && typeof elementIds === "object"
      ? (elementIds as LarkCardState["elementIds"])
      : { summary: SUMMARY_ELEMENT_ID, actions: ACTIONS_ELEMENT_ID }
  return {
    cardId,
    lastAcknowledgedSequence,
    cardCreatedAt,
    target: target as RunPresentationTarget,
    elementIds: resolvedElementIds,
    ...(isSafePendingMutation(pendingMutation, cardId, resolvedElementIds)
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

  async function react(
    ref: RunPresentationRef,
    target: RunPresentationTarget,
    emoji: string,
    checkpoint?: (ref: RunPresentationRef) => Promise<void>
  ): Promise<RunPresentationRef> {
    const messageId = target.sourceMessageId ?? target.deliveryTarget?.sourceMessageId
    if (!options.statusReactions || !messageId) return ref
    const previous = ref.opaqueState?.statusReaction as { id: string; emoji: string } | undefined
    const cleanup = new Set((ref.opaqueState?.reactionCleanup as string[] | undefined) ?? [])
    let next = ref
    try {
      if (previous?.emoji !== emoji) {
        const response = (await request(
          "POST",
          `/im/v1/messages/${encodeURIComponent(messageId)}/reactions`,
          {
            reaction_type: { emoji_type: emoji },
          }
        )) as { data?: { reaction_id?: string } }
        const id = response.data?.reaction_id
        if (!id) return ref
        if (previous?.id && previous.id !== id) cleanup.add(previous.id)
        next = {
          ...ref,
          opaqueState: {
            ...ref.opaqueState,
            statusReaction: { id, emoji },
            reactionCleanup: [...cleanup],
          },
        }
        await checkpoint?.(next)
      }
      for (const id of cleanup) {
        try {
          await request(
            "DELETE",
            `/im/v1/messages/${encodeURIComponent(messageId)}/reactions/${encodeURIComponent(id)}`,
            {}
          )
          cleanup.delete(id)
        } catch {
          /* Retain the bot-owned id for the next mutation's cleanup. */
        }
      }
      if (
        cleanup.size !== ((next.opaqueState?.reactionCleanup as string[] | undefined)?.length ?? 0)
      ) {
        next = { ...next, opaqueState: { ...next.opaqueState, reactionCleanup: [...cleanup] } }
        await checkpoint?.(next)
      }
      return next
    } catch {
      // A missing reaction scope must not prevent the answer or status card.
      return next
    }
  }

  const reactionFor = (snapshot: RunProjectionSnapshot): string =>
    ({
      queued: "Get",
      running: "OnIt",
      waiting: "THINKING",
      paused: "OneSecond",
      recovery_required: "ERROR",
      completed: "DONE",
      failed: "ERROR",
      cancelled: "ENOUGH",
    })[snapshot.status]

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
    if (platformMessageId && target.deliveryTarget?.address.scopeKind === "thread") {
      const next = {
        ...ref,
        opaqueState: {
          ...ref.opaqueState,
          followUpControl: {
            platformMessageId,
            runId: snapshot.runId,
            revision: snapshot.revision,
            createdAt: now(),
            expiresAt: now() + 600_000,
            items: followUpItems(snapshot),
          },
        },
      }
      await checkpoint?.(next)
      return next
    }
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
      data: serializeCard(snapshot, true, options.webEntryBaseUrl),
      uuid: pendingCreate.uuid,
    })) as { data?: { card_id?: string } }
    const cardId = created.data?.card_id
    if (!cardId) throw new Error("Lark CardKit create response omitted card_id")
    const provisional: RunPresentationRef = {
      opaqueState: {
        ...previousRef?.opaqueState,
        cardId,
        lastAcknowledgedSequence: 0,
        [CARD_CREATED_AT_KEY]: now(),
        elementIds: { summary: SUMMARY_ELEMENT_ID, actions: ACTIONS_ELEMENT_ID },
        target,
        hasActions: snapshot.allowedActions.length > 0,
        presentedStatus: snapshot.status,
        presentedGraph: graphSignature(snapshot),
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
            safetyVersion: MUTATION_SAFETY_VERSION,
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
              safetyVersion: MUTATION_SAFETY_VERSION,
              sequence,
              uuid: mutationUuid("actions"),
              operation,
              method: "PUT",
              path: `/cardkit/v1/cards/${current.cardId}/elements/${current.elementIds.actions}`,
              body: {
                element: JSON.stringify(actionsElement(snapshot, options.webEntryBaseUrl)),
                sequence,
                uuid: mutationUuid("actions"),
              },
            }
          : {
              safetyVersion: MUTATION_SAFETY_VERSION,
              sequence,
              uuid: mutationUuid("replace"),
              operation,
              method: "PUT",
              path: `/cardkit/v1/cards/${current.cardId}`,
              body: {
                card: {
                  type: "card_json",
                  data: serializeCard(
                    snapshot,
                    snapshot.status === "running" || snapshot.status === "queued",
                    options.webEntryBaseUrl
                  ),
                },
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
      if (errorCode(error) === 300309 && pending.operation === "stream_summary") {
        // Streaming may already be closed on a persisted/recovered card.
        // Retire the rejected operation and repair this SAME card with JSON 2.0.
        return mutate(
          {
            ...ref,
            opaqueState: {
              ...ref.opaqueState,
              pendingMutation: undefined,
              lastAcknowledgedSequence: pending.sequence,
            },
          },
          snapshot,
          "replace_card",
          checkpoint
        )
      }
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
        ...(pending.operation === "replace_card"
          ? { presentedStatus: snapshot.status, presentedGraph: graphSignature(snapshot) }
          : {}),
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
      const provisional = await react(
        options?.previousRef ?? {},
        target,
        "Get",
        options?.checkpoint
      )
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
      ref = await ensureFollowUpControl(
        ref,
        state(ref).target,
        snapshot,
        mutationOptions?.checkpoint
      )
      ref = await react(ref, state(ref).target, reactionFor(snapshot), mutationOptions?.checkpoint)
      const current = state(ref)
      if (
        !["running", "queued"].includes(snapshot.status) ||
        current.hasActions !== snapshot.allowedActions.length > 0 ||
        ref.opaqueState?.presentedStatus !== snapshot.status ||
        (ref.opaqueState?.presentedGraph ?? "") !== graphSignature(snapshot)
      ) {
        return mutate(ref, snapshot, "replace_card", mutationOptions?.checkpoint)
      }
      const streamed = await mutate(ref, snapshot, "stream_summary", mutationOptions?.checkpoint)
      if (snapshot.allowedActions.length === 0) return streamed
      return mutate(streamed, snapshot, "update_actions", mutationOptions?.checkpoint)
    },
    async finish(ref, snapshot, mutationOptions) {
      ref = await ensureFollowUpControl(
        ref,
        state(ref).target,
        snapshot,
        mutationOptions?.checkpoint
      )
      ref = await react(ref, state(ref).target, reactionFor(snapshot), mutationOptions?.checkpoint)
      return mutate(ref, snapshot, "replace_card", mutationOptions?.checkpoint)
    },
  }
}
