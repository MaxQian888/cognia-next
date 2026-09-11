import Dexie from "dexie"
import type { RuntimeTargetRecord } from "./target-registry"

// The suite below always injects `dependencies`, so the DEFAULT dependency
// object — the one every production caller actually uses — was never executed.
// These two mocks are what let a test call `switchAccountRuntimeTarget` with no
// dependencies at all: the registry singleton is constructed at module load and
// would otherwise open Dexie, and `reloadTransport` dynamically imports the
// companion transport.
let mockRegistry: Record<string, jest.Mock> = {}
jest.mock("./target-registry", () => {
  const actual = jest.requireActual("./target-registry")
  const forward =
    (name: string) =>
    (...args: unknown[]) =>
      mockRegistry[name](...args)
  return {
    ...actual,
    RuntimeTargetRegistry: class {
      upsertAndActivateCompanionTarget = forward("upsertAndActivateCompanionTarget")
      getActiveTarget = forward("getActiveTarget")
      ensureStandaloneTarget = forward("ensureStandaloneTarget")
      activateTarget = forward("activateTarget")
      listTargets = forward("listTargets")
      deleteTarget = forward("deleteTarget")
      deleteAccountTargets = forward("deleteAccountTargets")
      close() {}
    },
  }
})

let mockVault: null | { accountId: string; createContentCipher: jest.Mock; loadSecret: jest.Mock } =
  null
const mockMigrate = jest.fn(async (_input: unknown) => ({ stage: "verified" as const, tables: [] }))
const mockMarkCompleted = jest.fn(async () => undefined)
const mockActivateCipher = jest.fn()
let mockRuntimeKind = "companion"
let mockExecutionLegs: Array<{ resource: string; state: string }> = []
jest.mock("./browser-vault", () => ({
  ...jest.requireActual("./browser-vault"),
  getActiveBrowserVault: () => mockVault,
}))
jest.mock("@/lib/accounts/content-cipher", () => ({
  ...jest.requireActual("@/lib/accounts/content-cipher"),
  activateAccountContentCipher: (...args: unknown[]) => mockActivateCipher(...args),
}))
jest.mock("./target-database-migration", () => ({
  ...jest.requireActual("./target-database-migration"),
  migrateAccountDatabaseToTarget: (input: unknown) => mockMigrate(input),
  markTargetDatabaseMigrationCompleted: () => mockMarkCompleted(),
}))
jest.mock("./runtime-snapshot-store", () => ({
  ...jest.requireActual("./runtime-snapshot-store"),
  getRuntimeSnapshot: () => ({ target: { kind: mockRuntimeKind } }),
}))
jest.mock("@/lib/execution/broker", () => ({
  ...jest.requireActual("@/lib/execution/broker"),
  getExecutionBroker: () => ({ list: () => mockExecutionLegs }),
}))

const mockReloadCompanionConfig = jest.fn(async () => undefined)
jest.mock("@/lib/tauri/transport-companion", () => ({
  reloadCompanionConfigForActiveTarget: () => mockReloadCompanionConfig(),
}))
import {
  detachActiveCompanionRuntimeTarget,
  deriveCompanionRuntimeTargetId,
  prepareAccountRuntimeTarget,
  registerCompanionRuntimeTarget,
  removeAccountRuntimeTargets,
  switchAccountRuntimeTarget,
} from "./account-runtime-target"

const standalone: RuntimeTargetRecord = {
  accountId: "acct_runtime",
  id: "web-standalone",
  kind: "standalone",
  label: "This browser",
  createdAt: 1,
  updatedAt: 1,
  lastUsedAt: 1,
}

