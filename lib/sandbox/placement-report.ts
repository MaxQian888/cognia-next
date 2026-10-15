/**
 * What actually ran, as the Host reports it (ADR-0182).
 *
 * A placement says what the brain *asked for*. This is the other half: the
 * Host answers on `external-agent://placement` with the tier it could really
 * attest, the user the image really runs as, the digests it really pulled —
 * and, when the run fell back, the `sandbox_fallback_*` reason.
 *
 * # Why the answer is not the request
 *
 * Three of these differ from what was asked on purpose:
 *
 * - **tier** — a project asks for a floor; the driver attests what it has. A
 *   run that asked for `container` on a daemon with `runsc` registered can be
 *   given gVisor, and the UI must say which it got.
 * - **user** — `remoteUser` is remapped onto the workspace owner, and an
 *   image that declares none gets the tier default. Neither is visible in the
 *   spec.
 * - **egressEnforced / credentialsMode** — Step ① enforces egress only on the
 *   `off` tier, and the Host says so rather than letting a UI infer
 *   enforcement from a policy that is only recorded.
 *
 * So a UI that rendered the request would be lying about all three. Every
 * surface reads this report instead.
 *
 * # The wire shape
 *
 * `{agentId, placement}` — see `SandboxPlacementEvent`. This module flattens
 * it into one record per agent so a surface never walks the nesting, and so
 * a field a Host did not send is `undefined` rather than a guess.
 */

import type {
  EgressTier,
  IsolationTier,
  WorkspacePublishRecovery,
  WorkspacePublishReport,
  TaskDeliveryRecord,
} from "@/types/sandbox/environment-spec"
import {
  SANDBOX_PLACEMENT_CHANNEL,
  WORKSPACE_PUBLISH_CHANNEL,
} from "@/types/sandbox/environment-spec"

const ISOLATION_TIERS: readonly IsolationTier[] = ["container", "gvisor", "vm"]
const EGRESS_TIERS: readonly EgressTier[] = ["off", "allowlist", "on"]

/** One agent's placement as the Host reported it. */
export interface SandboxPlacementReport {
  agentId: string
  /**
   * `sandbox` when it ran in one, `fallback` when the placement was stripped,
   * `unknown` for a kind this build does not recognize.
   */
  kind: "sandbox" | "fallback" | "unknown"
  /** The `sandbox_fallback_*` reason, on a fallback. */
  code?: string
  message?: string
  driver?: string
  specDigest?: string
  /** The canonical pinned reference the sandbox ran, `registry/repository@sha256:…`. */
  image?: string
  /** The `sha256:…` part of `image`. */
  imageDigest?: string
  sizeClassId?: string
  tier?: IsolationTier
  bundleDigest?: string
  bundleReleaseTag?: string
  libc?: string
  user?: string
  uid?: number
  /** True when a declared user was remapped onto the workspace owner. */
  userRemapped?: boolean
  egressTier?: EgressTier
  /**
   * Whether egress is actually enforced for this sandbox. `false` through
   * Step ① on every tier but `off` — the enforcing proxy arrives with
   * ADR-0185, and a UI that showed "allowlist" as enforcement would be
   * claiming a control nothing applies yet.
   */
  egressEnforced?: boolean
  /**
   * How the sandbox got its provider credentials. Ambient provider keys are
   * stripped before the container sees them, so this is `gateway-lease` when
   * a managed gateway task's per-task lease rode in and `none` otherwise.
   * Per-sandbox gateway tickets for ordinary spawns are ADR-0185.
   */
  credentialsMode?: string
  /** The remote provider that ran it (ADR-0221); absent for the local driver. */
  provider?: string
  /** A remote workspace: the repository it cloned, from where, onto which branch. */
  workspace?: { remoteUrl?: string; baseRef?: string; branch?: string }
  /**
   * What the Host did with a remote workspace when the session ended, from
   * `external-agent://workspace-publish`. Absent until it reports.
   */
  publish?: WorkspacePublishReport
  delivery?: TaskDeliveryRecord
  /** Set only by a live placement; historical records cannot select another session. */
  deliveryRecordId?: string
  deliveryRecordError?: { code: string; message?: string }
}

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined

const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined

const object = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {}

const oneOf = <T extends string>(allowed: readonly T[], value: unknown): T | undefined =>
  typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined

/**
 * Read a placement event into a report.
 *
 * Tolerant by construction: the event comes from a Host that may be newer or
 * older than this client, and a field it does not send is absent rather than
 * wrong. `kind` falls back to `"unknown"` for the same reason — a client that
 * guessed "sandbox" for an unrecognized kind would claim a sandbox ran.
 */
