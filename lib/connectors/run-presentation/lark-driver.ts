import { parseConversationKey } from "@/types/connectors/event"
import type {
  RunControlAction,
  RunPresentationDriver,
  RunPresentationRef,
  RunProjectionSnapshot,
} from "@/types/execution/run"

type LarkMethod = "POST" | "PUT" | "PATCH"
export type LarkRunRequest = (method: LarkMethod, path: string, body: unknown) => Promise<unknown>

const CARD_LIMIT_BYTES = 30_000
const CARD_CREATED_AT_KEY = "cardCreatedAt"

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
        { tag: "markdown", content: details.join("\n\n"), element_id: "run_summary" },
        ...(actions.length > 0
          ? [{ tag: "action", layout: "bisected", actions, element_id: "run_actions" }]
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

function state(ref: RunPresentationRef): {
  cardId: string
  sequence: number
  cardCreatedAt: number
} {
  const cardId = ref.opaqueState?.cardId
  const sequence = ref.opaqueState?.sequence
  const cardCreatedAt = ref.opaqueState?.[CARD_CREATED_AT_KEY]
  if (
    typeof cardId !== "string" ||
    typeof sequence !== "number" ||
    typeof cardCreatedAt !== "number"
  ) {
    throw new Error("Invalid Lark CardKit presentation reference")
  }
  return { cardId, sequence, cardCreatedAt }
}

export function createLarkRunPresentationDriver(request: LarkRunRequest): RunPresentationDriver {
  async function replace(
    ref: RunPresentationRef,
    snapshot: RunProjectionSnapshot,
    streaming: boolean
  ): Promise<RunPresentationRef> {
    const current = state(ref)
    if (Date.now() - current.cardCreatedAt >= 14 * 24 * 60 * 60 * 1_000) {
      throw new Error("Lark CardKit entity expired after 14 days")
    }
    const sequence = current.sequence + 1
    await request("PUT", `/cardkit/v1/cards/${current.cardId}`, {
      card: { type: "card_json", data: serializeCard(snapshot, streaming) },
      sequence,
      uuid: `${snapshot.runId}:${snapshot.revision}`.slice(0, 64),
    })
    return {
      ...ref,
      opaqueState: { ...ref.opaqueState, sequence },
    }
  }

  return {
    capabilities: {
      nativeStreaming: true,
      partialUpdate: false,
      messageEdit: true,
      interactiveControls: true,
    },
    async open(target, snapshot, options) {
      const { remoteChatId } = parseConversationKey(target.conversationKey)
      let provisional = options?.previousRef
      if (!provisional?.opaqueState?.cardId) {
        const created = (await request("POST", "/cardkit/v1/cards", {
          type: "card_json",
          data: serializeCard(snapshot, true),
        })) as { data?: { card_id?: string } }
        const cardId = created.data?.card_id
        if (!cardId) throw new Error("Lark CardKit create response omitted card_id")
        provisional = {
          opaqueState: { cardId, sequence: 0, [CARD_CREATED_AT_KEY]: Date.now() },
        }
        await options?.checkpoint?.(provisional)
      }
      const current = state(provisional)
      if (provisional.platformMessageId) return provisional
      const sent = (await request("POST", "/im/v1/messages?receive_id_type=chat_id", {
        receive_id: remoteChatId,
        msg_type: "interactive",
        content: JSON.stringify({ type: "card", data: { card_id: current.cardId } }),
        uuid: snapshot.runId.slice(0, 50),
      })) as { data?: { message_id?: string } }
      const result = {
        platformMessageId: sent.data?.message_id,
        opaqueState: provisional.opaqueState,
      }
      await options?.checkpoint?.(result)
      return result
    },
    update(ref, snapshot) {
      return replace(ref, snapshot, true)
    },
    finish(ref, snapshot) {
      return replace(ref, snapshot, false)
    },
  }
}
