export type ServiceStatus =
  "operational" | "maintenance" | "degraded" | "partial_outage" | "major_outage"

export type IncidentState = "investigating" | "identified" | "monitoring" | "resolved"

export type StatusComponentId =
  "controlPlane" | "agentRuntime" | "realtimeGateway" | "artifactStorage" | "webApp"

export type RegionId = "northAmerica" | "europe" | "asiaPacific"

export interface DailyAvailability {
  date: string
  status: ServiceStatus
  availabilityPercent: number
}

export interface LatencySample {
  at: string
  valueMs: number
}

export interface RegionStatus {
  id: RegionId
  status: ServiceStatus
  latencyMs: number
}

export interface StatusComponent {
  id: StatusComponentId
  status: ServiceStatus
  history: DailyAvailability[]
  latency24h: LatencySample[]
  regions: RegionStatus[]
  lastCheckedAt: string
}

export interface IncidentUpdate {
  id: string
  state: IncidentState
  at: string
}

export interface Incident {
  id: "apacRuntimeLatency" | "realtimeDisconnects" | "storageReadErrors"
  impact: Exclude<ServiceStatus, "operational" | "maintenance">
  componentIds: StatusComponentId[]
  startedAt: string
  resolvedAt: string | null
  updates: IncidentUpdate[]
}

export interface ScheduledMaintenance {
  id: "controlPlaneDatabase"
  componentIds: StatusComponentId[]
  startsAt: string
  endsAt: string
}

export interface PublicStatusSnapshot {
  mode: "preview"
  generatedAt: string
  components: StatusComponent[]
  activeIncidents: Incident[]
  scheduledMaintenance: ScheduledMaintenance[]
  pastIncidents: Incident[]
}

const STATUS_SEVERITY: Record<ServiceStatus, number> = {
  operational: 0,
  maintenance: 1,
  degraded: 2,
  partial_outage: 3,
  major_outage: 4,
}

const GENERATED_AT = "2026-08-11T08:42:00.000Z"
const HISTORY_END_UTC = Date.UTC(2026, 7, 11)

export function deriveOverallStatus(statuses: readonly ServiceStatus[]): ServiceStatus {
  return statuses.reduce<ServiceStatus>(
    (mostSevere, status) =>
      STATUS_SEVERITY[status] > STATUS_SEVERITY[mostSevere] ? status : mostSevere,
    "operational"
  )
}

export function calculateUptime(history: readonly DailyAvailability[]): number {
  if (history.length === 0) return 100
  const total = history.reduce((sum, day) => sum + day.availabilityPercent, 0)
  return Math.round((total / history.length) * 100) / 100
}

export function sortIncidentUpdatesNewestFirst<T extends { at: string }>(
  updates: readonly T[]
): T[] {
  return [...updates].sort((left, right) => right.at.localeCompare(left.at))
}