describe("an already-active target", () => {
  const activeRegistry = () => ({
    getActiveTarget: jest.fn(async () => standalone),
    ensureStandaloneTarget: jest.fn(),
    activateTarget: jest.fn(),
    listTargets: jest.fn(),
    deleteTarget: jest.fn(),
    deleteAccountTargets: jest.fn(),
  })

  // Migration is a ONE-TIME fold of a plaintext database into its encrypted
  // replacement. Re-running it on every unlock opened three databases and wrote
  // a full journal cycle to copy nothing — on the stage the lock screen already
  // calls the long pole — and made an unlocked Vault a hard precondition for a
  // path that previously needed none.
  it("skips the migration when no plaintext database is left", async () => {
    const registry = activeRegistry()
    const migrate = jest.fn()
    const markCompleted = jest.fn()

    const target = await prepareAccountRuntimeTarget("acct_runtime", {
      registry,
      migrate,
      markCompleted,
      hasPendingMigration: async () => false,
    })

    expect(target).toBe(standalone)
    expect(migrate).not.toHaveBeenCalled()
    expect(markCompleted).not.toHaveBeenCalled()
  })

  it("still migrates when a plaintext database is waiting", async () => {
    const registry = activeRegistry()
    const migrate = jest.fn(async () => ({ stage: "verified" as const, tables: [] }))
    const markCompleted = jest.fn(async () => undefined)

    await prepareAccountRuntimeTarget("acct_runtime", {
      registry,
      migrate,
      markCompleted,
      hasPendingMigration: async () => true,
    })

    expect(migrate).toHaveBeenCalledWith({ accountId: "acct_runtime", targetId: standalone.id })
    expect(markCompleted).toHaveBeenCalledWith("acct_runtime", standalone.id)
  })
})

it("does not activate a new target until its database copy is verified", async () => {
  const events: string[] = []
  const registry = {
    getActiveTarget: jest.fn(async () => null),
    ensureStandaloneTarget: jest.fn(async () => standalone),
    activateTarget: jest.fn(async () => {
      events.push("activate")
      return standalone
    }),
    listTargets: jest.fn(),
    deleteTarget: jest.fn(),
    deleteAccountTargets: jest.fn(),
  }

  await prepareAccountRuntimeTarget("acct_runtime", {
    registry,
    migrate: async () => {
      events.push("verify")
      return { stage: "verified", tables: [] }
    },
    markCompleted: async () => {
      events.push("complete")
    },
  })

  expect(events).toEqual(["verify", "activate", "complete"])
})

it("keeps the active pointer unchanged when migration verification fails", async () => {
  const registry = {
    getActiveTarget: jest.fn(async () => null),
    ensureStandaloneTarget: jest.fn(async () => standalone),
    activateTarget: jest.fn(),
    listTargets: jest.fn(),
    deleteTarget: jest.fn(),
    deleteAccountTargets: jest.fn(),
  }

  await expect(
    prepareAccountRuntimeTarget("acct_runtime", {
      registry,
      migrate: async () => {
        throw new Error("verification failed")
      },
      markCompleted: jest.fn(),
    })
  ).rejects.toThrow("verification failed")

  expect(registry.activateTarget).not.toHaveBeenCalled()
})

it("deletes every physical target database before removing registry metadata", async () => {
  const events: string[] = []
  const registry = {
    getActiveTarget: jest.fn(),
    ensureStandaloneTarget: jest.fn(),
    activateTarget: jest.fn(),
    listTargets: jest
      .fn()
      .mockResolvedValueOnce([
        standalone,
        { ...standalone, id: "desktop-studio", kind: "companion" as const },
      ])
      .mockResolvedValueOnce([]),
    deleteTarget: jest.fn(),
    deleteAccountTargets: jest.fn(async () => {
      events.push("metadata")
    }),
  }

  const result = await removeAccountRuntimeTargets("acct_runtime", {
    registry,
    deleteDatabase: async (name) => {
      events.push(name)
    },
    databaseExists: async () => false,
  })

  expect(events).toEqual([
    "cognia-account-acct_runtime-target-web-standalone",
    "cognia-account-acct_runtime-target-web-standalone-encrypted-v1",
    "cognia-account-acct_runtime-target-desktop-studio",
    "cognia-account-acct_runtime-target-desktop-studio-encrypted-v1",
    "metadata",
  ])
  expect(result).toEqual({
    accountId: "acct_runtime",
    targetIds: ["web-standalone", "desktop-studio"],
    deletedDatabases: [
      "cognia-account-acct_runtime-target-web-standalone",
      "cognia-account-acct_runtime-target-web-standalone-encrypted-v1",
      "cognia-account-acct_runtime-target-desktop-studio",
      "cognia-account-acct_runtime-target-desktop-studio-encrypted-v1",
    ],
    registryRowsDeleted: 2,
  })
})

