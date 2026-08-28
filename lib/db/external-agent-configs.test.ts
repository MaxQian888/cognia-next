/** @jest-environment jsdom */

import "fake-indexeddb/auto"

import type { StoredExternalAgentConfig } from "@/stores/agent/external-agent-store/types"

import { __resetDbForTesting, getDb } from "./schema"
import {
  ExternalAgentConfigConflictError,
  ExternalAgentConfigNotFoundError,
  admitExternalAgentConfig,
  collectExternalAgentConfigRevisions,
  createExternalAgentConfig,
  deleteExternalAgentConfig,
  getExternalAgentConfig,
  leaseExternalAgentConfigRevision,
  listExternalAgentConfigRevisions,
  listExternalAgentConfigs,
  releaseExternalAgentConfigLeases,
  updateExternalAgentConfig,
} from "./external-agent-configs"

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

const stamp = (r: { configId: string; revision: string; lifecycleGeneration: number }) => ({
  configId: r.configId,
  revision: r.revision,
  lifecycleGeneration: r.lifecycleGeneration,
})

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
})

describe("create", () => {
  it("mints its own id and first revision", async () => {
    const record = await createExternalAgentConfig({ config: config() })
    expect(record.configId).toMatch(/^eac_/)
    expect(record.revision).toMatch(/^eacr_/)
    expect(record.seq).toBe(1)
    expect(record.lifecycleGeneration).toBe(1)
    expect(record.config.name).toBe("Pi")
  })

  // An id chosen by a browser is an id an attacker can choose, and a chosen id
  // could collide with a tombstone and inherit its leases.
  it("overwrites a caller-supplied id", async () => {
    const record = await createExternalAgentConfig({ config: config({ id: "attacker-picked" }) })
    expect(record.configId).not.toBe("attacker-picked")
    expect(record.config.id).toBe(record.configId)
  })

  it("never reuses an id across creates", async () => {
    const a = await createExternalAgentConfig({ config: config() })
    const b = await createExternalAgentConfig({ config: config() })
    expect(a.configId).not.toBe(b.configId)
  })
})

describe("read", () => {
  it("resolves the head through to its revision", async () => {
    const created = await createExternalAgentConfig({ config: config({ name: "Codex" }) })
    const read = await getExternalAgentConfig(created.configId)
    expect(read?.config.name).toBe("Codex")
    expect(read?.revision).toBe(created.revision)
  })

  it("returns null for an unknown id", async () => {
    expect(await getExternalAgentConfig("eac_missing")).toBeNull()
  })

  // A head pointing at a revision that is gone is a corrupt store. Resolving it
  // to some other revision would silently run a configuration nobody approved.
  it("reports a dangling head as absent rather than substituting a revision", async () => {
    const created = await createExternalAgentConfig({ config: config() })
    await getDb().externalAgentConfigRevisions.delete(created.revision)
    expect(await getExternalAgentConfig(created.configId)).toBeNull()
  })

  it("lists live configs newest first and hides tombstones by default", async () => {
    const a = await createExternalAgentConfig({ config: config({ name: "A" }), now: 1000 })
    const b = await createExternalAgentConfig({ config: config({ name: "B" }), now: 2000 })
    await deleteExternalAgentConfig(a.configId, 3000)

    expect((await listExternalAgentConfigs()).map((r) => r.config.name)).toEqual(["B"])
    const withDeleted = await listExternalAgentConfigs({ includeDeleted: true })
    expect(withDeleted.map((r) => r.config.name)).toEqual(["A", "B"])
    expect(withDeleted[0].tombstonedAt).toBe(3000)
    void b
  })
})

