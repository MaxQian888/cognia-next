/** @jest-environment jsdom */

import { hostConfigOriginAgentId } from "@/lib/ai/agent/runtime-catalog/pairing"
import "fake-indexeddb/auto"

import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { ExternalAgentConfigNotFoundError } from "@/lib/db/external-agent-configs"
import type { StoredExternalAgentConfig } from "@/stores/agent/external-agent-store/types"

const mockTransportCall = jest.fn()
jest.mock("@/lib/tauri", () => ({
  ...jest.requireActual("@/lib/tauri"),
  transport: { call: (...args: unknown[]) => mockTransportCall(...args) },
}))

import {
  HostConfigCleanupError,
  HostConfigForeignCredentialRefError,
  applyVerdict,
  createHostExternalAgentConfig,
  defaultHostCogniaModelCatalogDeps,
  deleteHostExternalAgentConfig,
  duplicateHostExternalAgentConfig,
  getHostCogniaModelCatalog,
  getHostExternalAgentConfig,
  importedConfigCredentialGaps,
  listHostExternalAgentConfigs,
  reconcileHostExternalAgentConfigs,
  updateHostExternalAgentConfig,
  type HostCogniaModelCatalogDeps,
  type HostConfigDeleteDeps,
  type HostConfigServiceDeps,
} from "./host-config-service"
import type { KeyringStore } from "@/lib/credentials/keyring-store"
import { ExternalAgentConfigConflictError } from "@/lib/db/external-agent-configs"
import { prepareExternalAgentLaunch } from "../lifecycle/launch-preparation"
import { hostConfigLaunchConfig } from "./host-config-mount"
import type { ExternalAgentConfig } from "@/types/agent/external-agent"

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

function memoryKeyring(): KeyringStore & { entries: Map<string, string> } {
  const entries = new Map<string, string>()
  return {
    entries,
    save: async (keyId, value) => {
      entries.set(keyId, value)
    },
    load: async (keyId) => entries.get(keyId) ?? null,
    delete: async (keyId) => {
      entries.delete(keyId)
    },
  }
}

