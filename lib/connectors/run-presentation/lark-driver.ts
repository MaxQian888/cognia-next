import {
  DEFAULT_LARK_CARD_PRESENTATION,
  normalizeLarkCardPresentation,
  larkCardBodyStyle,
  larkCardHeaderTheme,
  larkCardConfigStyle,
  larkCardHeaderExtras,
  larkCardMarkdownStyle,
  larkCardPanelStyle,
  type LarkCardPresentation,
} from "@/lib/connectors/adapters/lark/card-presentation"
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
import {
  createLarkCotClient,
  createLarkCotProjectionState,
  isLarkCotKnownUnsupported,
  isLarkCotProjectionState,
  isLarkCotUnsupportedError,
  projectLarkCotEvents,
  rememberLarkCotUnsupported,
} from "./lark-cot"
import type { LarkCotProjectionState } from "./lark-cot"
import { hasNoLeakingPiiDeep } from "@cognia/redact"

type LarkMethod = "POST" | "PUT" | "PATCH" | "DELETE"
export type LarkRunRequest = (method: LarkMethod, path: string, body: unknown) => Promise<unknown>

const CARD_LIMIT_BYTES = 30_000
const CARD_CREATED_AT_KEY = "cardCreatedAt"
const SUMMARY_ELEMENT_ID = "run_summary"
const STATUS_ELEMENT_ID = "run_status"
const ACTIONS_ELEMENT_ID = "run_actions"
const CARD_LAYOUT_VERSION = 2
const MAX_MUTATION_ATTEMPTS = 3
const MUTATION_SAFETY_VERSION = 1

interface PendingCardMutation {
  safetyVersion: typeof MUTATION_SAFETY_VERSION
  sequence: number
  uuid: string
  operation:
    | "stream_summary"
    | "update_summary"
    | "update_status"
    | "update_actions"
    | "replace_card"
    | "batch_update"
  method: "PUT" | "POST"
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
    mutation.operation === "batch_update"
      ? `/cardkit/v1/cards/${cardId}/batch_update`
      : mutation.operation === "stream_summary"
        ? `/cardkit/v1/cards/${cardId}/elements/${elementIds.summary}/content`
        : mutation.operation === "update_summary"
          ? `/cardkit/v1/cards/${cardId}/elements/${elementIds.summary}`
          : mutation.operation === "update_actions"
            ? `/cardkit/v1/cards/${cardId}/elements/${elementIds.actions}`
            : mutation.operation === "update_status"
              ? `/cardkit/v1/cards/${cardId}/elements/${STATUS_ELEMENT_ID}`
              : mutation.operation === "replace_card"
                ? `/cardkit/v1/cards/${cardId}`
                : undefined
  return (
    mutation.safetyVersion === MUTATION_SAFETY_VERSION &&
    Number.isSafeInteger(mutation.sequence) &&
    typeof mutation.uuid === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/i.test(mutation.uuid) &&
    mutation.method === (mutation.operation === "batch_update" ? "POST" : "PUT") &&
    mutation.path === expectedPath &&
    !!mutation.body &&
    typeof mutation.body === "object" &&
    hasNoLeakingPiiDeep(mutation.body)
  )
}

/**
 * The COT projection persisted under `ref.opaqueState.cot`: either an active
 * handle + diff state, or the reason the feature is off for this run.
 */
type LarkCotOpaqueState =
  | { status: "active"; cotId: string; messageId: string; projection: LarkCotProjectionState }
  | { status: "disabled"; reason: string }

/**
 * Read `ref.opaqueState.cot` the same defensive way `state()` reads
 * `pendingMutation`: a malformed persisted shape is treated as disabled with
 * reason `invalid_state` rather than trusted for a diff or re-probe.
 * `undefined` means COT was never attempted — distinct from disabled.
 */