export function readPlacementEvent(payload: unknown): SandboxPlacementReport | null {
  const event = object(payload)
  const agentId = text(event.agentId)
  if (!agentId) return null
  const placement = object(event.placement)
  const kind =
    placement.kind === "sandbox" || placement.kind === "fallback"
      ? placement.kind
      : ("unknown" as const)

  const report: SandboxPlacementReport = { agentId, kind }
  const set = <K extends keyof SandboxPlacementReport>(
    key: K,
    value: SandboxPlacementReport[K] | undefined
  ) => {
    if (value !== undefined) report[key] = value
  }

  if (kind === "fallback") {
    set("code", text(placement.code))
    set("message", text(placement.message))
    return report
  }
  if (kind !== "sandbox") return report

  const image = text(placement.image)
  set("driver", text(placement.driver))
  set("specDigest", text(placement.specDigest))
  set("image", image)
  set("imageDigest", image?.includes("@") ? image.slice(image.lastIndexOf("@") + 1) : undefined)
  set("sizeClassId", text(placement.sizeClassId))
  set("tier", oneOf(ISOLATION_TIERS, placement.isolationTier))

  const bundle = object(placement.bundle)
  set("bundleDigest", text(bundle.digest))
  set("bundleReleaseTag", text(bundle.releaseTag))
  set("libc", text(bundle.libc))

  const user = object(placement.user)
  set("user", text(user.name))
  set("uid", typeof user.uid === "number" ? user.uid : undefined)
  if ("remappedFrom" in user) {
    set("userRemapped", user.remappedFrom !== null && user.remappedFrom !== undefined)
  }

  // `enforced: false` is a claim, and a missing field is a Host that did not
  // say. Collapsing them would let a UI print "not enforced" about a Host
  // that never answered the question.
  const egress = object(placement.egress)
  set("egressTier", oneOf(EGRESS_TIERS, egress.tier))
  set("egressEnforced", typeof egress.enforced === "boolean" ? egress.enforced : undefined)

  set("credentialsMode", text(object(placement.credentials).mode))

  set("provider", text(placement.provider))
  set("deliveryRecordId", text(placement.deliveryRecordId))
  const workspace = object(placement.workspace)
  const remoteWorkspace = {
    ...(text(workspace.remoteUrl) ? { remoteUrl: text(workspace.remoteUrl) } : {}),
    ...(text(workspace.baseRef) ? { baseRef: text(workspace.baseRef) } : {}),
    ...(text(workspace.branch) ? { branch: text(workspace.branch) } : {}),
  }
  set("workspace", Object.keys(remoteWorkspace).length > 0 ? remoteWorkspace : undefined)
  return report
}

/**
 * Read a workspace-publish event (ADR-0221 D6). `null` for one that names no
 * agent; every other field is kept only when it has the expected type.
 */
export function readWorkspacePublishEvent(payload: unknown): {
  agentId: string
  publish: WorkspacePublishReport
  delivery?: TaskDeliveryRecord
  deliveryRecordId?: string
  deliveryRecordError?: { code: string; message?: string }
} | null {
  const event = object(payload)
  const agentId = text(event.agentId)
  if (!agentId) return null
  const raw = object(event.publish)
  const publish: WorkspacePublishReport = {}
  if (text(raw.branch)) publish.branch = text(raw.branch)
  if (typeof raw.pushed === "boolean") publish.pushed = raw.pushed
  if (text(raw.commit)) publish.commit = text(raw.commit)
  if (text(raw.code)) publish.code = text(raw.code)
  if (text(raw.message)) publish.message = text(raw.message)
  if (raw.held === true) publish.held = true
  if (raw.discarded === true) publish.discarded = true
  const rawRecovery = object(raw.recovery)
  const recovery: WorkspacePublishRecovery = {}
  if (text(rawRecovery.bundle)) recovery.bundle = text(rawRecovery.bundle)
  if (text(rawRecovery.commit)) recovery.commit = text(rawRecovery.commit)
  if (count(rawRecovery.commits) !== undefined) recovery.commits = count(rawRecovery.commits)
  if (count(rawRecovery.bytes) !== undefined) recovery.bytes = count(rawRecovery.bytes)
  if (text(rawRecovery.code)) recovery.code = text(rawRecovery.code)
  if (text(rawRecovery.message)) recovery.message = text(rawRecovery.message)
  if (Object.keys(recovery).length > 0) publish.recovery = recovery
  const delivery = readTaskDeliveryRecord(raw.deliveryRecord)
  const failure = object(raw.deliveryRecordError)
  const deliveryRecordError = text(failure.code)
    ? {
        code: text(failure.code)!,
        ...(text(failure.message) ? { message: text(failure.message) } : {}),
      }
    : undefined
  return {
    agentId,
    publish,
    ...(delivery?.agentId === agentId ? { delivery } : {}),
    ...(text(raw.deliveryRecordId) ? { deliveryRecordId: text(raw.deliveryRecordId) } : {}),
    ...(deliveryRecordError ? { deliveryRecordError } : {}),
  }
}