let keyring = memoryKeyring()
const removedStateRoots: string[] = []
let ready: HostConfigServiceDeps
let deleteDeps: HostConfigDeleteDeps
const notReady = (
  status: "needs-credentials" | "needs-runtime" | "needs-consent" | "blocked",
  reason = "why"
): HostConfigServiceDeps => ({
  keyring,
  assessReadiness: async () => ({ status, reasonCode: "credential_missing", reason }),
})

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  keyring = memoryKeyring()
  removedStateRoots.length = 0
  ready = { keyring, assessReadiness: async () => ({ status: "ready" }) }
  deleteDeps = {
    keyring,
    removeStateRoot: async (configId) => {
      removedStateRoots.push(configId)
    },
  }
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

  // A new configuration owns no slot yet, so any ref it carries names someone
  // else's — config X must never launch with config Y's secret (G8).
  it("refuses credential refs on an ordinary create", async () => {
    await expect(
      createHostExternalAgentConfig(
        { config: config({ credentialRefs: { apiKey: "eac_other:apiKey" } }) },
        ready
      )
    ).rejects.toBeInstanceOf(HostConfigForeignCredentialRefError)
    expect(await listHostExternalAgentConfigs()).toEqual([])
  })

  // The old behavior scrubbed an inline key and threw it away, storing a
  // config that looked configured and authenticated as nobody.
  it("persists inline secrets into the new config's own keyring slots", async () => {
    const record = await createHostExternalAgentConfig(
      {
        config: config({
          transport: "http",
          network: {
            endpoint: "https://example.invalid",
            apiKey: "sk-inline",
            headers: { Authorization: "Bearer sk-header", Accept: "json" },
          },
        }),
      },
      ready
    )
    expect(record.config.credentialRefs).toEqual({
      apiKey: `${record.configId}:apiKey`,
      headers: `${record.configId}:headers`,
    })
    expect(keyring.entries.get(`${record.configId}:apiKey`)).toBe("sk-inline")
    expect(JSON.parse(keyring.entries.get(`${record.configId}:headers`)!)).toEqual({
      Authorization: "Bearer sk-header",
    })
    expect(record.config.network).toEqual({
      endpoint: "https://example.invalid",
      headers: { Accept: "json" },
    })
    expect(record.enabled).toBe(true)
    expect(record.lifecycleStatus).toBe("ready")
    // Neither revision — the placeholder nor the real one — holds the secret.
    const revisions = await getDb().externalAgentConfigRevisions.toArray()
    expect(JSON.stringify(revisions)).not.toMatch(/sk-inline|sk-header/)
  })

  it("assesses the stored refs, not the inline secret", async () => {
    const seen: string[] = []
    await createHostExternalAgentConfig(
      { config: config({ metadata: { serverPassword: "pw-1" } }) },
      {
        keyring,
        assessReadiness: async (c) => {
          seen.push(JSON.stringify(c))
          return { status: "ready" }
        },
      }
    )
    expect(seen.join()).not.toContain("pw-1")
    expect(seen.at(-1)).toContain(":serverPassword")
  })

  it("deletes the half-made config and its slots when the keyring refuses", async () => {
    const failing = memoryKeyring()
    failing.save = async () => {
      throw new Error("keyring locked")
    }
    await expect(
      createHostExternalAgentConfig(
        { config: config({ network: { endpoint: "https://x.invalid", apiKey: "k" } }) },
        { ...ready, keyring: failing }
      )
    ).rejects.toThrow("keyring locked")
    expect(await listHostExternalAgentConfigs()).toEqual([])
  })

  it("defaults a new config to its own state when the runtime can be isolated", async () => {
    const record = await createHostExternalAgentConfig(
      { config: config({ protocol: "acp", process: { command: "codex-acp" } } as never) },
      ready
    )
    expect(record.config.stateIsolation).toBe("isolated")
  })

  it("defaults to shared state when the runtime has no home to isolate", async () => {
    const record = await createHostExternalAgentConfig(
      { config: config({ process: { command: "some-unknown-cli" } } as never) },
      ready
    )
    expect(record.config.stateIsolation).toBe("shared")
    expect(record.lifecycleStatus).toBe("ready")
  })

  it("blocks an explicitly isolated config its runtime cannot isolate", async () => {
    const record = await createHostExternalAgentConfig(
      {
        config: config({
          stateIsolation: "isolated",
          process: { command: "some-unknown-cli" },
        } as never),
      },
      ready
    )
    expect(record.lifecycleStatus).toBe("blocked")
    expect(record.config.lifecycleReasonCode).toBe("state_isolation_unsupported")
    expect(record.enabled).toBe(false)
  })

  it("keeps an import's isolation as it was sent", async () => {
    const record = await createHostExternalAgentConfig(
      { fromImport: true, config: config({ process: { command: "codex-acp" } } as never) },
      ready
    )
    expect(record.config.stateIsolation).toBeUndefined()
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
        keyring,
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

  it("moves a new inline secret into the config's own slot, keeping the others", async () => {
    const created = await createHostExternalAgentConfig(
      {
        config: config({
          process: { command: "pi", env: { PI_API_KEY: "old-env", PLAIN: "1" } },
          metadata: { serverPassword: "pw" },
        } as never),
      },
      ready
    )
    const updated = await updateHostExternalAgentConfig(
      {
        configId: created.configId,
        expectedRevision: created.revision,
        patch: {
          process: { command: "pi", env: { OTHER_TOKEN: "new-env", PLAIN: "2" } },
        },
      },
      ready
    )
    expect(updated.config.process?.env).toEqual({ PLAIN: "2" })
    expect(updated.config.credentialRefs).toEqual({
      processEnv: `${created.configId}:processEnv`,
      serverPassword: `${created.configId}:serverPassword`,
    })
    expect(JSON.parse(keyring.entries.get(`${created.configId}:processEnv`)!)).toEqual({
      PI_API_KEY: "old-env",
      OTHER_TOKEN: "new-env",
    })
    expect(keyring.entries.get(`${created.configId}:serverPassword`)).toBe("pw")
    const revisions = await getDb().externalAgentConfigRevisions.toArray()
    expect(JSON.stringify(revisions)).not.toMatch(/old-env|new-env|"pw"/)
  })

  // JSON cannot carry `undefined`, so `null` is how an editor clears a limit.
  it("clears an optional limit sent as null", async () => {
    const created = await createHostExternalAgentConfig(
      { config: config({ maxConcurrentSessions: 2, description: "d" }) },
      ready
    )
    const updated = await updateHostExternalAgentConfig(
      {
        configId: created.configId,
        expectedRevision: created.revision,
        patch: { maxConcurrentSessions: null, description: null } as never,
      },
      ready
    )
    expect(updated.config).not.toHaveProperty("maxConcurrentSessions")
    expect(updated.config).not.toHaveProperty("description")
  })

  it("refuses a ref to another config's keyring slot", async () => {
    const created = await createHostExternalAgentConfig({ config: config() }, ready)
    await expect(
      updateHostExternalAgentConfig(
        {
          configId: created.configId,
          expectedRevision: created.revision,
          patch: { credentialRefs: { apiKey: "eac_victim:apiKey" } },
        },
        ready
      )
    ).rejects.toBeInstanceOf(HostConfigForeignCredentialRefError)
    // A prefix that merely starts with the id is not the config's own slot.
    await expect(
      updateHostExternalAgentConfig(
        {
          configId: created.configId,
          expectedRevision: created.revision,
          patch: { credentialRefs: { apiKey: `${created.configId}x:apiKey` } },
        },
        ready
      )
    ).rejects.toBeInstanceOf(HostConfigForeignCredentialRefError)
  })

  it("accepts a ref to the config's own slot", async () => {
    const created = await createHostExternalAgentConfig({ config: config() }, ready)
    const updated = await updateHostExternalAgentConfig(
      {
        configId: created.configId,
        expectedRevision: created.revision,
        patch: { credentialRefs: { apiKey: `${created.configId}:apiKey` } },
      },
      ready
    )
    expect(updated.config.credentialRefs).toEqual({ apiKey: `${created.configId}:apiKey` })
  })

  // The slot ids are deterministic, so writing the keyring IS the edit: a
  // stale writer must lose before it touches the credential.
  it("refuses a stale revision before writing a secret", async () => {
    const created = await createHostExternalAgentConfig(
      { config: config({ network: { endpoint: "https://x.invalid", apiKey: "first" } }) },
      ready
    )
    await updateHostExternalAgentConfig(
      { configId: created.configId, expectedRevision: created.revision, patch: { name: "B" } },
      ready
    )
    await expect(
      updateHostExternalAgentConfig(
        {
          configId: created.configId,
          expectedRevision: created.revision,
          patch: { network: { endpoint: "https://x.invalid", apiKey: "second" } },
        },
        ready
      )
    ).rejects.toBeInstanceOf(ExternalAgentConfigConflictError)
    expect(keyring.entries.get(`${created.configId}:apiKey`)).toBe("first")
  })
})

