/** @jest-environment jsdom */

import "fake-indexeddb/auto"

import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import {
  createExternalAgentConfig,
  deleteExternalAgentConfig,
  listExternalAgentConfigRevisions,
  updateExternalAgentConfig,
} from "@/lib/db/external-agent-configs"
import type { ExternalAgentConfigRecord } from "@/types/agent/external-agent-config-store"
import type { StoredExternalAgentConfig } from "@/stores/agent/external-agent-store/types"

import {
  admitExternalAgentRun,
  releaseExternalAgentRun,
  revocationEffect,
  type RunAdmissionDeps,
} from "./run-admission"

function config(overrides: Partial<StoredExternalAgentConfig> = {}): StoredExternalAgentConfig {
  return {
    id: "ignored",
    name: "Pi",
    protocol: "pi-rpc",
    transport: "stdio",
    enabled: true,
    lifecycleStatus: "ready",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as StoredExternalAgentConfig
}

const live: RunAdmissionDeps = { assessReadiness: async () => ({ status: "ready" }) }

function stampOf(record: ExternalAgentConfigRecord) {
  return {
    configId: record.configId,
    revision: record.revision,
    lifecycleGeneration: record.lifecycleGeneration,
  }
}

beforeEach(async () => {
  await __resetDbForTesting()
})

describe("admitExternalAgentRun", () => {
  it("admits a matching stamp and leases the revision", async () => {
    const created = await createExternalAgentConfig({ config: config() })
    const result = await admitExternalAgentRun("run-1", stampOf(created), live)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.run.record.configId).toBe(created.configId)

    const [revision] = await listExternalAgentConfigRevisions(created.configId)
    expect(revision.leaseRuns).toEqual(["run-1"])
  })

  it("returns the stored config, not anything the caller supplied", async () => {
    const created = await createExternalAgentConfig({ config: config({ name: "Approved" }) })
    const result = await admitExternalAgentRun("run-1", stampOf(created), live)
    expect(result.ok && result.run.config.name).toBe("Approved")
  })

  it("refuses a stale revision as a config refusal and leases nothing", async () => {
    const created = await createExternalAgentConfig({ config: config() })
    const stale = stampOf(created)
    await updateExternalAgentConfig({
      configId: created.configId,
      expectedRevision: created.revision,
      mutate: (c) => ({ ...c, name: "Renamed" }),
    })

    const result = await admitExternalAgentRun("run-1", stale, live)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.refusal).toMatchObject({ kind: "config", reason: "stale-revision" })

    const revisions = await listExternalAgentConfigRevisions(created.configId)
    expect(revisions.flatMap((r) => r.leaseRuns)).toEqual([])
  })

  it("refuses a tombstoned configuration", async () => {
    const created = await createExternalAgentConfig({ config: config() })
    await deleteExternalAgentConfig(created.configId)
    const result = await admitExternalAgentRun("run-1", stampOf(created), live)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.refusal).toMatchObject({ kind: "config", reason: "deleted" })
  })

  it("refuses an unknown configuration", async () => {
    const result = await admitExternalAgentRun(
      "run-1",
      { configId: "eac_nope", revision: "eacr_nope", lifecycleGeneration: 1 },
      live
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.refusal).toMatchObject({ kind: "config", reason: "unknown-config" })
  })

  it("refuses a disabled configuration", async () => {
    const created = await createExternalAgentConfig({ config: config({ enabled: false }) })
    const result = await admitExternalAgentRun("run-1", stampOf(created), live)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.refusal).toMatchObject({ kind: "config", reason: "disabled" })
  })

  // The whole reason live assessment exists: the stored verdict says ready
  // because that was true at the last reconciliation. Nothing rewrites the row
  // when a keyring entry is deleted out from under it.
  it("refuses when live readiness disagrees with the stored verdict", async () => {
    const created = await createExternalAgentConfig({ config: config() })
    const result = await admitExternalAgentRun("run-1", stampOf(created), {
      assessReadiness: async () => ({
        status: "needs-credentials",
        reasonCode: "credential_missing",
        reason: "no keyring entry",
      }),
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.refusal).toMatchObject({
      kind: "readiness",
      status: "needs-credentials",
      reasonCode: "credential_missing",
    })
  })

  it("leases nothing when live readiness refuses", async () => {
    const created = await createExternalAgentConfig({ config: config() })
    await admitExternalAgentRun("run-1", stampOf(created), {
      assessReadiness: async () => ({ status: "blocked" }),
    })
    const revisions = await listExternalAgentConfigRevisions(created.configId)
    expect(revisions.flatMap((r) => r.leaseRuns)).toEqual([])
  })

  it("assesses the stored configuration, never the caller's", async () => {
    const created = await createExternalAgentConfig({ config: config({ name: "Stored" }) })
    const seen: string[] = []
    await admitExternalAgentRun("run-1", stampOf(created), {
      assessReadiness: async (c) => {
        seen.push((c as { name?: string }).name ?? "")
        return { status: "ready" }
      },
    })
    expect(seen).toEqual(["Stored"])
  })

  it("is idempotent for the same run id", async () => {
    const created = await createExternalAgentConfig({ config: config() })
    await admitExternalAgentRun("run-1", stampOf(created), live)
    await admitExternalAgentRun("run-1", stampOf(created), live)
    const [revision] = await listExternalAgentConfigRevisions(created.configId)
    expect(revision.leaseRuns).toEqual(["run-1"])
  })

  it("holds independent leases for two runs on one revision", async () => {
    const created = await createExternalAgentConfig({ config: config() })
    await admitExternalAgentRun("run-a", stampOf(created), live)
    await admitExternalAgentRun("run-b", stampOf(created), live)
    await releaseExternalAgentRun("run-a")
    const [revision] = await listExternalAgentConfigRevisions(created.configId)
    expect(revision.leaseRuns).toEqual(["run-b"])
  })
})