export function createPreviewStatusSnapshot(
  variant: "degraded" | "operational" = "degraded"
): PublicStatusSnapshot {
  const snapshot: PublicStatusSnapshot = {
    mode: "preview",
    generatedAt: GENERATED_AT,
    components: [
      createComponent("controlPlane", "operational", 58, {
        36: { status: "maintenance", availabilityPercent: 100 },
      }),
      createComponent("agentRuntime", "degraded", 182, {
        57: { status: "partial_outage", availabilityPercent: 96.5 },
        89: { status: "degraded", availabilityPercent: 99.18 },
      }),
      createComponent("realtimeGateway", "operational", 42, {
        73: { status: "degraded", availabilityPercent: 99.71 },
      }),
      createComponent("artifactStorage", "operational", 76, {
        22: { status: "partial_outage", availabilityPercent: 95.61 },
      }),
      createComponent("webApp", "operational", 31),
    ],
    activeIncidents: [
      {
        id: "apacRuntimeLatency",
        impact: "degraded",
        componentIds: ["agentRuntime"],
        startedAt: "2026-08-11T07:58:00.000Z",
        resolvedAt: null,
        updates: [
          { id: "investigating", state: "investigating", at: "2026-08-11T07:58:00.000Z" },
          { id: "identified", state: "identified", at: "2026-08-11T08:16:00.000Z" },
          { id: "monitoring", state: "monitoring", at: "2026-08-11T08:31:00.000Z" },
        ],
      },
    ],
    scheduledMaintenance: [
      {
        id: "controlPlaneDatabase",
        componentIds: ["controlPlane"],
        startsAt: "2026-08-14T01:00:00.000Z",
        endsAt: "2026-08-14T02:00:00.000Z",
      },
    ],
    pastIncidents: [
      {
        id: "realtimeDisconnects",
        impact: "degraded",
        componentIds: ["realtimeGateway"],
        startedAt: "2026-07-26T14:12:00.000Z",
        resolvedAt: "2026-07-26T15:04:00.000Z",
        updates: [
          { id: "investigating", state: "investigating", at: "2026-07-26T14:12:00.000Z" },
          { id: "resolved", state: "resolved", at: "2026-07-26T15:04:00.000Z" },
        ],
      },
      {
        id: "storageReadErrors",
        impact: "partial_outage",
        componentIds: ["artifactStorage"],
        startedAt: "2026-06-18T03:20:00.000Z",
        resolvedAt: "2026-06-18T04:07:00.000Z",
        updates: [
          { id: "investigating", state: "investigating", at: "2026-06-18T03:20:00.000Z" },
          { id: "identified", state: "identified", at: "2026-06-18T03:38:00.000Z" },
          { id: "resolved", state: "resolved", at: "2026-06-18T04:07:00.000Z" },
        ],
      },
    ],
  }

  if (variant === "degraded") return snapshot

  return {
    ...snapshot,
    components: snapshot.components.map((component) => ({
      ...component,
      status: "operational",
      history: component.history.map((day) => ({
        ...day,
        status: "operational",
        availabilityPercent: 100,
      })),
      regions: component.regions.map((region) => ({ ...region, status: "operational" })),
    })),
    activeIncidents: [],
  }
}

function createComponent(
  id: StatusComponentId,
  status: ServiceStatus,
  baseLatencyMs: number,
  anomalies: Record<number, Pick<DailyAvailability, "status" | "availabilityPercent">> = {}
): StatusComponent {
  return {
    id,
    status,
    history: createHistory(anomalies),
    latency24h: createLatencySeries(baseLatencyMs, id === "agentRuntime" && status === "degraded"),
    regions: (["northAmerica", "europe", "asiaPacific"] as const).map((region, index) => ({
      id: region,
      status: id === "agentRuntime" && region === "asiaPacific" ? status : "operational",
      latencyMs:
        baseLatencyMs +
        index * 17 +
        (region === "asiaPacific" ? 12 : 0) +
        (id === "agentRuntime" && region === "asiaPacific" && status === "degraded" ? 78 : 0),
    })),
    lastCheckedAt: GENERATED_AT,
  }
}

function createHistory(
  anomalies: Record<number, Pick<DailyAvailability, "status" | "availabilityPercent">>
): DailyAvailability[] {
  return Array.from({ length: 90 }, (_, index) => {
    const date = new Date(HISTORY_END_UTC - (89 - index) * 86_400_000).toISOString().slice(0, 10)
    return {
      date,
      status: anomalies[index]?.status ?? "operational",
      availabilityPercent: anomalies[index]?.availabilityPercent ?? 100,
    }
  })
}

function createLatencySeries(baseLatencyMs: number, elevated: boolean): LatencySample[] {
  const pattern = [0, 4, -3, 7, 2, -1, 5, 9, 3, 1, 6, 12] as const
  return Array.from({ length: 24 }, (_, index) => {
    const at = new Date(Date.parse(GENERATED_AT) - (23 - index) * 3_600_000).toISOString()
    const incidentLift = elevated && index >= 19 ? (index - 18) * 28 : 0
    return { at, valueMs: baseLatencyMs + pattern[index % pattern.length] + incidentLift }
  })
}