it("fails before metadata removal when physical deletion cannot be verified", async () => {
  const registry = {
    getActiveTarget: jest.fn(),
    ensureStandaloneTarget: jest.fn(),
    activateTarget: jest.fn(),
    listTargets: jest.fn(async () => [standalone]),
    deleteTarget: jest.fn(),
    deleteAccountTargets: jest.fn(),
  }

  await expect(
    removeAccountRuntimeTargets("acct_runtime", {
      registry,
      deleteDatabase: jest.fn(async () => {}),
      databaseExists: jest.fn(async () => true),
    })
  ).rejects.toThrow(/could not be verified/)
  expect(registry.deleteAccountTargets).not.toHaveBeenCalled()
})

it("derives a stable opaque target id without embedding the endpoint", async () => {
  const first = await deriveCompanionRuntimeTargetId({
    baseUrl: "https://studio.local:7890",
  })
  const second = await deriveCompanionRuntimeTargetId({
    baseUrl: "https://studio.local:7890",
  })

  expect(first).toBe(second)
  expect(first).toMatch(/^companion-[a-f0-9]{24}$/)
  expect(first).not.toContain("studio")
})

it("atomically registers the Companion metadata before switching database context", async () => {
  const events: string[] = []
  const companion = {
    ...standalone,
    id: "companion-studio",
    kind: "companion" as const,
    hostKind: "desktop" as const,
  }

  await expect(
    registerCompanionRuntimeTarget(
      {
        targetId: companion.id,
        baseUrl: "https://studio.local:27890",
        deviceId: "device-studio",
        serverVersion: "2.0.0",
      },
      {
        registry: {
          upsertAndActivateCompanionTarget: async (input) => {
            events.push(`registry:${input.id}`)
            expect(input.credentialRef).toBe(
              "companion-host:acct_runtime:companion-studio:device-private-jwk"
            )
            return companion
          },
        },
        getContext: () => ({
          accountId: "acct_runtime",
          targetId: "web-standalone",
          routingGeneration: 1,
        }),
        activateDatabase: (_accountId, targetId) => events.push(`database:${targetId}`),
        setContext: (_accountId, targetId) => events.push(`context:${targetId}`),
      }
    )
  ).resolves.toEqual(companion)

  expect(events).toEqual([
    "registry:companion-studio",
    "database:companion-studio",
    "context:companion-studio",
  ])
})

it("does not create a Companion target without an active account context", async () => {
  const upsertAndActivateCompanionTarget = jest.fn()
  await expect(
    registerCompanionRuntimeTarget(
      {
        baseUrl: "https://studio.local:27890",
        deviceId: "device-studio",
        serverVersion: "2.0.0",
      },
      {
        registry: { upsertAndActivateCompanionTarget },
        getContext: () => null,
        activateDatabase: jest.fn(),
        setContext: jest.fn(),
      }
    )
  ).resolves.toBeNull()
  expect(upsertAndActivateCompanionTarget).not.toHaveBeenCalled()
})

it("uses the account captured by pairing when the live context is unavailable", async () => {
  const companion = {
    ...standalone,
    id: "companion-studio",
    kind: "companion" as const,
    hostKind: "desktop" as const,
  }
  const upsertAndActivateCompanionTarget = jest.fn(async () => companion)
  const activateDatabase = jest.fn()
  const setContext = jest.fn()

  await expect(
    registerCompanionRuntimeTarget(
      {
        accountId: "acct_runtime",
        targetId: companion.id,
        baseUrl: "https://studio.local:27890",
        deviceId: "device-studio",
        serverVersion: "2.0.0",
      },
      {
        registry: { upsertAndActivateCompanionTarget },
        getContext: () => null,
        activateDatabase,
        setContext,
      }
    )
  ).resolves.toEqual(companion)

  expect(upsertAndActivateCompanionTarget).toHaveBeenCalledWith(
    expect.objectContaining({ accountId: "acct_runtime", id: companion.id })
  )
  expect(activateDatabase).toHaveBeenCalledWith("acct_runtime", companion.id)
  expect(setContext).toHaveBeenCalledWith("acct_runtime", companion.id)
})

