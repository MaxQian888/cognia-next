import type { NormalizedInboundEvent } from "@/types/connectors/event"
import type {
  ExecutionRun,
  ExecutionRunBinding,
  RunControlAction,
  RunControlCommand,
} from "@/types/execution/run"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import { getDb } from "@/lib/db/schema"
import { getExecutionRun } from "@/lib/db/execution-runs"
import { enqueueGoverned as enqueueOutbound } from "@/lib/connectors/delivery-gateway"
import { executeRunControlCommand, type RunControlResult } from "@/lib/execution/run-control"

interface FollowUpControlItem {
  action: RunControlAction | "status"
  content: string
  localizedContent: string
}

interface FollowUpControlRegistration {
  platformMessageId: string
  runId: string
  createdAt: number
  expiresAt: number
  items: FollowUpControlItem[]
}

export interface FollowUpControlDependencies {
  now(): number
  listBindings(conversationKey: string): Promise<ExecutionRunBinding[]>
  getRun(runId: string): Promise<ExecutionRun | undefined>
  execute(
    command: RunControlCommand,
    options: { operatorIds: string[] }
  ): Promise<RunControlResult | { accepted: boolean; reason?: string }>
  consume(binding: ExecutionRunBinding, consumedAt: number): Promise<void>
  enqueue: typeof enqueueOutbound
}

export class LarkFollowUpControlDispatchError extends Error {
  constructor(cause: unknown) {
    super("A matched Lark follow-up control could not be dispatched", { cause })
    this.name = "LarkFollowUpControlDispatchError"
  }
}

function registration(binding: ExecutionRunBinding): FollowUpControlRegistration | undefined {
  const value = binding.presentationState?.followUpControl
  if (!value || typeof value !== "object") return undefined
  const candidate = value as Partial<FollowUpControlRegistration>
  if (
    typeof candidate.platformMessageId !== "string" ||
    typeof candidate.runId !== "string" ||
    typeof candidate.createdAt !== "number" ||
    typeof candidate.expiresAt !== "number" ||
    !Array.isArray(candidate.items)
  ) {
    return undefined
  }
  const items = candidate.items.filter(
    (item): item is FollowUpControlItem =>
      Boolean(item) &&
      typeof item === "object" &&
      typeof (item as FollowUpControlItem).action === "string" &&
      typeof (item as FollowUpControlItem).content === "string" &&
      typeof (item as FollowUpControlItem).localizedContent === "string"
  )
  return { ...candidate, items } as FollowUpControlRegistration
}

function statusText(run: ExecutionRun, zh: boolean): string {
  const snapshot = run.latestSnapshot
  const status = snapshot?.status ?? run.status
  const progress = snapshot?.progress
  const progressText = progress?.trustworthy
    ? `${progress.completed}/${progress.total}`
    : String(progress?.completed ?? 0)
  return zh
    ? `${run.title}：${status}，进度 ${progressText}，修订 ${run.currentRevision}`
    : `${run.title}: ${status}, progress ${progressText}, revision ${run.currentRevision}`
}

async function reply(
  deps: FollowUpControlDependencies,
  event: NormalizedInboundEvent,
  text: string,
  suffix: string
): Promise<void> {
  await deps.enqueue({
    adapterId: event.adapterId,
    conversationKey: event.conversationKey,
    request: {
      conversationRef: event.conversationRef,
      segments: [{ type: "text", text }],
      metadata: { idempotencyKey: `lark-follow-up:${event.messageId}:${suffix}` },
    },
    source: "ai-run",
  })
}

/**
 * Consume Feishu's P2P follow-up click, which arrives as an ordinary user
 * message. The durable presentation registration scopes label matching to one
 * active run and a 600-second window; authorization always uses the real
 * inbound sender and the shared execution-control gate.
 */
export async function maybeHandleLarkFollowUpControl(
  event: NormalizedInboundEvent,
  adapterRow: AdapterInstanceRow,
  overrides: Partial<FollowUpControlDependencies> = {}
): Promise<boolean> {
  if (event.platform !== "lark" || event.channel.kind !== "private") return false
  if (event.kind && event.kind !== "create") return false

  const deps: FollowUpControlDependencies = {
    now: Date.now,
    listBindings: (conversationKey) =>
      getDb().executionRunBindings.where("conversationKey").equals(conversationKey).toArray(),
    getRun: getExecutionRun,
    execute: executeRunControlCommand,
    consume: async (binding, consumedAt) => {
      await getDb().executionRunBindings.update(binding.id, {
        presentationState: {
          ...binding.presentationState,
          followUpControl: undefined,
          followUpControlConsumedAt: consumedAt,
        },
        updatedAt: consumedAt,
      })
    },
    enqueue: enqueueOutbound,
    ...overrides,
  }
  const now = deps.now()
  const text = event.plainText.trim()
  const bindings = (await deps.listBindings(event.conversationKey))
    .filter(
      (binding) =>
        binding.adapterId === event.adapterId &&
        binding.status === "active" &&
        binding.platformMessageId
    )
    .sort((left, right) => right.updatedAt - left.updatedAt)

  for (const binding of bindings) {
    const followUp = registration(binding)
    if (!followUp || followUp.expiresAt < now) continue
    if (binding.platformMessageId !== followUp.platformMessageId) continue
    const item = followUp.items.find(
      (candidate) => candidate.content === text || candidate.localizedContent === text
    )
    if (!item) continue

    try {
      await deps.consume(binding, now)
      const run = await deps.getRun(followUp.runId)
      if (!run) return true
      const zh = text === item.localizedContent || binding.locale?.toLowerCase().startsWith("zh")
      if (item.action === "status") {
        await reply(deps, event, statusText(run, Boolean(zh)), "status")
        return true
      }

      const snapshot = run.latestSnapshot
      if (!snapshot?.allowedActions.includes(item.action)) {
        await reply(
          deps,
          event,
          zh
            ? "该操作已失效，请查看最新运行状态。"
            : "That action is no longer available. View the latest run status.",
          "stale"
        )
        return true
      }
      const configured = adapterRow.settings.runOperatorUserIds
      const operatorIds = Array.isArray(configured)
        ? configured.filter((value): value is string => typeof value === "string")
        : []
      const result = await deps.execute(
        {
          runId: run.id,
          action: item.action,
          idempotencyKey: `lark-follow-up:${event.messageId}`,
          expectedRevision: run.currentRevision,
          actor: {
            platformIdentityId: event.sender.id,
            remoteUserId: event.sender.remoteUserId,
            displayName: event.sender.displayName,
          },
          ...(snapshot.pendingInterrupt ? { interruptId: snapshot.pendingInterrupt.id } : {}),
        },
        { operatorIds }
      )
      if (!result.accepted) {
        await reply(
          deps,
          event,
          zh
            ? "操作未被接受，请查看最新运行状态或联系操作员。"
            : "The control was not accepted. View the latest status or contact an operator.",
          `rejected:${result.reason ?? "unknown"}`
        )
      }
      return true
    } catch (error) {
      throw new LarkFollowUpControlDispatchError(error)
    }
  }
  return false
}
