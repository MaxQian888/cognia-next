import type {
  RunPresentationDriver,
  RunPresentationRef,
  RunActivitySnapshot,
  RunProjectionSnapshot,
} from "@/types/execution/run"
import {
  formatRunActivityTimeline,
  runActivitiesForPresentation,
  runTitleForPresentation,
} from "@/lib/connectors/activity/activity-to-a2ui"
import { resolveActivityI18n } from "@/lib/connectors/activity/i18n"

type SlackMethod = "POST"
export type SlackRunRequest = (method: SlackMethod, path: string, body: unknown) => Promise<unknown>

function clamp(value: string, max = 256): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}

function activityTaskStatus(status: RunActivitySnapshot["status"]): string {
  if (status === "completed" || status === "skipped") return "complete"
  if (status === "failed") return "error"
  if (status === "running" || status === "blocked") return "in_progress"
  return "pending"
}

function chunks(snapshot: RunProjectionSnapshot): Array<Record<string, unknown>> {
  const i18n = resolveActivityI18n(snapshot.locale)
  return [
    { type: "plan_update", title: clamp(runTitleForPresentation(snapshot, i18n)) },
    ...runActivitiesForPresentation(snapshot).map((activity) => ({
      type: "task_update",
      id: clamp(activity.id),
      title: clamp(i18n.activityLabel(activity)),
      status: activityTaskStatus(activity.status),
      ...(activity.target ? { details: clamp(activity.target.label) } : {}),
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
      const remoteChatId = target.deliveryTarget?.address.containerId
      if (!remoteChatId || target.deliveryTarget?.address.platform !== "slack") {
        throw new Error("Slack native stream requires a persisted Slack delivery target")
      }
      const response = (await request("POST", "chat.startStream", {
        channel: remoteChatId,
        thread_ts: target.sourceMessageId,
        task_display_mode:
          (snapshot.kind === "workflow" || snapshot.kind === "plan") &&
          snapshot.progress.trustworthy &&
          snapshot.progress.total > 0
            ? "plan"
            : "timeline",
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
        markdown_text: clamp(
          formatRunActivityTimeline(snapshot, resolveActivityI18n(snapshot.locale)),
          12_000
        ),
      })
      return ref
    },
  }
}