it("switches database/context only after validating the target credential", async () => {
  const companion = {
    ...standalone,
    id: "companion-studio",
    kind: "companion" as const,
    hostKind: "desktop" as const,
    credentialRef: "companion-host:acct-a:companion-studio:device-private-jwk",
  }
  const events: string[] = []
  const registry = {
    getActiveTarget: jest.fn(async () => standalone),
    ensureStandaloneTarget: jest.fn(),
    activateTarget: jest.fn(async (_accountId: string, targetId: string) => {
      events.push(`activate:${targetId}`)
      return targetId === companion.id ? companion : standalone
    }),
    listTargets: jest.fn(async () => [standalone, companion]),
    deleteTarget: jest.fn(),
    deleteAccountTargets: jest.fn(),
  }

  await switchAccountRuntimeTarget("acct_runtime", companion.id, {
    registry,
    hasRunningStandaloneTurn: () => false,
    assertCredentialAvailable: async () => {
      events.push("credential")
    },
    stopSubscriptions: async () => {
      events.push("subscriptions")
    },
    activateDatabase: (_accountId, targetId) => {
      events.push(`database:${targetId}`)
    },
    setContext: (_accountId, targetId) => {
      events.push(`context:${targetId}`)
    },
    reloadTransport: async () => {
      events.push("transport")
    },
  })

  expect(events).toEqual([
    "credential",
    "subscriptions",
    "activate:companion-studio",
    "database:companion-studio",
    "context:companion-studio",
    "transport",
  ])
})

it("blocks a target switch during a local turn and rolls back a failed transport rebind", async () => {
  const companion = {
    ...standalone,
    id: "companion-studio",
    kind: "companion" as const,
    hostKind: "desktop" as const,
    credentialRef: "companion-host:acct-a:companion-studio:device-private-jwk",
  }
  const registry = {
    getActiveTarget: jest.fn(async () => standalone),
    ensureStandaloneTarget: jest.fn(),
    activateTarget: jest.fn(async (_accountId: string, targetId: string) =>
      targetId === companion.id ? companion : standalone
    ),
    listTargets: jest.fn(async () => [standalone, companion]),
    deleteTarget: jest.fn(),
    deleteAccountTargets: jest.fn(),
  }
  const base = {
    registry,
    assertCredentialAvailable: jest.fn(async () => {}),
    stopSubscriptions: jest.fn(async () => {}),
    activateDatabase: jest.fn(),
    setContext: jest.fn(),
    reloadTransport: jest.fn(async () => {}),
  }

  await expect(
    switchAccountRuntimeTarget("acct_runtime", companion.id, {
      ...base,
      hasRunningStandaloneTurn: () => true,
    })
  ).rejects.toThrow(/standalone chat turn/i)
  expect(registry.activateTarget).not.toHaveBeenCalled()

  base.reloadTransport
    .mockRejectedValueOnce(new Error("rebind failed"))
    .mockResolvedValueOnce(undefined)
  await expect(
    switchAccountRuntimeTarget("acct_runtime", companion.id, {
      ...base,
      hasRunningStandaloneTurn: () => false,
    })
  ).rejects.toThrow("rebind failed")
  expect(registry.activateTarget.mock.calls.map((call) => call[1])).toEqual([
    "companion-studio",
    "web-standalone",
  ])
  expect(base.activateDatabase).toHaveBeenLastCalledWith("acct_runtime", "web-standalone")
})

it("switches to standalone before removing a revoked active Companion target", async () => {
  const companion: RuntimeTargetRecord = {
    ...standalone,
    id: "companion-studio",
    kind: "companion",
    hostKind: "desktop",
    credentialRef: "companion-host:acct-a:companion-studio:device-private-jwk",
  }
  const events: string[] = []
  const registry = {
    getActiveTarget: jest.fn(async () => companion),
    ensureStandaloneTarget: jest.fn(async () => standalone),
    activateTarget: jest.fn(async () => {
      events.push("activate:standalone")
      return standalone
    }),
    listTargets: jest.fn(),
    deleteTarget: jest.fn(async (_accountId: string, targetId: string) => {
      events.push(`metadata:${targetId}`)
    }),
    deleteAccountTargets: jest.fn(),
  }
  const { setActiveRuntimeTargetContext, clearActiveRuntimeTargetContext } =
    await import("./runtime-target-context")
  setActiveRuntimeTargetContext("acct_runtime", companion.id)

  try {
    await detachActiveCompanionRuntimeTarget({
      registry,
      stopSubscriptions: async () => {
        events.push("subscriptions")
      },
      activateDatabase: (_accountId, targetId) => {
        events.push(`database:${targetId}`)
      },
      setContext: (_accountId, targetId) => {
        events.push(`context:${targetId}`)
      },
      deleteDatabase: async (name) => {
        events.push(`database-delete:${name}`)
      },
    })
  } finally {
    clearActiveRuntimeTargetContext()
  }

  expect(events).toEqual([
    "subscriptions",
    "activate:standalone",
    "database:web-standalone",
    "context:web-standalone",
    "metadata:companion-studio",
    "database-delete:cognia-account-acct_runtime-target-companion-studio",
  ])
})