describe("delete", () => {
  it("tombstones and hides the config", async () => {
    const created = await createHostExternalAgentConfig({ config: config() }, ready)
    await deleteHostExternalAgentConfig(created.configId, deleteDeps)
    expect(await listHostExternalAgentConfigs()).toEqual([])
    expect((await getHostExternalAgentConfig(created.configId))?.tombstonedAt).toBeDefined()
  })

  it("clears the config's keyring slots and removes its state root", async () => {
    const created = await createHostExternalAgentConfig(
      { config: config({ network: { endpoint: "https://x.invalid", apiKey: "k" } }) },
      ready
    )
    keyring.entries.set("eac_other:apiKey", "untouched")
    await deleteHostExternalAgentConfig(created.configId, deleteDeps)
    expect([...keyring.entries.keys()]).toEqual(["eac_other:apiKey"])
    expect(removedStateRoots).toEqual([created.configId])
  })

  it("reports a failed cleanup after the tombstone stands", async () => {
    const created = await createHostExternalAgentConfig({ config: config() }, ready)
    await expect(
      deleteHostExternalAgentConfig(created.configId, {
        ...deleteDeps,
        removeStateRoot: async () => {
          throw new Error("busy")
        },
      })
    ).rejects.toBeInstanceOf(HostConfigCleanupError)
    expect(await listHostExternalAgentConfigs()).toEqual([])
  })
})

