/**
 * The installer UI's pure model (ADR-0235 P5): which stages a plan runs, how
 * stage events move them, and how each failure reads and what it lets the
 * user do next.
 *
 * Kept apart from the hook and the sheet so the decisions that carry the
 * safety rules are pinned without rendering anything: an `unknown` outcome is
 * never retried in place (only a fresh inspection follows it), and a failure
 * that did not reach the machine is the only one offered a plain retry.
 */

import type { InstallerFailure, PlanKind, StageEventPayload, StageName } from "./client"

/** The stages each plan runs after consent, in order. */
export const PLAN_STAGES: Record<PlanKind, readonly StageName[]> = {
  fresh: ["fetch", "upload", "stage", "service", "pair"],
  repair: ["fetch", "upload", "stage", "service", "pair"],
  re_pair: ["pair"],
  uninstall: ["service"],
}

export type StageStatus = "pending" | "running" | "done" | "failed"

export interface StageProgress {
  stage: StageName
  status: StageStatus
}

export function initialProgress(plan: PlanKind): StageProgress[] {
  return PLAN_STAGES[plan].map((stage) => ({ stage, status: "pending" }))
}

/** Fold one stage event in. Stages the plan does not show are ignored. */
export function applyStageEvent(
  progress: readonly StageProgress[],
  event: Pick<StageEventPayload, "stage" | "outcome">
): StageProgress[] {
  return progress.map((entry) => {
    if (entry.stage !== event.stage) return entry
    const status: StageStatus =
      event.outcome === null ? "running" : event.outcome === "ok" ? "done" : "failed"
    return { ...entry, status }
  })
}

/** Mark the running stage failed, for a failure that arrived without its event. */
export function failRunningStage(progress: readonly StageProgress[]): StageProgress[] {
  return progress.map((entry) =>
    entry.status === "running" ? { ...entry, status: "failed" } : entry
  )
}

/**
 * What the user may do after a failure.
 *
 * - `retry`: the step did not reach the machine, so running it again is safe.
 * - `reinspect`: the machine may have changed (an unknown outcome, a stale
 *   inspection); read it again before offering anything.
 * - `reconnect`: the connection itself is gone or was refused.
 * - `none`: something must be fixed first (the machine, the catalog, the
 *   profile); closing and starting over is the way forward.
 */
export type NextStep = "retry" | "reinspect" | "reconnect" | "none"

export function nextStepFor(failure: InstallerFailure): NextStep {
  switch (failure.kind) {
    case "fault":
    case "timeout":
    case "busy":
      return "retry"
    case "unknown":
    case "stale_inspection":
    case "failed":
    case "refused":
    case "not_enough_space":
    case "relay_unavailable":
      return "reinspect"
    case "no_session":
    case "connect":
    case "host_key_changed":
    case "ipc":
      return "reconnect"
    case "unsupported":
    case "release":
    case "denied":
      return "none"
  }
}

const UNSUPPORTED_KEYS = {
  windows: "unsupported.windows",
  os: "unsupported.os",
  arch: "unsupported.arch",
  no_service_manager: "unsupported.noServiceManager",
  glibc_too_old: "unsupported.glibcTooOld",
  glibc_unknown: "unsupported.glibcUnknown",
  no_home: "unsupported.noHome",
} as const

const RELEASE_KEYS = {
  no_trust_root: "release.noTrustRoot",
  unreachable: "release.unreachable",
  no_catalog: "release.noCatalog",
  untrusted: "release.untrusted",
  no_release: "release.noRelease",
  not_an_archive: "release.notAnArchive",
  digest_mismatch: "release.digestMismatch",
  io: "release.io",
} as const

/**
 * The copy for a failure: a key under `devices.hostInstall.failure`, its
 * values, the stage it names (translated by the caller) and the English
 * detail for the support log, which is never the headline.
 */
export interface FailureCopy {
  key: string
  values: Record<string, string | number>
  stage: StageName | null
  detail: string | null
}

export function failureCopy(
  failure: InstallerFailure,
  formatBytes: (bytes: number) => string
): FailureCopy {
  const copy = (
    key: string,
    values: Record<string, string | number> = {},
    stage: StageName | null = null,
    detail: string | null = null
  ): FailureCopy => ({ key, values, stage, detail })
  switch (failure.kind) {
    case "no_session":
      return copy("noSession")
    case "busy":
      return copy("busy")
    case "stale_inspection":
      return copy("stale")
    case "host_key_changed":
      return copy("hostKeyChanged", {
        known: failure.change.knownFingerprint ?? "",
        presented: failure.change.presentedFingerprint,
      })
    case "connect":
      return copy("connect", {}, null, failure.message)
    case "unsupported": {
      const reason = failure.reason
      const values: Record<string, string> =
        reason.cause === "os" || reason.cause === "arch"
          ? { name: reason.name }
          : reason.cause === "glibc_too_old"
            ? { found: reason.found, baseline: reason.baseline }
            : {}
      return copy(UNSUPPORTED_KEYS[reason.cause], values, null, failure.message)
    }
    case "not_enough_space":
      return copy("notEnoughSpace", {
        free: formatBytes(failure.free),
        needed: formatBytes(failure.needed),
      })
    case "release":
      return copy(RELEASE_KEYS[failure.cause], {}, "fetch", failure.message)
    case "denied":
      return copy("denied", {}, null, failure.message)
    case "refused":
      return copy("refused", {}, failure.stage, failure.message)
    case "fault":
      return copy("fault", {}, failure.stage, failure.message)
    case "unknown":
      return copy("unknown", {}, failure.stage, failure.message)
    case "timeout":
      return copy("timeout", {}, failure.stage)
    case "failed":
      return copy("failed", {}, failure.stage, failure.message)
    case "relay_unavailable":
      return copy("relayUnavailable", {}, "pair", failure.message)
    case "ipc":
      return copy("ipc", {}, null, failure.message)
  }
}

/** The plans a machine is offered, in the order the sheet lists them. */
export function orderedOffers(offers: readonly PlanKind[]): PlanKind[] {
  const order: PlanKind[] = ["fresh", "repair", "re_pair", "uninstall"]
  return order.filter((plan) => offers.includes(plan))
}