function cotOpaqueState(ref: RunPresentationRef | undefined): LarkCotOpaqueState | undefined {
  const raw = ref?.opaqueState?.cot
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== "object") return { status: "disabled", reason: "invalid_state" }
  const cot = raw as Record<string, unknown>
  if (cot.status === "disabled" && typeof cot.reason === "string") {
    return { status: "disabled", reason: cot.reason }
  }
  if (
    cot.status === "active" &&
    typeof cot.cotId === "string" &&
    typeof cot.messageId === "string" &&
    isLarkCotProjectionState(cot.projection)
  ) {
    return {
      status: "active",
      cotId: cot.cotId,
      messageId: cot.messageId,
      projection: cot.projection,
    }
  }
  return { status: "disabled", reason: "invalid_state" }
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
  /**
   * Write the run's process timeline to a native COT message
   * (`im/v1/message_cot`) created right before the card. On by default; any
   * COT failure degrades to the card-only presentation without failing the
   * run. Pass `false` to disable the feature entirely.
   */
  cot?: boolean
  presentation?: Partial<LarkCardPresentation>
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
  webBase?: string | null,
  cotActive = false,
  presentation: LarkCardPresentation = DEFAULT_LARK_CARD_PRESENTATION
): Record<string, unknown> {
  const safeRunId = safeStableActivityId(snapshot.runId)
  const zh = snapshot.locale?.toLowerCase().startsWith("zh") === true
  const i18n = resolveActivityI18n(snapshot.locale)
  const statusLabel = i18n.runStatus(snapshot.status)
  const title = presentation.title || runTitleForPresentation(snapshot, i18n)
  const actionLabel = zh ? ACTION_LABEL_ZH : ACTION_LABEL_EN
  const details = summaryContent(snapshot, cotActive, presentation)
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
      ...larkCardConfigStyle(presentation),
      width_mode: presentation.width,
      streaming_mode: streaming,
      summary: { content: `${title}: ${statusLabel}` },
      streaming_config: {
        print_frequency_ms: { default: 70, android: 70, ios: 70, pc: 70 },
        print_step: { default: 1, android: 1, ios: 1, pc: 1 },
        print_strategy: "fast",
      },
    },
    header: {
      ...larkCardHeaderExtras(presentation),
      title: { tag: "plain_text", content: `${clamp(title, 180)} · ${statusLabel}` },
      template: larkCardHeaderTheme(
        presentation,
        snapshot.status === "completed"
          ? "green"
          : snapshot.status === "failed"
            ? "red"
            : ["waiting", "paused", "recovery_required"].includes(snapshot.status)
              ? "orange"
              : "blue"
      ),
      padding: "12px 16px 12px 16px",
    },
    body: {
      ...larkCardBodyStyle(presentation),
      elements: [
        ...(!cotActive ? [statusElement(snapshot, presentation)] : []),
        ...workflowElements(snapshot),
        // With a live COT message the process timeline renders there; the
        // panel collapses to a single summary element (same element_id, so
        // stream_summary mutations keep working). Without COT the collapsible
        // panel carries the full in-card timeline as before.
        cotActive
          ? {
              tag: "markdown",
              ...larkCardMarkdownStyle(presentation),
              content: details,
              element_id: SUMMARY_ELEMENT_ID,
            }
          : {
              tag: "collapsible_panel",
              element_id: "run_progress",
              expanded:
                presentation.history === "expanded" ||
                (presentation.history === "auto" &&
                  !snapshot.workflowGraph &&
                  !["completed", "cancelled"].includes(snapshot.status)),
              ...larkCardBodyStyle(presentation),
              ...larkCardPanelStyle(presentation),
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
                icon: {
                  tag: "standard_icon",
                  token: "down-small-ccm_outlined",
                  size: "16px 16px",
                },
                icon_position: "right",
              },
              border: { color: "grey-200", corner_radius: "8px" },
              elements: [
                {
                  tag: "markdown",
                  ...larkCardMarkdownStyle(presentation),
                  content: details,
                  element_id: SUMMARY_ELEMENT_ID,
                },
              ],
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
  webBase?: string | null,
  preferences?: unknown
): MessageSegment {
  return {
    type: "card",
    card: {
      kind: "lark",
      payload: cardJson(
        snapshot,
        false,
        webBase,
        false,
        normalizeLarkCardPresentation(preferences)
      ),
    },
  }
}

function serializeCard(
  snapshot: RunProjectionSnapshot,
  streaming: boolean,
  webBase?: string | null,
  cotActive = false,
  presentation: LarkCardPresentation = DEFAULT_LARK_CARD_PRESENTATION
): string {
  let json = JSON.stringify(cardJson(snapshot, streaming, webBase, cotActive, presentation))
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
      webBase,
      cotActive,
      presentation
    )
  )
  if (new TextEncoder().encode(json).byteLength > CARD_LIMIT_BYTES) {
    throw new Error("Lark CardKit projection exceeds 30KB after safe trimming")
  }
  return json
}

