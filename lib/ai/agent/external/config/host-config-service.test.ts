/** @jest-environment jsdom */

import { hostConfigOriginAgentId } from "@/lib/ai/agent/runtime-catalog/pairing"
import "fake-indexeddb/auto"

import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { ExternalAgentConfigNotFoundError } from "@/lib/db/external-agent-configs"
import type { StoredExternalAgentConfig } from "@/stores/agent/external-agent-store/types"

import {
  applyVerdict,
  createHostExternalAgentConfig,
  deleteHostExternalAgentConfig,
  getHostExternalAgentConfig,
  importedConfigCredentialGaps,
  listHostExternalAgentConfigs,
  reconcileHostExternalAgentConfigs,
  updateHostExternalAgentConfig,
  type HostConfigServiceDeps,
} from "./host-config-service"

function config(overrides: Partial<StoredExternalAgentConfig> = {}): StoredExternalAgentConfig {
  return {
    id: "ignored",
    name: "Pi",
    protocol: "pi-rpc",
    transport: "stdio",
    enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as StoredExternalAgentConfig
}

const ready: HostConfigServiceDeps = { assessReadiness: async () => ({ status: "ready" }) }
const notReady = (
  status: "needs-credentials" | "needs-runtime" | "needs-consent" | "blocked",
  reason = "why"
): HostConfigServiceDeps => ({
  assessReadiness: async () => ({ status, reasonCode: "credential_missing", reason }),
})

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
})

describe("applyVerdict", () => {
  it("records the verdict and its reason", () => {
    const next = applyVerdict(config(), {
      status: "needs-runtime",
      reasonCode: "runtime_missing",
      reason: "pi not installed",
    })
    expect(next.lifecycleStatus).toBe("needs-runtime")
    expect(next.lifecycleReasonCode).toBe("runtime_missing")
    expect(next.lifecycleReason).toBe("pi not installed")
  })

  // Leaving an unrunnable config enabled means every turn that selects it fails
  // at spawn instead of being refused at admission — later, and harder to
  // explain.
  it("forces a non-ready config disabled", () => {
    expect(applyVerdict(config({ enabled: true }), { status: "blocked" }).enabled).toBe(false)
  })

  it("leaves a ready config's enabled flag alone", () => {
    expect(applyVerdict(config({ enabled: true }), { status: "ready" }).enabled).toBe(true)
    expect(applyVerdict(config({ enabled: false }), { status: "ready" }).enabled).toBe(false)
  })
})

describe("create", () => {
  it("stores a ready config enabled", async () => {
    const record = await createHostExternalAgentConfig({ config: config() }, ready)
    expect(record.lifecycleStatus).toBe("ready")
    expect(record.enabled).toBe(true)
  })

  it("stores an unrunnable config disabled with its reason instead of refusing it", async () => {
    const record = await createHostExternalAgentConfig(
      { config: config() },
      notReady("needs-credentials", "no api key on this host")
    )
    expect(record.enabled).toBe(false)
    expect(record.lifecycleStatus).toBe("needs-credentials")
    expect(record.config.lifecycleReason).toBe("no api key on this host")
    // Visible in the list — a blocked config the operator can act on, not a
    // silent drop.
    expect(await listHostExternalAgentConfigs()).toHaveLength(1)
  })

  // A browser export names keys in a keyring this host does not have, and its
  // consent was granted for a different machine.
  it("drops keyring refs, consent and the enabled flag on an import", async () => {
    const record = await createHostExternalAgentConfig(
      {
        fromImport: true,
        config: config({
          enabled: true,
          credentialRefs: { apiKey: "other-host-key" },
          unsandboxedConsent: {
            agentId: "a",
            runtimeId: "pi",
            executablePath: "/usr/local/bin/pi",
            executableDigest: "d".repeat(64),
            runtimeVersion: "1.0.0",
            commandDigest: "c".repeat(64),
            policyRevision: 1,
            hostId: "other-machine",
            confirmedAt: "2026-01-01T00:00:00.000Z",
          },
        }),
      },
      ready
    )
    expect(record.config.credentialRefs).toBeUndefined()
    expect(record.config.unsandboxedConsent).toBeUndefined()
    expect(record.enabled).toBe(false)
  })

  it("records where an import came from, so the two copies stay one agent", async () => {
    // The store mints its own `eac_*` id, so without this the only key left to
    // recognise the copy by is the name, and a rename on either side puts the
    // same agent in the runtime picker twice.
    const record = await createHostExternalAgentConfig(
      { fromImport: true, config: config({ id: "local_pi" }) },
      ready
    )
    expect(record.config.metadata).toMatchObject({ importedFromAgentId: "local_pi" })
    expect(hostConfigOriginAgentId(record)).toBe("local_pi")
  })

  it("does not stamp provenance on an ordinary create", async () => {
    const record = await createHostExternalAgentConfig(
      { config: config({ id: "local_pi" }) },
      ready
    )
    expect(hostConfigOriginAgentId(record)).toBeNull()
  })

  it("keeps a normal create's refs — only imports are distrusted", async () => {
    const record = await createHostExternalAgentConfig(
      { config: config({ credentialRefs: { apiKey: "local-key" } }) },
      ready
    )
    expect(record.config.credentialRefs).toEqual({ apiKey: "local-key" })
  })

  // Assessing before scrubbing would let an inline secret satisfy the
  // credential check and then be stripped on the way to disk — a config marked
  // ready with no credential at all.
  it("scrubs before assessing, so the assessor never sees an inline secret", async () => {
    const seen: unknown[] = []
    await createHostExternalAgentConfig(
      {
        config: config({
          transport: "http",
          network: {
            endpoint: "https://example.invalid",
            headers: { Authorization: "Bearer sk-secret" },
          },
        }),
      },
      {
        assessReadiness: async (c) => {
          seen.push(JSON.stringify(c))
          return { status: "ready" }
        },
      }
    )
    expect(seen.join()).not.toContain("sk-secret")
  })

  it("never writes an inline secret into a retained revision", async () => {
    const record = await createHostExternalAgentConfig(
      {
        config: config({
          transport: "http",
          network: {
            endpoint: "https://example.invalid",
            headers: { Authorization: "Bearer sk-secret" },
          },
        }),
      },
      ready
    )
    const stored = await getDb().externalAgentConfigRevisions.get(record.revision)
    expect(JSON.stringify(stored)).not.toContain("sk-secret")
  })
})

