import type { BotEventResource } from "./event"

export interface BotMonitorState {
  lastSuccessAt?: number
  lastError?: string | null
  retryAt?: number
  cursor?: string
}

/** Host-owned publication checkpoints, safe for rebuilding monitoring after a restart. */
export interface BotPublicationReference {
  sourceRunId: string
  repository: string
  branch: string
  headSha: string
  snapshotId: string
  sourcePayload: unknown
}

export interface BotInstallationSnapshot {
  id: string
  createdAt: number
  activatedAt?: number
  config: Record<string, unknown>
  triggerState: Record<string, { cursor?: string }>
  monitor?: BotMonitorState
  webhookEnabled: boolean
  publications?: BotPublicationReference[]
}

export interface BotEnqueueInput {
  triggerId: string
  eventId: string
  type: string
  payload: unknown
  resource?: BotEventResource
  correlation?: string
}

/** All calls are scoped by a live run owned by the calling plugin. */
export interface PluginBotsAPI {
  getInstallation(runId: string): Promise<BotInstallationSnapshot>
  enqueue(runId: string, input: BotEnqueueInput): Promise<{ deliveryId: string }>
  cancelResource(
    runId: string,
    input: { resourceId: string; exceptEventId?: string; exceptRevision?: string }
  ): Promise<number>
  recordMonitor(runId: string, patch: BotMonitorState): Promise<void>
}