describe("releaseExternalAgentRun", () => {
  it("drops the lease", async () => {
    const created = await createExternalAgentConfig({ config: config() })
    await admitExternalAgentRun("run-1", stampOf(created), live)
    await releaseExternalAgentRun("run-1")
    const [revision] = await listExternalAgentConfigRevisions(created.configId)
    expect(revision.leaseRuns).toEqual([])
  })

  it("is safe for a run that was never admitted", async () => {
    await expect(releaseExternalAgentRun("never")).resolves.toBeUndefined()
  })
})

describe("revocationEffect", () => {
  const at = (
    over: Partial<Pick<ExternalAgentConfigRecord, "enabled" | "lifecycleStatus" | "tombstonedAt">>
  ) => ({ enabled: true, lifecycleStatus: "ready" as const, ...over })

  it("cancels when readiness leaves ready", () => {
    expect(
      revocationEffect(at({}), at({ lifecycleStatus: "needs-credentials", enabled: false }))
    ).toBe("cancel")
  })

  // The ordering test. `applyVerdict` disables anything unready, so a
  // revocation always looks like a disable too; reading `enabled` first would
  // report every credential revocation as a drain and let the run continue.
  it("cancels a revocation even though it also disabled the config", () => {
    const before = at({ enabled: true, lifecycleStatus: "ready" })
    const after = at({ enabled: false, lifecycleStatus: "blocked" })
    expect(revocationEffect(before, after)).toBe("cancel")
  })

  it("drains a plain disable", () => {
    expect(revocationEffect(at({}), at({ enabled: false }))).toBe("drain")
  })

  it("drains a delete", () => {
    expect(revocationEffect(at({}), at({ tombstonedAt: 5 }))).toBe("drain")
  })

  it("reports nothing for an ordinary edit", () => {
    expect(revocationEffect(at({}), at({}))).toBe("none")
  })

  it("reports nothing when a config was already disabled", () => {
    expect(revocationEffect(at({ enabled: false }), at({ enabled: false }))).toBe("none")
  })

  it("reports nothing when a config was already unready", () => {
    const unready = at({ enabled: false, lifecycleStatus: "needs-runtime" as const })
    expect(revocationEffect(unready, unready)).toBe("none")
  })
})

describe("database wiring", () => {
  it("keeps the lease visible through the multi-entry index", async () => {
    const created = await createExternalAgentConfig({ config: config() })
    await admitExternalAgentRun("run-1", stampOf(created), live)
    const db = getDb()
    const held = await db.externalAgentConfigRevisions.where("leaseRuns").equals("run-1").toArray()
    expect(held).toHaveLength(1)
  })
})
