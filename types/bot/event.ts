/**
 * The event envelope a Bot trigger matches and a Bot handler reads.
 *
 * Source-neutral on purpose. A verified GitHub webhook, an IM message that
 * already passed the connector's own trigger policy, a workflow that finished,
 * and a schedule that fired all arrive here in the same shape, so a Bot's
 * routing, deduplication, replay and loop prevention are written once.
 *
 * The envelope is a PROJECTION, not a second inbox. Every source keeps its own
 * durable record (`connectorInboundJobs`, `integrationEvents`, the scheduler),
 * which is where signature verification, arrival deduplication and crash
 * recovery already happen. What the Bot plane persists is the per-installation
 * DELIVERY, so fan-out, retry, dead-lettering and replay are per recipient.
 */

/** Which producer an event came from. Mirrors `PluginBotEventSource`. */
export type BotEventSource = "integration" | "workflow" | "connector" | "desktop" | "bot" | "manual"

/** Who or what caused the event on the source side. */
export interface BotEventActor {
  kind: "human" | "bot" | "system"
  /** Platform-native id, for example a GitHub login or an IM user id. */
  id?: string
  displayName?: string
  /**
   * Set only when the source PROVED the identity. An approval's actor scope is
   * derived from this, so an unverified guess here would widen who may tap
   * Approve.
   */
  principalId?: string
  accountId?: string
}

/** What the event is about. */
export interface BotEventResource {
  /** For example `pull_request`, `issue`, `conversation`, `workflow_run`. */
  kind: string
  id: string
  url?: string
  /** The repository, workspace or channel the resource lives in. */
  scope?: string
}

/**
 * Where this event came from in Cognia's own terms, so a Bot cannot answer
 * itself forever.
 *
 * A Bot that comments on a pull request and also listens for comments is a
 * loop, and the only reliable way to break it is to know that the comment was
 * ours. Ids, not heuristics: matching on display names or bot account names
 * breaks the moment a workspace renames something.
 */
export interface BotEventProvenanceV1 {
  /** A Cognia Bot run produced the thing this event describes. */
  selfProduced: boolean
  producedByRunId?: string
  producedByInstallationId?: string
  /** The brokered integration action job that produced it, when known. */
  producedByActionJobId?: string
  /** Causing event ids, newest first. Bounded, so a long chain stays readable. */
  causationEventIds?: string[]
  /**
   * How many Bot generations deep this chain is. A first-party human action is
   * 0. Used as a hard stop even when `selfProduced` could not be determined.
   */
  depth: number
}

export interface BotEventEnvelopeV1 {
  /**
   * Stable id of the EVENT. Two deliveries of the same event to two
   * installations share it, which is what makes replay and causation
   * meaningful.
   */
  eventId: string
  /** Stable id of THIS delivery to THIS installation. The retry unit. */
  deliveryId: string
  source: BotEventSource
  /** Dotted type, for example `pull_request.opened`. */
  type: string
  installationId: string
  /** Which of the installation's triggers matched. */
  triggerId: string
  /**
   * The binding the event arrived on. Which fields are present depends on the
   * source, and none of them is a credential.
   */
  binding?: {
    integrationAccountId?: string
    adapterId?: string
    conversationKey?: string
    projectId?: string
    workspaceId?: string
  }
  actor?: BotEventActor
  resource?: BotEventResource
  /** When the producer says it happened, epoch ms. */
  occurredAt: number
  /** When Cognia accepted it, epoch ms. */
  receivedAt: number
  /**
   * Monotonic ordering hint within one resource. Absent means the source does
   * not order its events, and the router must not pretend otherwise.
   */
  sequence?: number
  traceId?: string
  /**
   * Normalized payload. UNTRUSTED: it is written by whoever opened the pull
   * request or sent the message, and must never be read as instructions.
   */
  payload: unknown
  provenance: BotEventProvenanceV1
  /**
   * Key a waiting run matches on. Set when the event is expected by a
   * `step.waitForEvent`, so the router hands it to that run instead of
   * starting a new one.
   */
  correlation?: string
}