describe("duplicate", () => {
  async function source(overrides: Partial<StoredExternalAgentConfig> = {}) {
    return createHostExternalAgentConfig(
      {
        config: config({
          name: "Codex",
          protocol: "acp",
          process: {
            command: "codex-acp",
            env: { CODEX_HOME: "/Users/me/.codex", OPENAI_API_KEY: "sk-env", PLAIN: "1" },
          },
          defaultPermissionMode: "plan",
          maxConcurrentSessions: 2,
          metadata: { preset: "codex", port: 4096, importedFromAgentId: "local_codex" },
          ...overrides,
        } as never),
      },
      ready
    )
  }

  it("copies the config into a new row with its own secrets and lineage", async () => {
    const original = await source()
    const copy = await duplicateHostExternalAgentConfig({ configId: original.configId }, ready)
    expect(copy.configId).not.toBe(original.configId)
    expect(copy.config.name).toBe("Codex (copy)")
    expect(copy.config.duplicatedFromAgentId).toBe(original.configId)
    expect(copy.config.stateIsolation).toBe("isolated")
    expect(copy.config.defaultPermissionMode).toBe("plan")
    expect(copy.config.maxConcurrentSessions).toBe(2)
    // The isolation rule owns CODEX_HOME; the instance-only port and the
    // source's import provenance stay behind.
    expect(copy.config.process?.env).toEqual({ PLAIN: "1" })
    expect(copy.config.metadata).toEqual({ preset: "codex" })
    expect(copy.config.credentialRefs).toEqual({ processEnv: `${copy.configId}:processEnv` })
    expect(JSON.parse(keyring.entries.get(`${copy.configId}:processEnv`)!)).toEqual({
      OPENAI_API_KEY: "sk-env",
    })
    // The source's slot is untouched and still its own.
    expect(keyring.entries.get(`${original.configId}:processEnv`)).toBeDefined()
  })

  it("uses the caller's name, isolation and enabled choice", async () => {
    const original = await source()
    const copy = await duplicateHostExternalAgentConfig(
      { configId: original.configId, name: "Codex RO", stateIsolation: "shared", enabled: false },
      ready
    )
    expect(copy.config.name).toBe("Codex RO")
    expect(copy.config.stateIsolation).toBe("shared")
    expect(copy.enabled).toBe(false)
  })

  it("picks the next free copy name", async () => {
    const original = await source()
    await duplicateHostExternalAgentConfig({ configId: original.configId }, ready)
    const second = await duplicateHostExternalAgentConfig({ configId: original.configId }, ready)
    expect(second.config.name).toBe("Codex (copy 2)")
  })

  it("survives the source's deletion", async () => {
    const original = await source()
    const copy = await duplicateHostExternalAgentConfig({ configId: original.configId }, ready)
    await deleteHostExternalAgentConfig(original.configId, deleteDeps)
    expect(keyring.entries.get(`${copy.configId}:processEnv`)).toBeDefined()
  })

  it("refuses a source whose keyring entry is gone", async () => {
    const original = await source()
    keyring.entries.delete(`${original.configId}:processEnv`)
    await expect(
      duplicateHostExternalAgentConfig({ configId: original.configId }, ready)
    ).rejects.toMatchObject({ code: "credential_missing" })
    expect(await listHostExternalAgentConfigs()).toHaveLength(1)
  })

  it("refuses an unknown or deleted source", async () => {
    await expect(
      duplicateHostExternalAgentConfig({ configId: "eac_missing" }, ready)
    ).rejects.toBeInstanceOf(ExternalAgentConfigNotFoundError)
    const original = await source()
    await deleteHostExternalAgentConfig(original.configId, deleteDeps)
    await expect(
      duplicateHostExternalAgentConfig({ configId: original.configId }, ready)
    ).rejects.toBeInstanceOf(ExternalAgentConfigNotFoundError)
  })
})