/**
 * Attach a publish to the agent's report. A publish for an agent with no
 * report yet (this client subscribed after the spawn) still records one, so
 * the outcome of the session is not lost.
 */
export function recordWorkspacePublish(
  agentId: string,
  publish: WorkspacePublishReport,
  host?: object,
  deliveryRecordError?: { code: string; message?: string },
  deliveryRecordId?: string
): void {
  const previous = sandboxPlacementReport(agentId, host)
  const current = previous ?? { agentId, kind: "sandbox" as const }
  if (
    deliveryRecordId &&
    previous &&
    (previous.deliveryRecordId ?? previous.delivery?.id) !== deliveryRecordId
  )
    return
  recordPlacementReport(
    {
      ...current,
      publish:
        deliveryRecordError && publish.code === "sandbox_delivery_store_failed" && current.publish
          ? current.publish
          : publish,
      deliveryRecordError,
      ...(deliveryRecordId ? { deliveryRecordId } : {}),
    },
    host
  )
}

/** In-memory projections are scoped to a transport; the Host owns durable history. */
const reports = new Map<object | undefined, Map<string, SandboxPlacementReport>>()
const deliveries = new Map<object | undefined, Map<string, readonly TaskDeliveryRecord[]>>()
const listeners = new Set<(report: SandboxPlacementReport, host?: object) => void>()
const EMPTY_DELIVERIES: readonly TaskDeliveryRecord[] = []

export function recordPlacementReport(report: SandboxPlacementReport, host?: object): void {
  let scoped = reports.get(host)
  if (!scoped) reports.set(host, (scoped = new Map()))
  scoped.set(report.agentId, report)
  for (const listener of listeners) listener(report, host)
}

export function sandboxPlacementReport(
  agentId: string,
  host?: object
): SandboxPlacementReport | undefined {
  return reports.get(host)?.get(agentId)
}

export function sandboxDeliveryRecords(
  agentId: string,
  host?: object
): readonly TaskDeliveryRecord[] {
  return deliveries.get(host)?.get(agentId) ?? EMPTY_DELIVERIES
}

/** Boundary parser shared by list snapshots and live publish notifications. */
export function readTaskDeliveryRecord(value: unknown): TaskDeliveryRecord | undefined {
  const raw = object(value)
  const required = ["id", "agentId", "providerId", "instanceId", "branch"] as const
  if (required.some((key) => !text(raw[key]))) return undefined
  const publishState = oneOf<TaskDeliveryRecord["publishState"]>(
    ["running", "pushed", "savedBundle", "held", "discarded", "nothingToPublish", "failed"],
    raw.publishState
  )
  const cleanupState = oneOf<TaskDeliveryRecord["cleanupState"]>(
    ["retained", "pending", "destroyRetrying", "destroyed"],
    raw.cleanupState
  )
  if (
    !publishState ||
    !cleanupState ||
    [raw.createdAt, raw.updatedAt, raw.revision].some((v) => count(v) === undefined)
  )
    return undefined
  // Strip nested delivery metadata before parsing so malformed recursive input cannot recurse.
  const publish = readWorkspacePublishEvent({
    agentId: raw.agentId,
    publish: { ...object(raw.publish), deliveryRecord: undefined },
  })!.publish
  return {
    id: raw.id as string,
    agentId: raw.agentId as string,
    providerId: raw.providerId as string,
    instanceId: raw.instanceId as string,
    branch: raw.branch as string,
    ...(text(raw.taskId) ? { taskId: text(raw.taskId) } : {}),
    ...(text(raw.commit) ? { commit: text(raw.commit) } : {}),
    publishState,
    cleanupState,
    publish,
    createdAt: raw.createdAt as number,
    updatedAt: raw.updatedAt as number,
    revision: raw.revision as number,
  }
}

