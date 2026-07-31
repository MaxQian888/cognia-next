import type { RuntimeTargetRecord } from "./target-registry"
import {
  detachActiveCompanionRuntimeTarget,
  deriveCompanionRuntimeTargetId,
  prepareAccountRuntimeTarget,
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
    listTargets: jest.fn(async () => [
      standalone,
      { ...standalone, id: "desktop-studio", kind: "companion" as const },
    ]),
    deleteTarget: jest.fn(),
    deleteAccountTargets: jest.fn(async () => {
      events.push("metadata")
    }),
  }

  await removeAccountRuntimeTargets("acct_runtime", {
    registry,
    deleteDatabase: async (name) => {
      events.push(name)
    },
  })

  expect(events).toEqual([
    "cognia-account-acct_runtime-target-web-standalone",
    "cognia-account-acct_runtime-target-desktop-studio",
    "metadata",
  ])
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

it("switches database/context only after validating the target credential", async () => {
  const companion = {
    ...standalone,
    id: "companion-studio",
    kind: "companion" as const,
    hostKind: "desktop" as const,
    credentialRef: "companion:companion-studio:device-jwt",
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
    "activate:companion-studio",
    "subscriptions",
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
    credentialRef: "companion:companion-studio:device-jwt",
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
    credentialRef: "companion:companion-studio:device-jwt",
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
    "activate:standalone",
    "subscriptions",
    "database:web-standalone",
    "context:web-standalone",
    "metadata:companion-studio",
    "database-delete:cognia-account-acct_runtime-target-companion-studio",
  ])
})
