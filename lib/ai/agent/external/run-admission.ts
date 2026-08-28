/**
 * Admit one run against a host-owned external-agent configuration.
 *
 * The browser holds the Composer, the host holds the process. Between them sits
 * a question nothing answered before this module: *is the thing I am about to
 * spawn still the thing the user approved?* A configuration blob sent per turn
 * cannot answer it — the browser could send anything, and a config that was
 * edited, disabled or had its credential revoked one second ago would still
 * spawn. So the browser sends a **stamp** (which configuration, which revision,
 * which readiness generation) and the host resolves it against its own store.
 *
 * Admission is two checks, deliberately not one:
 *
 *   1. **The stamp** — `admitExternalAgentConfig` compares the caller's
 *      revision and generation against the head. This is cheap, transactional,
 *      and answers "are we talking about the same configuration?".
 *   2. **Live readiness** — the stored `lifecycleStatus` is a cached verdict
 *      from the last reconciliation, which may be minutes old. A keyring entry
 *      deleted since then leaves a config still marked `ready`. So the
 *      credential, runtime, integrity and adapter facts are re-derived *now*,
 *      before the run is acknowledged.
 *
 * Only after both pass is the revision leased. Leasing first would pin
 * revisions for runs that were then refused, and the lease is what
 * `collectExternalAgentConfigRevisions` reads to decide what it may delete.
 *
 * Nothing here installs, downloads or repairs anything. A missing adapter is a
 * refusal, never an auto-install: the plan's rule is that the host runs what
 * the user already approved and nothing else.
 */

import {
  admitExternalAgentConfig,
  collectExternalAgentConfigRevisions,
  leaseExternalAgentConfigRevision,
  releaseExternalAgentConfigLeases,
} from "@/lib/db/external-agent-configs"
import type {
  ExternalAgentConfigRecord,
  ExternalAgentConfigRejection,
  ExternalAgentConfigStamp,
} from "@/types/agent/external-agent-config-store"
import type { StoredExternalAgentConfig } from "@/stores/agent/external-agent-store/types"
import type {
  ExternalAgentLifecycleErrorCode,
  ExternalAgentLifecycleStatus,
} from "@/types/agent/external-agent-lifecycle"
import type { LifecycleAgentConfig } from "./lifecycle/credentials"
import type { ReadinessAssessor } from "./host-config-service"
import { defaultReadinessAssessor } from "./host-config-service"

/**
 * Why a run was refused.
 *
 * Two kinds because they need different handling by the caller: a `config`
 * refusal is answered by re-reading the configuration and retrying with a fresh
 * stamp, while a `readiness` refusal needs a human — a credential to provision,
 * a runtime to install, a consent to grant. Collapsing them into one string
 * would make "press retry" and "go fix something" indistinguishable.
 */
export type RunAdmissionRefusal =
  | { kind: "config"; reason: ExternalAgentConfigRejection; current?: ExternalAgentConfigRecord }
  | {
      kind: "readiness"
      status: ExternalAgentLifecycleStatus
      reasonCode?: ExternalAgentLifecycleErrorCode
      reason?: string
      current: ExternalAgentConfigRecord
    }

export interface AdmittedRun {
  runId: string
  record: ExternalAgentConfigRecord
  /**
   * The configuration to launch — read from the leased revision, never from
   * the caller. This is the whole point: the bytes that spawn are the bytes the
   * host stored, not the bytes a browser sent.
   */
  config: StoredExternalAgentConfig
}

export type RunAdmission =
  { ok: true; run: AdmittedRun } | { ok: false; refusal: RunAdmissionRefusal }

export interface RunAdmissionDeps {
  /** Live readiness. Injected so admission is testable without a keyring. */
  assessReadiness: ReadinessAssessor
}

async function resolveDeps(deps?: Partial<RunAdmissionDeps>): Promise<RunAdmissionDeps> {
  return { assessReadiness: deps?.assessReadiness ?? (await defaultReadinessAssessor()) }
}

/**
 * Admit `runId` against `stamp`, leasing the revision on success.
 *
 * The lease is taken last and only on success. A caller that receives `ok`
 * owes exactly one `releaseExternalAgentRun(runId)` when the run reaches a
 * terminal state, or the revision is pinned forever and never collected.
 */
export async function admitExternalAgentRun(
  runId: string,
  stamp: ExternalAgentConfigStamp,
  deps?: Partial<RunAdmissionDeps>
): Promise<RunAdmission> {
  const admission = await admitExternalAgentConfig(stamp)
  if (!admission.ok) {
    return {
      ok: false,
      refusal: { kind: "config", reason: admission.reason, current: admission.current },
    }
  }

  const record = admission.record
  const { assessReadiness } = await resolveDeps(deps)
  const verdict = await assessReadiness(record.config as unknown as LifecycleAgentConfig)
  if (verdict.status !== "ready") {
    return {
      ok: false,
      refusal: {
        kind: "readiness",
        status: verdict.status,
        reasonCode: verdict.reasonCode,
        reason: verdict.reason,
        current: record,
      },
    }
  }

  await leaseExternalAgentConfigRevision(record.revision, runId)
  return { ok: true, run: { runId, record, config: record.config } }
}

/**
 * Release every revision this run pinned, then sweep what that freed.
 *
 * Idempotent and safe for an unknown run, because the caller cannot always know
 * whether admission succeeded — a run that failed between ACK and spawn must
 * still be releasable without the caller tracking which half happened.
 *
 * The sweep runs here because this is the moment a revision can become
 * collectable: `collectExternalAgentConfigRevisions` only takes revisions that
 * are unleased, superseded and past retention, and the lease is what just
 * changed. Nothing else schedules it, and without a caller the retention
 * window is a comment rather than a policy — superseded revisions, each
 * holding a full configuration, would accumulate for the life of the database.
 * A failure is swallowed: a sweep that could not run is a deferred cleanup,
 * not a reason to fail the release its caller actually asked for.
 */
export async function releaseExternalAgentRun(runId: string): Promise<void> {
  await releaseExternalAgentConfigLeases(runId)
  try {
    await collectExternalAgentConfigRevisions()
  } catch {
    // Best effort — the next release (or reconciliation) sweeps again.
  }
}

/**
 * What a configuration change does to runs already admitted against it.
 *
 * The distinction is the difference between "you may not start another" and
 * "stop what you are doing":
 *
 *   - **drain** — the configuration was disabled or deleted. The run holds a
 *     lease on an immutable revision, so what it is executing is still exactly
 *     what was approved; nothing about it became unsafe. Killing it would lose
 *     work for a bookkeeping change.
 *   - **cancel** — readiness moved off `ready`. A credential was revoked, a
 *     consent withdrawn, an integrity check started failing. The authority the
 *     run is executing under is gone, so it stops now.
 *
 * Note the asymmetry with `applyVerdict`, which forces `enabled = false`
 * whenever a config is not ready. That is why readiness is tested *first*: a
 * config that went unready is also disabled, and reading `enabled` first would
 * misreport every revocation as a drain.
 */
export type RevocationEffect = "none" | "drain" | "cancel"

export function revocationEffect(
  before: Pick<ExternalAgentConfigRecord, "enabled" | "lifecycleStatus" | "tombstonedAt">,
  after: Pick<ExternalAgentConfigRecord, "enabled" | "lifecycleStatus" | "tombstonedAt">
): RevocationEffect {
  if (before.lifecycleStatus === "ready" && after.lifecycleStatus !== "ready") return "cancel"
  if (after.tombstonedAt !== undefined && before.tombstonedAt === undefined) return "drain"
  if (before.enabled && !after.enabled) return "drain"
  return "none"
}