it("completes a switch that relies on the default dependencies", async () => {
  // Regression: the default `stopSubscriptions` built its transition context
  // with a bare `toTargetId` — the *field name*, not a binding in scope — so
  // every caller that omitted `dependencies` (the runtime-target menu's "This
  // browser" row, `removeCompanionHost`) threw `ReferenceError: toTargetId is
  // not defined` and left the account on the target it was trying to leave.
  const companion: RuntimeTargetRecord = {
    ...standalone,
    id: "companion-studio",
    kind: "companion",
    hostKind: "desktop",
  }
  mockRegistry = {
    getActiveTarget: jest.fn(async () => companion),
    ensureStandaloneTarget: jest.fn(async () => standalone),
    activateTarget: jest.fn(async () => standalone),
    listTargets: jest.fn(async () => [standalone, companion]),
    deleteTarget: jest.fn(),
    deleteAccountTargets: jest.fn(),
  }
  mockReloadCompanionConfig.mockClear()

  const { registerRuntimeTargetTransitionParticipant } = await import("./runtime-target-lifecycle")
  const { setActiveRuntimeTargetContext, clearActiveRuntimeTargetContext } =
    await import("./runtime-target-context")
  const contexts: Array<Record<string, unknown>> = []
  const unregister = registerRuntimeTargetTransitionParticipant({
    id: "default-dependency-regression",
    phase: "release-subscriptions",
    priority: 0,
    run: (context) => {
      contexts.push({ ...context })
    },
  })
  setActiveRuntimeTargetContext("acct_runtime", companion.id)

  try {
    await expect(switchAccountRuntimeTarget("acct_runtime", standalone.id)).resolves.toEqual(
      standalone
    )
  } finally {
    unregister()
    clearActiveRuntimeTargetContext()
  }

  expect(mockRegistry.activateTarget).toHaveBeenCalledWith("acct_runtime", standalone.id)
  expect(mockReloadCompanionConfig).toHaveBeenCalledTimes(1)
  // The destination the participants are told about is the target being
  // switched TO, not the one being left.
  expect(contexts).toEqual([
    { accountId: "acct_runtime", fromTargetId: companion.id, toTargetId: standalone.id },
  ])
})

it("does not publish hydration runtime context after registration becomes stale", async () => {
  let current = true
  const activateDatabase = jest.fn()
  const setContext = jest.fn()
  const upsertAndActivateCompanionTarget = jest.fn(async () => {
    current = false
    return { ...standalone, id: "companion-stale" }
  })
  await expect(
    registerCompanionRuntimeTarget(
      {
        accountId: "acct_runtime",
        targetId: "companion-stale",
        baseUrl: "https://stale.example",
        deviceId: "stale-device",
        serverVersion: "2.0.0",
      },
      {
        registry: { upsertAndActivateCompanionTarget },
        getContext: () => null,
        activateDatabase,
        setContext,
      },
      () => current
    )
  ).resolves.toBeNull()
  expect(activateDatabase).not.toHaveBeenCalled()
  expect(setContext).not.toHaveBeenCalled()
})