describe("update", () => {
  it("merges the patch and re-assesses the result", async () => {
    const created = await createHostExternalAgentConfig({ config: config() }, ready)
    const updated = await updateHostExternalAgentConfig(
      {
        configId: created.configId,
        expectedRevision: created.revision,
        patch: { name: "Renamed" },
      },
      ready
    )
    expect(updated.config.name).toBe("Renamed")
    expect(updated.config.protocol).toBe("pi-rpc")
  })

  it("disables a config whose edit made it unrunnable", async () => {
    const created = await createHostExternalAgentConfig({ config: config() }, ready)
    const updated = await updateHostExternalAgentConfig(
      { configId: created.configId, expectedRevision: created.revision, patch: { name: "x" } },
      notReady("needs-runtime")
    )
    expect(updated.enabled).toBe(false)
    expect(updated.lifecycleStatus).toBe("needs-runtime")
    // Readiness moved, so an in-flight admission must be invalidated.
    expect(updated.lifecycleGeneration).toBe(created.lifecycleGeneration + 1)
  })

  it("ignores an id in the patch", async () => {
    const created = await createHostExternalAgentConfig({ config: config() }, ready)
    const updated = await updateHostExternalAgentConfig(
      {
        configId: created.configId,
        expectedRevision: created.revision,
        patch: { id: "hijacked" } as Partial<StoredExternalAgentConfig>,
      },
      ready
    )
    expect(updated.config.id).toBe(created.configId)
  })

  it("refuses an unknown config", async () => {
    await expect(
      updateHostExternalAgentConfig(
        { configId: "eac_missing", expectedRevision: "eacr_x", patch: {} },
        ready
      )
    ).rejects.toBeInstanceOf(ExternalAgentConfigNotFoundError)
  })
})

describe("delete", () => {
  it("tombstones and hides the config", async () => {
    const created = await createHostExternalAgentConfig({ config: config() }, ready)
    await deleteHostExternalAgentConfig(created.configId, ready)
    expect(await listHostExternalAgentConfigs()).toEqual([])
    expect((await getHostExternalAgentConfig(created.configId))?.tombstonedAt).toBeDefined()
  })
})

describe("reconcile", () => {
  it("re-assesses and reports what moved", async () => {
    const created = await createHostExternalAgentConfig({ config: config() }, ready)
    const outcomes = await reconcileHostExternalAgentConfigs(notReady("needs-credentials"))
    expect(outcomes).toEqual([
      { configId: created.configId, from: "ready", to: "needs-credentials", changed: true },
    ])
    expect((await getHostExternalAgentConfig(created.configId))?.enabled).toBe(false)
  })

  // An unconditional write would append a revision per startup and move
  // `lifecycleGeneration`, cancelling in-flight runs for nothing.
  it("writes nothing when the verdict is unchanged", async () => {
    const created = await createHostExternalAgentConfig({ config: config() }, ready)
    const outcomes = await reconcileHostExternalAgentConfigs(ready)
    expect(outcomes).toEqual([
      { configId: created.configId, from: "ready", to: "ready", changed: false },
    ])
    const after = await getHostExternalAgentConfig(created.configId)
    expect(after?.revision).toBe(created.revision)
    expect(after?.lifecycleGeneration).toBe(created.lifecycleGeneration)
  })

  it("rewrites when only the reason changed, so the operator sees the new one", async () => {
    const created = await createHostExternalAgentConfig(
      { config: config() },
      notReady("needs-credentials", "first reason")
    )
    await reconcileHostExternalAgentConfigs(notReady("needs-credentials", "second reason"))
    expect((await getHostExternalAgentConfig(created.configId))?.config.lifecycleReason).toBe(
      "second reason"
    )
  })

  it("skips tombstoned configs", async () => {
    const created = await createHostExternalAgentConfig({ config: config() }, ready)
    await deleteHostExternalAgentConfig(created.configId, ready)
    expect(await reconcileHostExternalAgentConfigs(notReady("blocked"))).toEqual([])
  })
})

describe("importedConfigCredentialGaps", () => {
  it("reads the marker a sanitized export left behind", () => {
    expect(
      importedConfigCredentialGaps(
        config({
          metadata: { __cognia_credential_required__: ["apiKey", "bogus"] },
        } as Partial<StoredExternalAgentConfig>)
      )
    ).toEqual(["apiKey"])
  })

  it("is empty for a config that was never exported", () => {
    expect(importedConfigCredentialGaps(config())).toEqual([])
  })
})