/** A persisted snapshot must account for an outcome whose write failed. */
function persistedPublishCovers(live: WorkspacePublishReport, record: TaskDeliveryRecord): boolean {
  // A held workspace can subsequently be delivered or expire; a saved bundle
  // can subsequently be pushed. These are forward transitions for one session.
  if (live.held && ["pushed", "savedBundle", "discarded"].includes(record.publishState)) return true
  if (live.recovery?.bundle && record.publishState === "pushed") return true
  // Host records omit diagnostic messages because they may contain git output.
  const fields = ["branch", "pushed", "commit", "code", "held", "discarded"] as const
  const recoveryFields = ["bundle", "commit", "commits", "bytes", "code"] as const
  return (
    fields.every((key) => live[key] === record.publish[key]) &&
    recoveryFields.every((key) => live.recovery?.[key] === record.publish.recovery?.[key])
  )
}

/** Merge by session identity and revision; late snapshots cannot undo live events. */
export function recordTaskDelivery(record: TaskDeliveryRecord, host?: object): void {
  const previous = sandboxDeliveryRecords(record.agentId, host)
  const existing = previous.find((item) => item.id === record.id)
  const changed = !existing || existing.revision < record.revision
  const next = changed
    ? [...previous.filter((item) => item.id !== record.id), record].sort(
        (a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id)
      )
    : previous
  if (changed) {
    let scoped = deliveries.get(host)
    if (!scoped) deliveries.set(host, (scoped = new Map()))
    scoped.set(record.agentId, next)
  }
  const current = sandboxPlacementReport(record.agentId, host)
  // A live placement is evidence of one exact session. Records for previous
  // sessions still update history but must never replace its provider, image,
  // branch or outcome. Older Hosts without correlation keep their live report.
  if (current && (current.kind !== "sandbox" || (!current.deliveryRecordId && !current.delivery))) {
    if (changed) for (const listener of listeners) listener(current, host)
    return
  }
  const selected = current?.deliveryRecordId
    ? next.find((item) => item.id === current.deliveryRecordId)
    : next[0]
  if (
    !selected ||
    (current?.delivery?.id === selected.id && current.delivery.revision >= selected.revision)
  ) {
    if (changed && current) for (const listener of listeners) listener(current, host)
    return
  }
  // Revision orders successful writes only. A failed write has no revision,
  // so even a higher durable revision may still contain the earlier publish.
  const pendingPublish =
    current?.deliveryRecordError &&
    current.publish &&
    !persistedPublishCovers(current.publish, selected)
  recordPlacementReport(
    {
      ...current,
      agentId: record.agentId,
      kind: "sandbox",
      provider: selected.providerId,
      workspace: { ...current?.workspace, branch: selected.branch },
      publish: pendingPublish
        ? current.publish
        : selected.publishState === "running"
          ? undefined
          : selected.publish,
      delivery: selected,
      deliveryRecordError: pendingPublish ? current.deliveryRecordError : undefined,
    },
    host
  )
}

export function forgetPlacementReport(agentId: string): void {
  reports.get(undefined)?.delete(agentId)
}

/** Subscribe to reports as they arrive. Returns an unsubscribe. */
export function onSandboxPlacementReport(
  listener: (report: SandboxPlacementReport, host?: object) => void
): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function __resetPlacementReportsForTests(): void {
  reports.clear()
  deliveries.clear()
  listeners.clear()
}

/**
 * Start recording what the Host reports.
 *
 * Takes the listen function rather than importing one so the caller decides
 * which host it is talking to — the same reason `agent-transport.ts` exists —
 * and so this module stays free of Tauri and transport imports.
 */
export async function subscribeSandboxPlacements(
  listen: (channel: string, handler: (payload: unknown) => void) => Promise<() => void>,
  host?: object
): Promise<() => void> {
  const placements = await listen(SANDBOX_PLACEMENT_CHANNEL, (payload) => {
    const report = readPlacementEvent(payload)
    if (report) recordPlacementReport(report, host)
  })
  let publishes: () => void
  try {
    publishes = await listen(WORKSPACE_PUBLISH_CHANNEL, (payload) => {
      const event = readWorkspacePublishEvent(payload)
      if (event?.delivery) recordTaskDelivery(event.delivery, host)
      else if (event)
        recordWorkspacePublish(
          event.agentId,
          event.publish,
          host,
          event.deliveryRecordError,
          event.deliveryRecordId
        )
    })
  } catch (error) {
    placements()
    throw error
  }
  return () => {
    placements()
    publishes()
  }
}