describe("default runtime lifecycle boundaries", () => {
  const companion: RuntimeTargetRecord = {
    ...standalone,
    id: "host-default",
    kind: "companion",
    hostKind: "cloud",
    credentialRef: "vault-ref",
  }
  let existingDatabases: Set<string>
  let exists: jest.SpyInstance
  let deleteDatabase: jest.SpyInstance
  beforeEach(() => {
    existingDatabases = new Set()
    exists = jest
      .spyOn(Dexie, "exists")
      .mockImplementation(async (name) => existingDatabases.has(name))
    deleteDatabase = jest.spyOn(Dexie, "delete").mockImplementation(async (name) => {
      existingDatabases.delete(name)
    })
    mockVault = {
      accountId: "acct_runtime",
      createContentCipher: jest.fn(() => ({})),
      loadSecret: jest.fn(async () => "key"),
    }
    mockMigrate.mockClear()
    mockMarkCompleted.mockClear()
    mockActivateCipher.mockClear()
    mockReloadCompanionConfig.mockReset().mockResolvedValue(undefined)
    mockRuntimeKind = "companion"
    mockExecutionLegs = []
    mockRegistry = {
      getActiveTarget: jest.fn(async () => null),
      ensureStandaloneTarget: jest.fn(async () => standalone),
      activateTarget: jest.fn(async (_accountId, id) =>
        id === standalone.id ? standalone : companion
      ),
      upsertAndActivateCompanionTarget: jest.fn(async () => companion),
      listTargets: jest.fn(async () => [standalone, companion]),
      deleteTarget: jest.fn(async () => undefined),
      deleteAccountTargets: jest.fn(async () => undefined),
    }
  })
  afterEach(async () => {
    exists.mockRestore()
    deleteDatabase.mockRestore()
    mockVault = null
    mockRuntimeKind = "companion"
    mockExecutionLegs = []
    const { clearActiveRuntimeTargetContext } = await import("./runtime-target-context")
    clearActiveRuntimeTargetContext()
  })

  it.each(["legacy-target", "account", "absent"])(
    "migrates %s plaintext before activating the encrypted target",
    async (source) => {
      const legacy = "cognia-account-acct_runtime-target-web-standalone"
      const account = "cognia-account-acct_runtime"
      if (source !== "absent") existingDatabases.add(source === "legacy-target" ? legacy : account)
      expect(await prepareAccountRuntimeTarget("acct_runtime")).toEqual(standalone)
      expect(mockMigrate).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceDbName: source === "legacy-target" ? legacy : account,
          targetDbName: `${legacy}-encrypted-v1`,
        })
      )
      expect(mockVault!.createContentCipher).toHaveBeenCalledWith(`${legacy}-encrypted-v1`)
      expect(mockActivateCipher).toHaveBeenCalledTimes(1)
      expect(mockRegistry.activateTarget).toHaveBeenCalledTimes(1)
      expect(mockMarkCompleted).toHaveBeenCalledTimes(1)
      expect(existingDatabases.size).toBe(0)
    }
  )

  it.each([null, "acct_other"])(
    "refuses migration when the unlocked Vault belongs to %s",
    async (accountId) => {
      mockVault = accountId ? { ...mockVault!, accountId } : null
      await expect(prepareAccountRuntimeTarget("acct_runtime")).rejects.toThrow(
        "Vault must be unlocked"
      )
      expect(mockMigrate).not.toHaveBeenCalled()
      expect(mockRegistry.activateTarget).not.toHaveBeenCalled()
    }
  )

  it("does not mark migration complete if plaintext deletion cannot be verified", async () => {
    exists.mockResolvedValue(true)
    await expect(prepareAccountRuntimeTarget("acct_runtime")).rejects.toThrow(
      "deletion could not be verified"
    )
    expect(mockMarkCompleted).not.toHaveBeenCalled()
    expect(mockRegistry.activateTarget).not.toHaveBeenCalled()
  })

  it.each([false, true])(
    "probes an already-active target for pending plaintext: %s",
    async (pending) => {
      mockRegistry.getActiveTarget.mockResolvedValue(standalone)
      if (pending) existingDatabases.add("cognia-account-acct_runtime")
      expect(await prepareAccountRuntimeTarget("acct_runtime")).toEqual(standalone)
      expect(mockMigrate).toHaveBeenCalledTimes(pending ? 1 : 0)
      expect(mockRegistry.activateTarget).not.toHaveBeenCalled()
    }
  )

  it("verifies account registry removal after default physical database deletion", async () => {
    mockRegistry.listTargets.mockResolvedValueOnce([standalone]).mockResolvedValueOnce([])
    expect((await removeAccountRuntimeTargets("acct_runtime")).registryRowsDeleted).toBe(1)
    expect(deleteDatabase).toHaveBeenCalledTimes(2)
    mockRegistry.listTargets.mockResolvedValue([standalone])
    await expect(removeAccountRuntimeTargets("acct_runtime")).rejects.toThrow(
      "registry deletion could not be verified"
    )
  })

  it.each(["locked", "wrong-account", "missing-reference", "missing-secret"])(
    "refuses a default Host switch with %s credentials",
    async (kind) => {
      mockRegistry.getActiveTarget.mockResolvedValue(standalone)
      if (kind === "locked") mockVault = null
      if (kind === "wrong-account") mockVault!.accountId = "acct_other"
      if (kind === "missing-reference")
        mockRegistry.listTargets.mockResolvedValue([
          standalone,
          { ...companion, credentialRef: undefined },
        ])
      if (kind === "missing-secret") mockVault!.loadSecret.mockResolvedValue(null)
      await expect(switchAccountRuntimeTarget("acct_runtime", companion.id)).rejects.toThrow(
        /Vault|credentials/
      )
      expect(mockRegistry.activateTarget).not.toHaveBeenCalled()
    }
  )

  it("blocks only active standalone AI turns before a default Host switch", async () => {
    mockRuntimeKind = "standalone"
    mockExecutionLegs = [{ resource: "ai-turn", state: "running" }]
    await expect(switchAccountRuntimeTarget("acct_runtime", companion.id)).rejects.toThrow(
      "must stop or finish"
    )
    mockExecutionLegs = [
      { resource: "terminal", state: "running" },
      { resource: "ai-turn", state: "done" },
    ]
    await expect(switchAccountRuntimeTarget("acct_runtime", companion.id)).resolves.toEqual(
      companion
    )
    expect(mockReloadCompanionConfig).toHaveBeenCalledTimes(1)
  })

  it("reports a missing target and a failed first activation without inventing a rollback target", async () => {
    await expect(switchAccountRuntimeTarget("acct_runtime", "host-missing")).rejects.toThrow(
      "does not exist"
    )
    mockReloadCompanionConfig.mockRejectedValueOnce(new Error("transport refused"))
    await expect(switchAccountRuntimeTarget("acct_runtime", companion.id)).rejects.toThrow(
      "transport refused"
    )
    expect(mockRegistry.activateTarget).toHaveBeenCalledTimes(1)
  })

  it("registers default Host context only while its pairing guard remains current", async () => {
    const { setActiveRuntimeTargetContext, getActiveRuntimeTargetContext } =
      await import("./runtime-target-context")
    setActiveRuntimeTargetContext("acct_runtime", standalone.id)
    const config = { baseUrl: "https://cloud.example", deviceId: "device", serverVersion: "2.0.0" }
    expect(await registerCompanionRuntimeTarget(config, undefined, () => false)).toBeNull()
    expect(mockRegistry.upsertAndActivateCompanionTarget).not.toHaveBeenCalled()
    expect(await registerCompanionRuntimeTarget(config, undefined, () => true)).toEqual(companion)
    expect(getActiveRuntimeTargetContext()?.targetId).toBe(companion.id)
  })

  it("detaches a default Companion after releasing its runtime subscriptions", async () => {
    const { setActiveRuntimeTargetContext, getActiveRuntimeTargetContext } =
      await import("./runtime-target-context")
    setActiveRuntimeTargetContext("acct_runtime", companion.id)
    mockRegistry.getActiveTarget.mockResolvedValue(companion)
    expect(await detachActiveCompanionRuntimeTarget()).toEqual(standalone)
    expect(getActiveRuntimeTargetContext()?.targetId).toBe(standalone.id)
    expect(mockRegistry.deleteTarget).toHaveBeenCalledWith("acct_runtime", companion.id)
    expect(deleteDatabase).toHaveBeenCalledWith("cognia-account-acct_runtime-target-host-default")
  })

  it.each([null, standalone, { ...companion, id: "host-other" }])(
    "leaves a nonmatching active target untouched during detach: %p",
    async (active) => {
      const { setActiveRuntimeTargetContext } = await import("./runtime-target-context")
      setActiveRuntimeTargetContext("acct_runtime", companion.id)
      mockRegistry.getActiveTarget.mockResolvedValue(active)
      expect(await detachActiveCompanionRuntimeTarget()).toEqual(active)
      expect(mockRegistry.deleteTarget).not.toHaveBeenCalled()
      expect(deleteDatabase).not.toHaveBeenCalled()
    }
  )
})
