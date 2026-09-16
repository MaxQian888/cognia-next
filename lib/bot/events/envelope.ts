/**
 * Building a Bot event envelope, and reading values out of one.
 *
 * The envelope is the only shape the Bot plane routes on. A verified GitHub
 * webhook, an IM message that already passed the connector's trigger policy, a
 * finished workflow and a fired schedule all become this, so deduplication,
 * fan-out, debouncing and replay are written once instead of five times.
 */

import { nanoid } from "nanoid"

import type {
  BotEventActor,
  BotEventEnvelopeV1,
  BotEventProvenanceV1,
  BotEventResource,
  BotEventSource,
} from "@/types/bot/event"

/**
 * A stable event id for a source record.
 *
 * Deterministic, because the same webhook redelivered must produce the same id
 * or every retry becomes a new event. The source and its own id are the only
 * inputs: a timestamp would defeat the whole point.
 */
export function botEventId(source: BotEventSource, sourceRecordId: string): string {
  return `bev_${source}_${sourceRecordId}`
}

/**
 * Largest payload an envelope may carry: UTF-8 bytes of its JSON encoding.
 *
 * Nothing else on the Bot plane bounds a payload today, and `ctx.bots.emit`
 * hands authors a fan-out onto other installations' queues — one limit shared
 * by `enqueue` and `emit` keeps a self-enqueued and an emitted envelope under
 * the same ceiling. 64 KiB holds a GitHub webhook body with room to spare.
 */
export const BOT_EVENT_PAYLOAD_MAX_BYTES = 64 * 1024

/** Throw when `payload`'s JSON encoding exceeds `BOT_EVENT_PAYLOAD_MAX_BYTES`. */
export function assertBotEventPayloadSize(payload: unknown): void {
  const json = JSON.stringify(payload)
  const bytes = json === undefined ? 0 : new TextEncoder().encode(json).byteLength
  if (bytes > BOT_EVENT_PAYLOAD_MAX_BYTES) {
    throw new Error("Bot event payload exceeds 65536 bytes")
  }
}

/** A delivery id is per recipient, so a fan-out produces distinct rows. */
export function botDeliveryId(eventId: string, installationId: string): string {
  return `bdl_${installationId}_${eventId}`
}

export interface BuildBotEventInput {
  source: BotEventSource
  /** The producer's own id for this record. Must be stable across redelivery. */
  sourceRecordId: string
  type: string
  installationId: string
  triggerId: string
  occurredAt: number
  payload: unknown
  receivedAt?: number
  binding?: BotEventEnvelopeV1["binding"]
  actor?: BotEventActor
  resource?: BotEventResource
  sequence?: number
  traceId?: string
  correlation?: string
  provenance?: Partial<BotEventProvenanceV1>
}

export function buildBotEventEnvelope(input: BuildBotEventInput): BotEventEnvelopeV1 {
  const eventId = botEventId(input.source, input.sourceRecordId)
  return {
    eventId,
    deliveryId: botDeliveryId(eventId, input.installationId),
    source: input.source,
    type: input.type,
    installationId: input.installationId,
    triggerId: input.triggerId,
    occurredAt: input.occurredAt,
    receivedAt: input.receivedAt ?? Date.now(),
    payload: input.payload,
    provenance: {
      selfProduced: input.provenance?.selfProduced ?? false,
      depth: input.provenance?.depth ?? 0,
      ...(input.provenance?.producedByRunId
        ? { producedByRunId: input.provenance.producedByRunId }
        : {}),
      ...(input.provenance?.producedByInstallationId
        ? { producedByInstallationId: input.provenance.producedByInstallationId }
        : {}),
      ...(input.provenance?.producedByActionJobId
        ? { producedByActionJobId: input.provenance.producedByActionJobId }
        : {}),
      ...(input.provenance?.causationEventIds
        ? { causationEventIds: input.provenance.causationEventIds }
        : {}),
    },
    ...(input.binding ? { binding: input.binding } : {}),
    ...(input.actor ? { actor: input.actor } : {}),
    ...(input.resource ? { resource: input.resource } : {}),
    ...(input.sequence !== undefined ? { sequence: input.sequence } : {}),
    ...(input.traceId ? { traceId: input.traceId } : {}),
    ...(input.correlation ? { correlation: input.correlation } : {}),
  }
}

/** A source with no id of its own (a manual run) still needs a stable one. */
export function oneOffSourceRecordId(prefix: string): string {
  return `${prefix}_${nanoid(12)}`
}

/**
 * Read a dotted path out of an envelope or a config object.
 *
 * Only plain own properties, and never through a prototype: the payload is
 * whoever opened the pull request, so `__proto__.x` must read as a miss rather
 * than as anything at all.
 */
function readObjectPath(root: unknown, segments: readonly string[]): unknown {
  let cursor: unknown = root
  for (const segment of segments) {
    if (segment === "__proto__" || segment === "prototype" || segment === "constructor") {
      return undefined
    }
    if (cursor === null || typeof cursor !== "object") return undefined
    if (!Object.prototype.hasOwnProperty.call(cursor, segment)) return undefined
    cursor = (cursor as Record<string, unknown>)[segment]
  }
  return cursor
}

export function readEnvelopePath(envelope: BotEventEnvelopeV1, path: string): unknown {
  const segments = path.split(".").filter(Boolean)
  if (segments.length === 0) return undefined
  return readObjectPath(envelope, segments)
}

const TEMPLATE_PATTERN = /\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g

/**
 * Interpolate `{{resource.id}}`-style placeholders against an envelope.
 *
 * Used for a trigger's `concurrencyKey`. A placeholder that resolves to
 * nothing becomes an empty segment rather than the literal text, because a key
 * that still contains `{{resource.id}}` would serialise every delivery of that
 * trigger against every other one, which looks like a hang rather than a
 * misconfiguration.
 */
export function interpolateEnvelopeTemplate(
  template: string,
  envelope: BotEventEnvelopeV1,
  extra?: { config?: Record<string, unknown> }
): string {
  return template.replace(TEMPLATE_PATTERN, (_match, path: string) => {
    // `config.*` paths read the installation config, not the envelope — an
    // agent-turn prompt says `{{config.repository}}` where a concurrency key
    // says `{{resource.id}}`.
    const value = path.startsWith("config.")
      ? readObjectPath(extra?.config ?? {}, path.slice("config.".length).split(".").filter(Boolean))
      : readEnvelopePath(envelope, path)
    if (value === null || value === undefined) return ""
    if (typeof value === "object") return ""
    return String(value)
  })
}