describe("update — compare and swap", () => {
  it("appends a revision and moves the head", async () => {
    const created = await createExternalAgentConfig({ config: config() })
    const updated = await updateExternalAgentConfig({
      configId: created.configId,
      expectedRevision: created.revision,
      mutate: (c) => ({ ...c, name: "Renamed" }),
    })

    expect(updated.revision).not.toBe(created.revision)
    expect(updated.seq).toBe(2)
    expect(updated.config.name).toBe("Renamed")
    const history = await listExternalAgentConfigRevisions(created.configId)
    expect(history.map((r) => r.seq)).toEqual([1, 2])
    // The old revision is untouched — that is what makes a lease meaningful.
    expect(history[0].config.name).toBe("Pi")
  })

  it("refuses a stale revision and hands back the winner", async () => {
    const created = await createExternalAgentConfig({ config: config() })
    await updateExternalAgentConfig({
      configId: created.configId,
      expectedRevision: created.revision,
      mutate: (c) => ({ ...c, name: "First" }),
    })

    await expect(
      updateExternalAgentConfig({
        configId: created.configId,
        expectedRevision: created.revision,
        mutate: (c) => ({ ...c, name: "Second" }),
      })
    ).rejects.toBeInstanceOf(ExternalAgentConfigConflictError)

    // The loser changed nothing.
    expect((await getExternalAgentConfig(created.configId))?.config.name).toBe("First")
  })

  it("carries the current record on the conflict so a caller can merge", async () => {
    const created = await createExternalAgentConfig({ config: config() })
    await updateExternalAgentConfig({
      configId: created.configId,
      expectedRevision: created.revision,
      mutate: (c) => ({ ...c, name: "Winner" }),
    })
    await expect(
      updateExternalAgentConfig({
        configId: created.configId,
        expectedRevision: created.revision,
        mutate: (c) => c,
      })
    ).rejects.toMatchObject({
      current: expect.objectContaining({
        config: expect.objectContaining({ name: "Winner" }),
      }),
    })
  })

  it("refuses an unknown or tombstoned config", async () => {
    await expect(
      updateExternalAgentConfig({
        configId: "eac_missing",
        expectedRevision: "eacr_x",
        mutate: (c) => c,
      })
    ).rejects.toBeInstanceOf(ExternalAgentConfigNotFoundError)

    const created = await createExternalAgentConfig({ config: config() })
    const deleted = await deleteExternalAgentConfig(created.configId)
    await expect(
      updateExternalAgentConfig({
        configId: created.configId,
        expectedRevision: deleted.revision,
        mutate: (c) => c,
      })
    ).rejects.toBeInstanceOf(ExternalAgentConfigNotFoundError)
  })

  it("keeps the store's id even when mutate rewrites it", async () => {
    const created = await createExternalAgentConfig({ config: config() })
    const updated = await updateExternalAgentConfig({
      configId: created.configId,
      expectedRevision: created.revision,
      mutate: (c) => ({ ...c, id: "hijacked" }),
    })
    expect(updated.config.id).toBe(created.configId)
  })
})

describe("lifecycleGeneration", () => {
  // A rename must not invalidate an in-flight admission: the run already holds
  // the revision it was admitted against, and nothing about whether it can run
  // has changed.
  it("does not move on an ordinary edit", async () => {
    const created = await createExternalAgentConfig({ config: config() })
    const updated = await updateExternalAgentConfig({
      configId: created.configId,
      expectedRevision: created.revision,
      mutate: (c) => ({ ...c, name: "Renamed", timeout: 60_000 }),
    })
    expect(updated.lifecycleGeneration).toBe(created.lifecycleGeneration)
  })

  it.each([
    ["disabling", (c: StoredExternalAgentConfig) => ({ ...c, enabled: false })],
    [
      "a readiness verdict change",
      (c: StoredExternalAgentConfig) =>
        ({ ...c, lifecycleStatus: "needs-credentials" }) as StoredExternalAgentConfig,
    ],
  ])("moves on %s", async (_label, mutate) => {
    const created = await createExternalAgentConfig({ config: config() })
    const updated = await updateExternalAgentConfig({
      configId: created.configId,
      expectedRevision: created.revision,
      mutate,
    })
    expect(updated.lifecycleGeneration).toBe(created.lifecycleGeneration + 1)
  })

  it("moves on delete, because readiness certainly changed", async () => {
    const created = await createExternalAgentConfig({ config: config() })
    const deleted = await deleteExternalAgentConfig(created.configId)
    expect(deleted.lifecycleGeneration).toBe(created.lifecycleGeneration + 1)
  })
})

describe("delete", () => {
  it("tombstones rather than dropping, so an in-flight run gets a reason", async () => {
    const created = await createExternalAgentConfig({ config: config() })
    await deleteExternalAgentConfig(created.configId, 5000)
    const read = await getExternalAgentConfig(created.configId)
    expect(read?.tombstonedAt).toBe(5000)
    expect(await admitExternalAgentConfig(stamp(created))).toMatchObject({
      ok: false,
      reason: "deleted",
    })
  })

  it("is idempotent", async () => {
    const created = await createExternalAgentConfig({ config: config() })
    const first = await deleteExternalAgentConfig(created.configId, 5000)
    const second = await deleteExternalAgentConfig(created.configId, 9000)
    expect(second.tombstonedAt).toBe(5000)
    expect(second.lifecycleGeneration).toBe(first.lifecycleGeneration)
  })

  it("refuses an unknown config", async () => {
    await expect(deleteExternalAgentConfig("eac_missing")).rejects.toBeInstanceOf(
      ExternalAgentConfigNotFoundError
    )
  })
})

