import { parseConversationKey } from "@/types/connectors/event"
import type {
  RunPresentationDriver,
  RunPresentationRef,
  RunProjectionSnapshot,
  RunStepSnapshot,
} from "@/types/execution/run"

type SlackMethod = "POST"
export type SlackRunRequest = (method: SlackMethod, path: string, body: unknown) => Promise<unknown>

function clamp(value: string, max = 256): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}

function taskStatus(status: RunStepSnapshot["status"]): string {
  if (status === "completed" || status === "skipped") return "complete"
  if (status === "failed") return "error"
  if (status === "in_progress" || status === "blocked") return "in_progress"
  return "pending"
}

function chunks(snapshot: RunProjectionSnapshot): Array<Record<string, unknown>> {
  const steps = [...snapshot.activeSteps, ...snapshot.recentSteps, ...snapshot.pendingSteps].slice(
    0,
    48
  )
  return [
    { type: "plan_update", title: clamp(snapshot.title) },
    ...steps.map((step) => ({
      type: "task_update",
      id: clamp(step.id),
      title: clamp(step.title),
      status: taskStatus(step.status),
      ...(step.summary ? { details: clamp(step.summary) } : {}),
    })),
  ]
}

function refState(ref: RunPresentationRef): { channel: string; ts: string } {
  const channel = ref.opaqueState?.channel
  const ts = ref.opaqueState?.ts
  if (typeof channel !== "string" || typeof ts !== "string") {
    throw new Error("Invalid Slack stream presentation reference")
  }
  return { channel, ts }
}

export function createSlackRunPresentationDriver(request: SlackRunRequest): RunPresentationDriver {
  return {
    capabilities: {
      topicIsolation: true,
      textStreaming: true,
      componentMutation: true,
      fullReplacement: false,
      messageEditing: true,
      appendFallback: true,
      interactiveControls: false,
      followUpBubbles: false,
    },
    async open(target, snapshot, options) {
      if (options?.previousRef?.platformMessageId) return options.previousRef
      if (!target.sourceMessageId) {
        throw new Error("Slack native stream requires sourceMessageId")
      }
      const { remoteChatId } = parseConversationKey(target.conversationKey)
      const response = (await request("POST", "chat.startStream", {
        channel: remoteChatId,
        thread_ts: target.sourceMessageId,
        task_display_mode:
          snapshot.kind === "workflow" || snapshot.progress.trustworthy ? "plan" : "dense",
        chunks: chunks(snapshot),
        ...(target.recipientUserId ? { recipient_user_id: target.recipientUserId } : {}),
        ...(target.recipientTeamId ? { recipient_team_id: target.recipientTeamId } : {}),
      })) as { ts?: string }
      if (!response.ts) throw new Error("Slack chat.startStream response omitted ts")
      const result = {
        platformMessageId: `${remoteChatId}:${response.ts}`,
        opaqueState: { channel: remoteChatId, ts: response.ts },
      }
      await options?.checkpoint?.(result)
      return result
    },
    async update(ref, snapshot) {
      const { channel, ts } = refState(ref)
      await request("POST", "chat.appendStream", { channel, ts, chunks: chunks(snapshot) })
      return ref
    },
    async finish(ref, snapshot) {
      const { channel, ts } = refState(ref)
      await request("POST", "chat.stopStream", {
        channel,
        ts,
        chunks: chunks(snapshot),
        markdown_text: snapshot.summary ? clamp(snapshot.summary, 12_000) : undefined,
      })
      return ref
    },
  }
}
