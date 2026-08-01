import type { ObservabilityEventV1, ObservabilityRuntime } from "./observability-event"

export type IncidentState =
  | "detected"
  | "packaged"
  | "awaiting-consent"
  | "queued"
  | "uploading"
  | "processing"
  | "accepted"
  | "rejected"
  | "cancelled"
  | "deleted"

export type IncidentAttachmentKind =
  | "metadata"
  | "logs"
  | "breadcrumbs"
  | "system"
  | "minidump"
  | "screenshot"
  | "description"
  | "other"

export interface IncidentAttachmentInput {
  id: string
  kind: IncidentAttachmentKind
  name: string
  sizeBytes: number
  sha256?: string
}

export interface IncidentAttachment extends IncidentAttachmentInput {
  selected: boolean
}

export interface DiagnosticIncident {
  schemaVersion: 1
  incidentId: string
  detectedAt: string
  state: IncidentState
  events: ObservabilityEventV1[]
  attachments: IncidentAttachment[]
  missingSources: ObservabilityRuntime[]
  sourceWatermarks: Partial<Record<ObservabilityRuntime, number>>
  traceIds: string[]
  receiptId?: string
  rejectionCode?: string
}

export interface AssembleDiagnosticIncidentInput {
  incidentId: string
  detectedAt: string
  events: ObservabilityEventV1[]
  expectedSources: ObservabilityRuntime[]
  attachments?: IncidentAttachmentInput[]
}

const OPTIONAL_ATTACHMENT_KINDS = new Set<IncidentAttachmentKind>([
  "minidump",
  "screenshot",
  "description",
])

export function assembleDiagnosticIncident(
  input: AssembleDiagnosticIncidentInput
): DiagnosticIncident {
  const events = [...input.events].sort((left, right) => {
    const byTime = left.occurredAt.localeCompare(right.occurredAt)
    return byTime || left.delivery.spoolSequence - right.delivery.spoolSequence
  })
  const presentSources = new Set(events.map((item) => item.scope.runtime))
  const sourceWatermarks: Partial<Record<ObservabilityRuntime, number>> = {}
  for (const item of events) {
    sourceWatermarks[item.scope.runtime] = Math.max(
      sourceWatermarks[item.scope.runtime] ?? 0,
      item.delivery.flushWatermark
    )
  }

  return {
    schemaVersion: 1,
    incidentId: input.incidentId,
    detectedAt: input.detectedAt,
    state: "detected",
    events,
    attachments: (input.attachments ?? []).map((attachment) => ({
      ...attachment,
      selected: !OPTIONAL_ATTACHMENT_KINDS.has(attachment.kind),
    })),
    missingSources: [...new Set(input.expectedSources)]
      .filter((source) => !presentSources.has(source))
      .sort(),
    sourceWatermarks,
    traceIds: [
      ...new Set(
        events
          .map((item) => item.correlation.traceId)
          .filter((traceId): traceId is string => Boolean(traceId))
      ),
    ].sort(),
  }
}

export type IncidentTransition =
  | { type: "package-created" }
  | { type: "consent-required" }
  | { type: "consent-granted" }
  | { type: "upload-started" }
  | { type: "upload-completed" }
  | { type: "accepted"; receiptId: string }
  | { type: "rejected"; code: string }
  | { type: "cancelled" }
  | { type: "deleted" }

const TRANSITIONS: Record<IncidentTransition["type"], readonly IncidentState[]> = {
  "package-created": ["detected"],
  "consent-required": ["packaged"],
  "consent-granted": ["awaiting-consent"],
  "upload-started": ["queued"],
  "upload-completed": ["uploading"],
  accepted: ["processing"],
  rejected: ["processing"],
  cancelled: ["awaiting-consent", "queued", "uploading"],
  deleted: [
    "detected",
    "packaged",
    "awaiting-consent",
    "queued",
    "uploading",
    "processing",
    "accepted",
    "rejected",
    "cancelled",
  ],
}

function nextState(transition: IncidentTransition): IncidentState {
  switch (transition.type) {
    case "package-created":
      return "packaged"
    case "consent-required":
      return "awaiting-consent"
    case "consent-granted":
      return "queued"
    case "upload-started":
      return "uploading"
    case "upload-completed":
      return "processing"
    case "accepted":
      return "accepted"
    case "rejected":
      return "rejected"
    case "cancelled":
      return "cancelled"
    case "deleted":
      return "deleted"
  }
}

export function transitionIncident(
  incident: DiagnosticIncident,
  transition: IncidentTransition
): DiagnosticIncident {
  const target = nextState(transition)
  if (!TRANSITIONS[transition.type].includes(incident.state)) {
    throw new Error(`Invalid incident transition: ${incident.state} -> ${target}`)
  }
  return {
    ...incident,
    state: target,
    ...(transition.type === "accepted" ? { receiptId: transition.receiptId } : {}),
    ...(transition.type === "rejected" ? { rejectionCode: transition.code } : {}),
  }
}