function summaryContent(
  snapshot: RunProjectionSnapshot,
  cotActive = false,
  presentation: LarkCardPresentation = DEFAULT_LARK_CARD_PRESENTATION
): string {
  if (cotActive) return statusContent(snapshot, true, presentation)
  // Keep elapsed time outside this element: heartbeats must not rewrite the
  // process history or disrupt the reader's position in the expanded panel.
  return formatRunActivityTimeline(snapshot, resolveActivityI18n(snapshot.locale))
    .split("\n")
    .slice(presentation.showProgress ? 1 : 2)
    .filter((line) => line !== "│")
    .join("\n\n")
}

function statusElement(
  snapshot: RunProjectionSnapshot,
  presentation: LarkCardPresentation = DEFAULT_LARK_CARD_PRESENTATION
): Record<string, unknown> {
  return {
    tag: "markdown",
    element_id: STATUS_ELEMENT_ID,
    ...larkCardMarkdownStyle(presentation),
    content: statusContent(snapshot, false, presentation),
  }
}

function statusContent(
  snapshot: RunProjectionSnapshot,
  cotActive = false,
  presentation: LarkCardPresentation = DEFAULT_LARK_CARD_PRESENTATION
): string {
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
  const overview = `**${i18n.runStatus(snapshot.status)}**${presentation.showElapsed ? ` · ${zh ? "用时" : "Elapsed"} ${i18n.elapsed(Math.max(0, Math.round(snapshot.elapsedMs / 1000)))}` : ""}`
  const waiting = snapshot.pendingInterrupt
    ? `**${zh ? "需要你的操作" : "Your action is needed"}**\n${zh ? "请使用下方按钮批准或拒绝，再继续执行。" : "Use the controls below to approve or deny before execution continues."}`
    : undefined
  const artifacts =
    presentation.showArtifacts && snapshot.artifacts.length > 0
      ? `**${zh ? "产物" : "Artifacts"} · ${snapshot.artifacts.length}**\n` +
        snapshot.artifacts
          .slice(0, 5)
          .map((artifact) => `▣ ${safeLabel(artifact.title, "Artifact")}`)
          .join("\n")
      : undefined
  return [
    overview,
    presentation.showProgress ? bar : undefined,
    waiting,
    artifacts,
    followUpHintLine(buildFollowUpItems(snapshot), zh),
    cotActive ? i18n.cotProcessInline : undefined,
  ]
    .filter(Boolean)
    .join("\n\n")
}