describe("admission", () => {
  it("admits a matching stamp and returns the immutable revision", async () => {
    const created = await createExternalAgentConfig({ config: config() })
    const verdict = await admitExternalAgentConfig(stamp(created))
    expect(verdict).toMatchObject({ ok: true })
    if (verdict.ok) expect(verdict.record.revision).toBe(created.revision)
  })

  it("names the unknown config rather than failing generically", async () => {
    expect(
      await admitExternalAgentConfig({
        configId: "eac_missing",
        revision: "eacr_x",
        lifecycleGeneration: 1,
      })
    ).toEqual({ ok: false, reason: "unknown-config" })
  })

  // The two halves catch different things, which is why both are checked: a
  // revision-only check misses a revoked credential, a generation-only check
  // admits text the caller never saw.
  it("rejects a stale revision", async () => {
    const created = await createExternalAgentConfig({ config: config() })
    await updateExternalAgentConfig({
      configId: created.configId,
      expectedRevision: created.revision,
      mutate: (c) => ({ ...c, name: "Edited" }),
    })
    expect(await admitExternalAgentConfig(stamp(created))).toMatchObject({
      ok: false,
      reason: "stale-revision",
    })
  })

  it("rejects a stale generation even when the revision matches", async () => {
    const created = await createExternalAgentConfig({ config: config() })
    expect(
      await admitExternalAgentConfig({ ...stamp(created), lifecycleGeneration: 99 })
    ).toMatchObject({ ok: false, reason: "stale-generation" })
  })

  it("separates disabled from not-ready", async () => {
    const disabled = await createExternalAgentConfig({ config: config({ enabled: false }) })
    expect(await admitExternalAgentConfig(stamp(disabled))).toMatchObject({
      ok: false,
      reason: "disabled",
    })

    const blocked = await createExternalAgentConfig({
      config: config({ lifecycleStatus: "needs-credentials" }),
    })
    expect(await admitExternalAgentConfig(stamp(blocked))).toMatchObject({
      ok: false,
      reason: "not-ready",
    })
  })

  it("carries the current record on every refusal that has one", async () => {
    const created = await createExternalAgentConfig({ config: config({ enabled: false }) })
    const verdict = await admitExternalAgentConfig(stamp(created))
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.current?.configId).toBe(created.configId)
  })
})

describe("leases and collection", () => {
  async function supersede(configId: string, revision: string, now: number) {
    return updateExternalAgentConfig({
      configId,
      expectedRevision: revision,
      mutate: (c) => ({ ...c, name: `v${now}` }),
      now,
    })
  }

  it("keeps the head revision forever, however old", async () => {
    const created = await createExternalAgentConfig({ config: config(), now: 0 })
    expect(await collectExternalAgentConfigRevisions(1e12)).toBe(0)
    expect(await getExternalAgentConfig(created.configId)).not.toBeNull()
  })

  it("collects a superseded, unleased revision past retention", async () => {
    const created = await createExternalAgentConfig({ config: config(), now: 0 })
    await supersede(created.configId, created.revision, 1000)
    expect(await collectExternalAgentConfigRevisions(1e12)).toBe(1)
    expect(await listExternalAgentConfigRevisions(created.configId)).toHaveLength(1)
  })

  it("keeps a superseded revision that is still inside retention", async () => {
    const created = await createExternalAgentConfig({ config: config(), now: 0 })
    await supersede(created.configId, created.revision, 1000)
    expect(await collectExternalAgentConfigRevisions(2000)).toBe(0)
  })

  // A run admitted a moment before an edit still has to resolve its revision.
  it("keeps a leased revision however old, then collects it once released", async () => {
    const created = await createExternalAgentConfig({ config: config(), now: 0 })
    await leaseExternalAgentConfigRevision(created.revision, "run-1")
    await supersede(created.configId, created.revision, 1000)

    expect(await collectExternalAgentConfigRevisions(1e12)).toBe(0)
    await releaseExternalAgentConfigLeases("run-1")
    expect(await collectExternalAgentConfigRevisions(1e12)).toBe(1)
  })

  it("releases only the named run's pins", async () => {
    const created = await createExternalAgentConfig({ config: config(), now: 0 })
    await leaseExternalAgentConfigRevision(created.revision, "run-1")
    await leaseExternalAgentConfigRevision(created.revision, "run-2")
    await supersede(created.configId, created.revision, 1000)

    await releaseExternalAgentConfigLeases("run-1")
    expect(await collectExternalAgentConfigRevisions(1e12)).toBe(0)
    await releaseExternalAgentConfigLeases("run-2")
    expect(await collectExternalAgentConfigRevisions(1e12)).toBe(1)
  })

  it("is idempotent for a repeated lease and an unknown run", async () => {
    const created = await createExternalAgentConfig({ config: config() })
    await leaseExternalAgentConfigRevision(created.revision, "run-1")
    await leaseExternalAgentConfigRevision(created.revision, "run-1")
    const stored = await getDb().externalAgentConfigRevisions.get(created.revision)
    expect(stored?.leaseRuns).toEqual(["run-1"])
    await expect(releaseExternalAgentConfigLeases("never-ran")).resolves.toBeUndefined()
  })

  it("ignores a lease on a revision that no longer exists", async () => {
    await expect(leaseExternalAgentConfigRevision("eacr_missing", "run-1")).resolves.toBeUndefined()
  })
})