// G8: a host config launches with its OWN secrets. The mount hands the stored
// refs to the manager, whose launch preparer resolves them from this keyring.
describe("launching a host config", () => {
  it("resolves the secrets the create persisted", async () => {
    const record = await createHostExternalAgentConfig(
      {
        config: config({
          stateIsolation: "shared",
          process: { command: "pi", env: { PI_API_KEY: "sk-own" } },
        } as never),
      },
      ready
    )
    const launched = await prepareExternalAgentLaunch(
      hostConfigLaunchConfig(record.configId, record.config as unknown as ExternalAgentConfig),
      { keyring }
    )
    expect(launched.process?.env?.PI_API_KEY).toBe("sk-own")
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
    await deleteHostExternalAgentConfig(created.configId, deleteDeps)
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

// Host-lane Cognia models (ADR-0090, 2026-10-02): the catalog a paired device
// is offered is computed from THIS Host's settings and vault.
describe("getHostCogniaModelCatalog", () => {
  const SECRET = "sk-host-only"
  const hostRecord = {
    configId: "eac_1",
    revision: "eacr_1",
    lifecycleGeneration: 1,
    seq: 1,
    enabled: true,
    lifecycleStatus: "ready",
    createdAt: 1,
    updatedAt: 1,
    config: config({ protocol: "acp", process: { command: "codex-acp" } } as never),
  } as never
  const hostSettings = {
    providerSettings: {
      openai: { providerId: "openai", enabled: true, apiKey: SECRET, enabledModels: ["gpt-5.6"] },
      "kimi-sub": { providerId: "kimi-sub", enabled: true, enabledModels: ["kimi-k2"] },
    },
    customProviders: [],
  } as never
  const kimi = {
    id: "kimi-sub",
    name: "Kimi",
    authMode: "api-key",
    protocol: "anthropic",
    source: "builtin",
  } as never

  function deps(over: Partial<HostCogniaModelCatalogDeps> = {}): HostCogniaModelCatalogDeps {
    return {
      getConfig: async () => hostRecord,
      support: () => ({ supported: true, runtime: "codex" }),
      readSettings: () => hostSettings,
      accountLocked: () => false,
      subscriptions: () => [kimi],
      listAccountIds: async () => ["acct-1", "acct-1", ""],
      ...over,
    }
  }

  it("lists the Host's eligible models, with vault account ids and no secret", async () => {
    const catalog = await getHostCogniaModelCatalog("eac_1", deps())
    expect(catalog.supported).toBe(true)
    if (!catalog.supported) return
    expect(catalog.providers.map((provider) => provider.providerId).sort()).toEqual([
      "kimi-sub",
      "openai",
    ])
    expect(catalog.providers.find((p) => p.providerId === "kimi-sub")?.accountIds).toEqual([
      "acct-1",
    ])
    // Accounts are listed only for API-key subscriptions.
    expect(catalog.providers.find((p) => p.providerId === "openai")).not.toHaveProperty(
      "accountIds"
    )
    expect(JSON.stringify(catalog)).not.toContain(SECRET)
  })

  it("keeps the provider when its vault cannot be listed", async () => {
    const catalog = await getHostCogniaModelCatalog(
      "eac_1",
      deps({
        listAccountIds: async () => {
          throw new Error("vault unavailable")
        },
      })
    )
    expect(catalog.supported && catalog.providers.some((p) => p.providerId === "kimi-sub")).toBe(
      true
    )
  })

  it("maps a runtime refusal onto the catalog's reasons", async () => {
    await expect(
      getHostCogniaModelCatalog(
        "eac_1",
        deps({ support: () => ({ supported: false, reason: "network-endpoint" }) })
      )
    ).resolves.toEqual({ supported: false, reason: "unsupported-runtime" })
    await expect(
      getHostCogniaModelCatalog(
        "eac_1",
        deps({ support: () => ({ supported: false, reason: "public-https-required" }) })
      )
    ).resolves.toEqual({ supported: false, reason: "public-https-required" })
  })

  it("says the account is locked before reading settings", async () => {
    const readSettings = jest.fn(() => hostSettings)
    await expect(
      getHostCogniaModelCatalog("eac_1", deps({ accountLocked: () => true, readSettings }))
    ).resolves.toEqual({ supported: false, reason: "account-locked" })
    expect(readSettings).not.toHaveBeenCalled()
  })

  it("answers no-eligible-models when nothing passes the gateway rule", async () => {
    await expect(
      getHostCogniaModelCatalog(
        "eac_1",
        deps({
          readSettings: () => ({ providerSettings: {}, customProviders: [] }) as never,
          subscriptions: () => [],
        })
      )
    ).resolves.toEqual({ supported: false, reason: "no-eligible-models" })
  })

  it("refuses an unknown or deleted configuration and missing settings", async () => {
    await expect(
      getHostCogniaModelCatalog("eac_x", deps({ getConfig: async () => null }))
    ).rejects.toThrow("unknown configuration eac_x")
    await expect(
      getHostCogniaModelCatalog(
        "eac_1",
        deps({ getConfig: async () => ({ ...(hostRecord as object), tombstonedAt: 5 }) as never })
      )
    ).rejects.toThrow("unknown configuration")
    await expect(
      getHostCogniaModelCatalog("eac_1", deps({ readSettings: () => null }))
    ).rejects.toThrow("provider settings are unavailable")
  })

  // The headless brain has no renderer settings: its catalog is the server's
  // gateway snapshot, the one `agent_gateway_host_task_prepare` mints against.
  it("answers from the Host's own provider catalog when one is supplied", async () => {
    const readSettings = jest.fn(() => null)
    const providers = [
      { providerId: "stub-openai", providerName: "Stub", models: [{ id: "m", name: "M" }] },
    ]
    await expect(
      getHostCogniaModelCatalog(
        "eac_1",
        deps({ readSettings, hostProviders: async () => providers })
      )
    ).resolves.toEqual({ supported: true, providers })
    expect(readSettings).not.toHaveBeenCalled()
    await expect(
      getHostCogniaModelCatalog("eac_1", deps({ hostProviders: async () => [] }))
    ).resolves.toEqual({ supported: false, reason: "no-eligible-models" })
    const hostProviders = jest.fn(async () => providers)
    await expect(
      getHostCogniaModelCatalog(
        "eac_1",
        deps({ hostProviders, support: () => ({ supported: false, reason: "network-endpoint" }) })
      )
    ).resolves.toEqual({ supported: false, reason: "unsupported-runtime" })
    expect(hostProviders).not.toHaveBeenCalled()
  })

  it("reads the headless catalog from cognia-server's profile store and gateway snapshot", async () => {
    const marker = globalThis as Record<string, unknown>
    marker.__COGNIA_HEADLESS__ = true
    mockTransportCall.mockImplementation(async (name: string) =>
      name === "provider_profiles_list"
        ? {
            providerProfiles: [
              { id: "stub", displayName: "Stub AI", deploymentRefs: ["stub-openai"] },
            ],
            deploymentProfiles: [
              {
                id: "stub-openai",
                providerRef: "stub",
                credentialProfileRef: { kind: "secret-store", secretId: "stub-key" },
                models: [{ id: "stub-model", displayName: "Stub Model" }],
              },
            ],
          }
        : {
            snapshot: true,
            providers: [
              {
                id: "stub-openai",
                protocol: "openai",
                baseUrl: "http://127.0.0.1:9/v1",
                enabled: true,
                credentialPool: 1,
                models: [{ id: "stub-model", exposed: false }],
              },
            ],
          }
    )
    try {
      const hostDeps = await defaultHostCogniaModelCatalogDeps()
      expect(hostDeps.readSettings()).toBeNull()
      const catalog = await getHostCogniaModelCatalog("eac_1", {
        ...hostDeps,
        getConfig: async () => hostRecord,
        support: () => ({ supported: true, runtime: "codex" }),
        accountLocked: () => false,
      })
      expect(catalog).toEqual({
        supported: true,
        providers: [
          {
            providerId: "stub-openai",
            providerName: "Stub AI",
            models: [{ id: "stub-model", name: "Stub Model" }],
          },
        ],
      })
      expect(JSON.stringify(catalog)).not.toMatch(/secret|baseUrl|127\.0\.0\.1/)
      expect(mockTransportCall.mock.calls.map(([name]) => name).sort()).toEqual([
        "gateway_provider_capabilities",
        "provider_profiles_list",
      ])
    } finally {
      delete marker.__COGNIA_HEADLESS__
      mockTransportCall.mockReset()
    }
  })
})