function actionsElement(
  snapshot: RunProjectionSnapshot,
  webBase?: string | null,
  cotActive = false,
  presentation: LarkCardPresentation = DEFAULT_LARK_CARD_PRESENTATION
): Record<string, unknown> {
  const card = cardJson(snapshot, true, webBase, cotActive, presentation) as {
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

/** Only acknowledged, rendered content participates in no-op detection. */
function renderedContent(
  snapshot: RunProjectionSnapshot,
  webBase?: string | null,
  cotActive = false,
  presentation: LarkCardPresentation = DEFAULT_LARK_CARD_PRESENTATION
): Record<Exclude<PendingCardMutation["operation"], "batch_update">, string> {
  return {
    stream_summary: deterministicUuid(summaryContent(snapshot, cotActive, presentation)),
    update_summary: deterministicUuid(
      JSON.stringify({
        tag: "markdown",
        element_id: SUMMARY_ELEMENT_ID,
        ...larkCardMarkdownStyle(presentation),
        content: summaryContent(snapshot, cotActive, presentation),
      })
    ),
    update_status: deterministicUuid(JSON.stringify(statusElement(snapshot, presentation))),
    update_actions: deterministicUuid(
      JSON.stringify(actionsElement(snapshot, webBase, cotActive, presentation))
    ),
    replace_card: deterministicUuid(
      serializeCard(
        snapshot,
        ["running", "queued"].includes(snapshot.status),
        webBase,
        cotActive,
        presentation
      )
    ),
  }
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
  const presentation = normalizeLarkCardPresentation(options.presentation)
  const cot = options.cot === false ? undefined : createLarkCotClient(request, { sleep, now })

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

  /**
   * Project the snapshot diff into the live COT message and persist the
   * advanced projection. The write lands BEFORE the projection checkpoint so
   * a failed write re-derives the same diff on the next mutation (the
   * projector is deterministic given the same prior state + snapshot).
   * Every failure degrades to a persisted `disabled` state — the COT path
   * never throws into the card flow. One strike disables for the run.
   */
  async function syncCot(
    ref: RunPresentationRef,
    snapshot: RunProjectionSnapshot,
    checkpoint?: (ref: RunPresentationRef) => Promise<void>
  ): Promise<RunPresentationRef> {
    const current = cotOpaqueState(ref)
    if (!cot || current?.status !== "active") return ref
    const {
      events,
      state: projection,
      terminalReason,
    } = projectLarkCotEvents(
      current.projection,
      snapshot,
      resolveActivityI18n(snapshot.locale),
      now()
    )
    if (events.length === 0 && projection === current.projection) return ref
    const handle = { cotId: current.cotId, messageId: current.messageId }
    try {
      if (events.length > 0) await cot.write(handle, events)
      // RUN_FINISHED auto-completes; only an error terminal needs the call.
      if (terminalReason === "error") await cot.complete(handle, "error")
    } catch (error) {
      const unsupported = isLarkCotUnsupportedError(error)
      const reason = unsupported
        ? "unsupported"
        : errorCode(error) === 230001
          ? "param_invalid"
          : "write_failed"
      if (unsupported) {
        const adapterId = (ref.opaqueState?.target as RunPresentationTarget | undefined)?.adapterId
        if (adapterId) rememberLarkCotUnsupported(adapterId, reason, now())
      }
      const disabled: RunPresentationRef = {
        ...ref,
        opaqueState: { ...ref.opaqueState, cot: { status: "disabled", reason } },
      }
      await checkpoint?.(disabled)
      return disabled
    }
    const next: RunPresentationRef = {
      ...ref,
      opaqueState: { ...ref.opaqueState, cot: { ...current, projection } },
    }
    await checkpoint?.(next)
    return next
  }

  /**
   * Create the COT message ahead of the card (so it renders above it) and
   * write the initial event batch. Skipped entirely when the feature is off,
   * the adapter is already known to lack message_cot, or the target cannot
   * anchor one — a topic conversation needs `origin_message_id` because
   * message_cot has no reply_in_thread. Failure never fails `open()`: the
   * disabled state is checkpointed and the card proceeds exactly as before.
   */
  async function maybeOpenCot(
    ref: RunPresentationRef,
    target: RunPresentationTarget,
    snapshot: RunProjectionSnapshot,
    checkpoint?: (ref: RunPresentationRef) => Promise<void>
  ): Promise<RunPresentationRef> {
    if (!cot || presentation.processMode === "card") return ref
    const existing = cotOpaqueState(ref)
    if (existing?.status === "disabled") return ref
    if (existing?.status === "active") {
      // A retried open after the create checkpoint: the COT already exists —
      // flush the current diff (a same-snapshot retry emits nothing).
      return syncCot(ref, snapshot, checkpoint)
    }
    const disable = async (reason: string): Promise<RunPresentationRef> => {
      const next: RunPresentationRef = {
        ...ref,
        opaqueState: { ...ref.opaqueState, cot: { status: "disabled", reason } },
      }
      await checkpoint?.(next)
      return next
    }
    if (isLarkCotKnownUnsupported(target.adapterId, now())) return disable("unsupported")
    const delivery = target.deliveryTarget
    const chatId = delivery?.address.containerId
    if (!delivery || !chatId) return ref
    const anchor = target.sourceMessageId ?? delivery.sourceMessageId
    if (delivery.address.topicId && !anchor) return disable("no_topic_anchor")
    let handle: { cotId: string; messageId: string }
    try {
      handle = await cot.create({ chatId, ...(anchor ? { originMessageId: anchor } : {}) })
    } catch (error) {
      if (isLarkCotUnsupportedError(error)) {
        rememberLarkCotUnsupported(target.adapterId, "unsupported", now())
        return disable("unsupported")
      }
      return disable("create_failed")
    }
    const active: RunPresentationRef = {
      ...ref,
      opaqueState: {
        ...ref.opaqueState,
        cot: {
          status: "active",
          cotId: handle.cotId,
          messageId: handle.messageId,
          projection: createLarkCotProjectionState(),
        },
      },
    }
    // Persist the handle before the first write: a retry must reuse this COT
    // instead of creating a duplicate message.
    await checkpoint?.(active)
    return syncCot(active, snapshot, checkpoint)
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
    const cotActive = cotOpaqueState(previousRef)?.status === "active"
    const created = (await request("POST", "/cardkit/v1/cards", {
      type: "card_json",
      data: serializeCard(
        snapshot,
        ["running", "queued"].includes(snapshot.status),
        options.webEntryBaseUrl,
        cotActive,
        presentation
      ),
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
        presentedCot: cotActive,
        presentedLayout: CARD_LAYOUT_VERSION,
        presentedPreferences: JSON.stringify(presentation),
        presentedContent: renderedContent(
          snapshot,
          options.webEntryBaseUrl,
          cotActive,
          presentation
        ),
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
    const cotState = cotOpaqueState(ref)
    const cotActive = cotState?.status === "active"
    // A card replacement keeps the COT state so the timeline message keeps
    // being written even though the card entity is new.
    const carryCot: RunPresentationRef | undefined =
      cotState !== undefined ? { opaqueState: { cot: cotState } } : undefined
    if (now() - current.cardCreatedAt >= 14 * 24 * 60 * 60 * 1_000) {
      return openCard(current.target, snapshot, checkpoint, carryCot)
    }
    const previousContent = ref.opaqueState?.presentedContent as Record<string, string> | undefined
    const rendered: Record<string, string> = {}
    let batchElements: Array<{
      operation: "update_status" | "update_summary" | "update_actions"
      element: Record<string, unknown>
    }> = []
    if (operation === "batch_update") {
      if (!cotActive) {
        batchElements.push({
          operation: "update_status",
          element: statusElement(snapshot, presentation),
        })
      }
      if (!["running", "queued"].includes(snapshot.status)) {
        batchElements.push({
          operation: "update_summary",
          element: {
            tag: "markdown",
            element_id: current.elementIds.summary,
            ...larkCardMarkdownStyle(presentation),
            content: summaryContent(snapshot, cotActive, presentation),
          },
        })
      }
      if (snapshot.allowedActions.length > 0) {
        batchElements.push({
          operation: "update_actions",
          element: actionsElement(snapshot, options.webEntryBaseUrl, cotActive, presentation),
        })
      }
      batchElements = batchElements.filter(({ operation: part, element }) => {
        rendered[part] = deterministicUuid(JSON.stringify(element))
        return previousContent?.[part] !== rendered[part]
      })
      // Keep single-element updates cheap, but always reconcile a persisted
      // batch before deriving any fresh mutation from the latest snapshot.
      if (!current.pendingMutation && batchElements.length < 2) {
        return batchElements.length === 0
          ? ref
          : mutate(ref, snapshot, batchElements[0].operation, checkpoint)
      }
    }
    const sequence = current.lastAcknowledgedSequence + 1
    const mutationUuid = (kind: string) =>
      deterministicUuid(`card-mutation:${snapshot.runId}:${sequence}:${kind}`)
    const desired: PendingCardMutation =
      operation === "batch_update"
        ? {
            safetyVersion: MUTATION_SAFETY_VERSION,
            sequence,
            uuid: mutationUuid("batch"),
            operation,
            method: "POST",
            path: `/cardkit/v1/cards/${current.cardId}/batch_update`,
            body: {
              actions: JSON.stringify(
                batchElements.map(({ element }) => ({
                  action: "update_element",
                  params: { element_id: element.element_id, element },
                }))
              ),
              sequence,
              uuid: mutationUuid("batch"),
            },
          }
        : operation === "stream_summary"
          ? {
              safetyVersion: MUTATION_SAFETY_VERSION,
              sequence,
              uuid: mutationUuid("summary"),
              operation,
              method: "PUT",
              path: `/cardkit/v1/cards/${current.cardId}/elements/${current.elementIds.summary}/content`,
              body: {
                content: summaryContent(snapshot, cotActive, presentation),
                sequence,
                uuid: mutationUuid("summary"),
              },
            }
          : operation === "update_actions" ||
              operation === "update_status" ||
              operation === "update_summary"
            ? {
                safetyVersion: MUTATION_SAFETY_VERSION,
                sequence,
                uuid: mutationUuid(operation),
                operation,
                method: "PUT",
                path: `/cardkit/v1/cards/${current.cardId}/elements/${operation === "update_status" ? STATUS_ELEMENT_ID : operation === "update_summary" ? current.elementIds.summary : current.elementIds.actions}`,
                body: {
                  element: JSON.stringify(
                    operation === "update_status"
                      ? statusElement(snapshot, presentation)
                      : operation === "update_summary"
                        ? {
                            tag: "markdown",
                            element_id: current.elementIds.summary,
                            ...larkCardMarkdownStyle(presentation),
                            content: summaryContent(snapshot, cotActive, presentation),
                          }
                        : actionsElement(snapshot, options.webEntryBaseUrl, cotActive, presentation)
                  ),
                  sequence,
                  uuid: mutationUuid(operation),
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
                      options.webEntryBaseUrl,
                      cotActive,
                      presentation
                    ),
                  },
                  sequence,
                  uuid: mutationUuid("replace"),
                },
              }
    const content = deterministicUuid(
      operation === "replace_card"
        ? (desired.body.card as { data: string }).data
        : String(desired.body.content ?? desired.body.element ?? desired.body.actions)
    )
    // An ambiguous request must be reconciled even if its desired content is
    // already on screen. Advancing the checkpoint is part of delivery.
    if (!current.pendingMutation && previousContent?.[operation] === content) return ref
    const pending = current.pendingMutation ?? desired
    const pendingRef: RunPresentationRef = {
      ...ref,
      opaqueState: { ...ref.opaqueState, pendingMutation: pending },
    }
    await checkpoint?.(pendingRef)
    try {
      await requestMutation(pending)
    } catch (error) {
      if (
        [300309, 200850].includes(errorCode(error) ?? -1) &&
        pending.operation === "stream_summary"
      ) {
        // Streaming may already be closed on a persisted/recovered card.
        // Retire the rejected operation and repair this SAME card with JSON 2.0.
        return mutate(
          {
            ...ref,
            opaqueState: {
              ...ref.opaqueState,
              pendingMutation: undefined,
              presentedContent: undefined,
              lastAcknowledgedSequence: pending.sequence,
            },
          },
          snapshot,
          "replace_card",
          checkpoint
        )
      }
      if ([200740, 200750, 300317].includes(errorCode(error) ?? -1)) {
        return openCard(current.target, snapshot, checkpoint, carryCot)
      }
      throw error
    }
    const matchesDesired =
      pending.operation === desired.operation &&
      JSON.stringify(pending.body) === JSON.stringify(desired.body)
    const acknowledged: RunPresentationRef = {
      ...ref,
      opaqueState: {
        ...ref.opaqueState,
        lastAcknowledgedSequence: pending.sequence,
        presentedContent: matchesDesired
          ? operation === "replace_card"
            ? renderedContent(snapshot, options.webEntryBaseUrl, cotActive, presentation)
            : operation === "batch_update"
              ? {
                  ...previousContent,
                  replace_card: undefined,
                  ...Object.fromEntries(
                    batchElements.map(({ operation: part }) => [part, rendered[part]])
                  ),
                }
              : { ...previousContent, replace_card: undefined, [operation]: content }
          : undefined,
        ...(pending.operation === "replace_card"
          ? {
              presentedStatus: matchesDesired ? snapshot.status : undefined,
              presentedGraph: matchesDesired ? graphSignature(snapshot) : undefined,
              presentedCot: matchesDesired ? cotActive : undefined,
              presentedLayout: matchesDesired ? CARD_LAYOUT_VERSION : undefined,
              presentedPreferences: matchesDesired ? JSON.stringify(presentation) : undefined,
            }
          : {}),
        pendingMutation: undefined,
        hasActions: snapshot.allowedActions.length > 0,
      },
    }
    await checkpoint?.(acknowledged)
    if (!matchesDesired) {
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
        const withCot = await maybeOpenCot(provisional, target, snapshot, options?.checkpoint)
        return openCard(target, snapshot, options?.checkpoint, withCot)
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
      ref = await syncCot(ref, snapshot, mutationOptions?.checkpoint)
      const current = state(ref)
      if (
        ref.opaqueState?.presentedLayout !== CARD_LAYOUT_VERSION ||
        ref.opaqueState?.presentedPreferences !== JSON.stringify(presentation) ||
        current.hasActions !== snapshot.allowedActions.length > 0 ||
        ref.opaqueState?.presentedStatus !== snapshot.status ||
        (ref.opaqueState?.presentedGraph ?? "") !== graphSignature(snapshot) ||
        // A COT that just died mid-run means the card on screen has no
        // timeline panel — force a replace so the in-card timeline returns.
        (ref.opaqueState?.presentedCot === true) !== (cotOpaqueState(ref)?.status === "active")
      ) {
        return mutate(ref, snapshot, "replace_card", mutationOptions?.checkpoint)
      }
      if (current.pendingMutation) {
        // Resume the original operation first so a successfully replayed batch
        // retains its per-component acknowledgement cache across restarts.
        ref = await mutate(
          ref,
          snapshot,
          current.pendingMutation.operation,
          mutationOptions?.checkpoint
        )
      }
      if (["running", "queued"].includes(snapshot.status)) {
        // Streaming content requires its dedicated API. All other component
        // changes share one batch, sequenced after the stream acknowledgement.
        ref = await mutate(ref, snapshot, "stream_summary", mutationOptions?.checkpoint)
      }
      return mutate(ref, snapshot, "batch_update", mutationOptions?.checkpoint)
    },
    async finish(ref, snapshot, mutationOptions) {
      ref = await ensureFollowUpControl(
        ref,
        state(ref).target,
        snapshot,
        mutationOptions?.checkpoint
      )
      ref = await react(ref, state(ref).target, reactionFor(snapshot), mutationOptions?.checkpoint)
      ref = await syncCot(ref, snapshot, mutationOptions?.checkpoint)
      return mutate(ref, snapshot, "replace_card", mutationOptions?.checkpoint)
    },
  }
}
