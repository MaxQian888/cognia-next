/** @jest-environment jsdom */

import type { CompanionCredentialBook, CompanionHostRecord } from "./credential-book"
import type { RuntimeTargetRecord } from "@/lib/runtime/target-registry"
import {
  COMPANION_HOST_LABEL_EVENT,
  pairAndActivateCompanionHost,
  renameCompanionHost,
  subscribeCompanionHostLabels,
  switchCompanionHost,
  type HostOrchestrationDependencies,
} from "./host-orchestration"

const accountId = "local_acct_a"

function host(hostId: string): CompanionHostRecord {
  return {
    hostId,
    accountNamespace: accountId,
    label: `Host ${hostId}`,
    endpoints: { baseUrl: `https://${hostId}.local:7890` },
    tlsPin: `pin-${hostId}`,
    cursorNamespace: `${accountId}:${hostId}`,
    deviceId: `device-${hostId}`,
    deviceKeyThumbprint: `thumb-${hostId}`,
    serverVersion: "1.0.0",
    connection: {
      status: "online",
      generation: 1,
      lastOkAt: 1,
      lastErrorAt: null,
      lastError: null,
    },
    createdAt: 1,
    updatedAt: 1,
  }
}

function target(hostId: string): RuntimeTargetRecord {
  return {
    accountId,
    id: hostId,
    kind: "companion",
    hostKind: "desktop",
    label: `Host ${hostId}`,
    baseUrl: `https://${hostId}.local:7890`,
    deviceId: `device-${hostId}`,
    serverVersion: "1.0.0",
    credentialRef: `credential-${hostId}`,
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: 1,
  }
}

function harness(options: { failReload?: boolean; failRollback?: boolean } = {}) {
  const order: string[] = []
  let activeHost = host("host-a")
  let activeTarget = target("host-a")
  let reloadCount = 0
  const hosts = new Map([
    ["host-a", host("host-a")],
    ["host-b", host("host-b")],
  ])
  const targets = new Map([
    ["host-a", target("host-a")],
    ["host-b", target("host-b")],
  ])
  const book = {
    list: async () => [...hosts.values()],
    get: async ({ hostId }: { hostId: string }) => hosts.get(hostId) ?? null,
    getActive: async () => activeHost,
    setActive: async ({ hostId }: { hostId: string }) => {
      order.push(`book:${hostId}`)
      activeHost = hosts.get(hostId)!
    },
    clearActive: jest.fn(),
    loadCredential: async ({ hostId }: { hostId: string }) => {
      order.push(`credential:${hostId}`)
      return { devicePrivateKeyJwk: { kty: "EC", d: `secret-${hostId}` } }
    },
  } as unknown as CompanionCredentialBook
  const dependencies: HostOrchestrationDependencies = {
    book,
    registry: {
      getActiveTarget: async () => activeTarget,
      listTargets: async () => [...targets.values()],
      upsertCompanionTarget: async (input) => {
        const row = target(input.id)
        targets.set(input.id, row)
        return row
      },
      activateTarget: async (_accountId, hostId) => {
        order.push(`registry:${hostId}`)
        if (options.failRollback && hostId === "host-a") throw new Error("rollback registry failed")
        activeTarget = targets.get(hostId)!
        return activeTarget
      },
      deleteTarget: async (_accountId, targetId) => {
        order.push(`registry:delete:${targetId}`)
        if (activeTarget.id === targetId) {
          throw new Error("The active runtime target must be switched before it can be removed.")
        }
        targets.delete(targetId)
      },
      deleteActiveTarget: async (_accountId, targetId) => {
        order.push(`registry:delete-active:${targetId}`)
        if (activeTarget.id !== targetId) {
          throw new Error(`Runtime target ${targetId} is not the active runtime target.`)
        }
        targets.delete(targetId)
      },
    },
    runPhase: async (phase) => {
      order.push(`phase:${phase}`)
    },
    activateDatabase: (_accountId, hostId) => order.push(`database:${hostId}`),
    setContext: (_accountId, hostId) => order.push(`context:${hostId}`),
    reloadTransport: async () => {
      reloadCount += 1
      order.push(`reload:${activeTarget.id}`)
      if (options.failReload && reloadCount === 1) throw new Error("reload failed")
      const record = hosts.get(activeTarget.id)!
      return {
        targetId: record.hostId,
        accountId,
        baseUrl: record.endpoints.baseUrl,
        deviceId: record.deviceId,
        devicePrivateKeyJwk: { kty: "EC", d: `secret-${record.hostId}` },
        deviceKeyThumbprint: record.deviceKeyThumbprint,
        serverVersion: record.serverVersion,
      }
    },
    negotiateHost: async (_config, record) => {
      order.push(`manifest:${record.hostId}`)
      return { compatible: true, operations: ["claude_send"], grants: ["claude.chat"] }
    },
    authoritativeSync: async () => {
      order.push(`sync:${activeTarget.id}`)
    },
    rebindHostServices: async (record) => {
      order.push(`rebind:${record.hostId}`)
    },
    publishSnapshot: (snapshot) =>
      order.push(`snapshot:${snapshot.target?.id}:${snapshot.connectionState}`),
    enterOffline: async () => {
      order.push("offline")
    },
  }
  return { dependencies, order, targets, activeTargetId: () => activeTarget.id }
}

it("switches in the required quiesce, teardown, activation, sync, bind, publish order", async () => {
  const { dependencies, order } = harness()

  await switchCompanionHost({ accountId, hostId: "host-b", platform: "mobile" }, dependencies)

  expect(order).toEqual([
    "credential:host-b",
    "phase:finalize-captures",
    "phase:release-subscriptions",
    "book:host-b",
    "registry:host-b",
    "database:host-b",
    "context:host-b",
    "snapshot:host-b:connecting",
    "reload:host-b",
    "manifest:host-b",
    "sync:host-b",
    "rebind:host-b",
    "snapshot:host-b:online",
  ])
})

it("restores pointer, database, context, transport, manifest, and bindings after failure", async () => {
  const { dependencies, order } = harness({ failReload: true })

  await expect(
    switchCompanionHost({ accountId, hostId: "host-b", platform: "web" }, dependencies)
  ).rejects.toThrow("reload failed")

  expect(order).toEqual(
    expect.arrayContaining([
      "book:host-a",
      "registry:host-a",
      "database:host-a",
      "context:host-a",
      "reload:host-a",
      "manifest:host-a",
      "sync:host-a",
      "rebind:host-a",
      "snapshot:host-a:online",
    ])
  )
  expect(order).not.toContain("offline")
})

it("fails closed with the activation and rollback errors when rollback is incomplete", async () => {
  const { dependencies, order } = harness({ failReload: true, failRollback: true })

  const failure = await switchCompanionHost(
    { accountId, hostId: "host-b", platform: "mobile" },
    dependencies
  ).catch((error) => error)

  expect(failure).toBeInstanceOf(AggregateError)
  expect((failure as AggregateError).errors).toHaveLength(2)
  expect(order).toContain("offline")
})

it("rejects a Host whose secret is unavailable before quiescing", async () => {
  const { dependencies, order } = harness()
  dependencies.book = {
    ...dependencies.book,
    loadCredential: async () => null,
  }

  await expect(
    switchCompanionHost({ accountId, hostId: "host-b", platform: "mobile" }, dependencies)
  ).rejects.toThrow(/credential is unavailable/i)
  expect(order).toEqual([])
})

it("re-pairs the same stable hostId by updating its record instead of adding a duplicate", async () => {
  const { dependencies } = harness()
  const upsert = jest.fn(async (draft: Parameters<CompanionCredentialBook["upsert"]>[0]) => ({
    ...host(draft.hostId),
    ...draft,
  }))
  const saveCredential = jest.fn().mockResolvedValue(undefined)
  dependencies.book = {
    ...dependencies.book,
    upsert,
    saveCredential,
  }

  await pairAndActivateCompanionHost(
    {
      accountId,
      platform: "mobile",
      config: {
        targetId: "host-a",
        accountId,
        baseUrl: "https://host-a-new.local:7890",
        deviceId: "device-host-a-new",
        devicePrivateKeyJwk: { kty: "EC", d: "new-secret" },
        deviceKeyThumbprint: "new-thumb",
        serverVersion: "2.0.0",
      },
    },
    dependencies
  )

  expect(upsert).toHaveBeenCalledTimes(1)
  expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ hostId: "host-a" }))
  expect(saveCredential).toHaveBeenCalledWith(
    { accountNamespace: accountId, hostId: "host-a" },
    expect.objectContaining({ devicePrivateKeyJwk: expect.objectContaining({ d: "new-secret" }) })
  )
})

it("removes a newly paired Host when its first activation fails", async () => {
  const { dependencies } = harness({ failReload: true })
  const hostB = host("host-b")
  let persisted = false
  const remove = jest.fn().mockResolvedValue(undefined)
  dependencies.book = {
    ...dependencies.book,
    get: async ({ hostId }: { hostId: string }) => {
      if (hostId === "host-b") return persisted ? hostB : null
      return host("host-a")
    },
    loadCredential: async ({ hostId }: { hostId: string }) => {
      if (hostId === "host-b" && !persisted) return null
      return { devicePrivateKeyJwk: { kty: "EC", d: `secret-${hostId}` } }
    },
    saveCredential: async () => {
      persisted = true
    },
    upsert: async () => {
      persisted = true
      return hostB
    },
    remove,
  }

  await expect(
    pairAndActivateCompanionHost(
      {
        accountId,
        platform: "mobile",
        config: {
          targetId: "host-b",
          accountId,
          baseUrl: hostB.endpoints.baseUrl,
          deviceId: hostB.deviceId,
          devicePrivateKeyJwk: { kty: "EC", d: "new-secret" },
          deviceKeyThumbprint: hostB.deviceKeyThumbprint,
          serverVersion: hostB.serverVersion,
        },
      },
      dependencies
    )
  ).rejects.toThrow("reload failed")

  expect(remove).toHaveBeenCalledWith({ accountNamespace: accountId, hostId: "host-b" })
  expect(await dependencies.book.getActive(accountId)).toEqual(host("host-a"))
})

it("deletes the runtime target a failed first pairing created, before its book record", async () => {
  const { dependencies, targets, order } = harness({ failReload: true })
  const hostC = host("host-c")
  let persisted = false
  dependencies.book = {
    ...dependencies.book,
    get: async ({ hostId }: { hostId: string }) =>
      hostId === "host-c" ? (persisted ? hostC : null) : host("host-a"),
    loadCredential: async ({ hostId }: { hostId: string }) =>
      hostId === "host-c" && !persisted
        ? null
        : { devicePrivateKeyJwk: { kty: "EC", d: `secret-${hostId}` } },
    saveCredential: async () => {
      persisted = true
    },
    upsert: async () => {
      persisted = true
      return hostC
    },
    remove: async () => {
      order.push("book:remove:host-c")
    },
  } as unknown as CompanionCredentialBook

  await expect(
    pairAndActivateCompanionHost(
      {
        accountId,
        platform: "web",
        config: {
          targetId: "host-c",
          accountId,
          baseUrl: hostC.endpoints.baseUrl,
          deviceId: hostC.deviceId,
          devicePrivateKeyJwk: { kty: "EC", d: "new-secret" },
          deviceKeyThumbprint: hostC.deviceKeyThumbprint,
          serverVersion: hostC.serverVersion,
        },
      },
      dependencies
    )
  ).rejects.toThrow("reload failed")

  // Left behind, this row is what the Host picker lists, and both switching to
  // it and removing it answer "Companion Host host-c is not paired."
  expect(targets.has("host-c")).toBe(false)
  expect(order.indexOf("registry:delete:host-c")).toBeLessThan(order.indexOf("book:remove:host-c"))
})

it("clears the active pointer with the target when the pairing rollback also failed", async () => {
  const { dependencies, targets, order } = harness({ failReload: true, failRollback: true })
  const hostC = host("host-c")
  let persisted = false
  dependencies.book = {
    ...dependencies.book,
    get: async ({ hostId }: { hostId: string }) =>
      hostId === "host-c" ? (persisted ? hostC : null) : host("host-a"),
    loadCredential: async ({ hostId }: { hostId: string }) =>
      hostId === "host-c" && !persisted
        ? null
        : { devicePrivateKeyJwk: { kty: "EC", d: `secret-${hostId}` } },
    saveCredential: async () => {
      persisted = true
    },
    upsert: async () => {
      persisted = true
      return hostC
    },
    remove: jest.fn().mockResolvedValue(undefined),
  } as unknown as CompanionCredentialBook

  await expect(
    pairAndActivateCompanionHost(
      {
        accountId,
        platform: "mobile",
        config: {
          targetId: "host-c",
          accountId,
          baseUrl: hostC.endpoints.baseUrl,
          deviceId: hostC.deviceId,
          devicePrivateKeyJwk: { kty: "EC", d: "new-secret" },
          deviceKeyThumbprint: hostC.deviceKeyThumbprint,
          serverVersion: hostC.serverVersion,
        },
      },
      dependencies
    )
  ).rejects.toThrow(/rollback was incomplete/i)

  expect(order).toContain("offline")
  // `deleteTarget` refuses the target the active pointer names, so without the
  // pointer-aware path the row would survive its own cleanup.
  expect(order).toContain("registry:delete-active:host-c")
  expect(targets.has("host-c")).toBe(false)
})

it("restores the previous runtime target when a re-pair of the same Host fails", async () => {
  const { dependencies } = harness({ failReload: true })
  const upsertCompanionTarget = jest.fn(dependencies.registry.upsertCompanionTarget)
  dependencies.registry = { ...dependencies.registry, upsertCompanionTarget }
  dependencies.book = {
    ...dependencies.book,
    upsert: async (draft: Parameters<CompanionCredentialBook["upsert"]>[0]) => ({
      ...host(draft.hostId),
      ...draft,
    }),
    saveCredential: jest.fn().mockResolvedValue(undefined),
    remove: jest.fn().mockResolvedValue(undefined),
  } as unknown as CompanionCredentialBook

  await expect(
    pairAndActivateCompanionHost(
      {
        accountId,
        platform: "web",
        config: {
          targetId: "host-a",
          accountId,
          baseUrl: "https://host-a-new.local:7890",
          deviceId: "device-host-a-new",
          devicePrivateKeyJwk: { kty: "EC", d: "new-secret" },
          deviceKeyThumbprint: "new-thumb",
          serverVersion: "2.0.0",
        },
      },
      dependencies
    )
  ).rejects.toThrow("reload failed")

  // The book record is restored, so the target row must be too. Otherwise the
  // picker advertises an endpoint the restored credential cannot reach.
  expect(upsertCompanionTarget).toHaveBeenCalledTimes(2)
  expect(upsertCompanionTarget).toHaveBeenLastCalledWith(
    expect.objectContaining({
      id: "host-a",
      baseUrl: "https://host-a.local:7890",
      deviceId: "device-host-a",
      serverVersion: "1.0.0",
    })
  )
})

describe("renameCompanionHost", () => {
  function renameHarness(options: { withTarget?: boolean } = {}) {
    const records = new Map([["host-a", host("host-a")]])
    const upsert = jest.fn(async (draft: CompanionHostRecord) => {
      const saved = { ...draft, updatedAt: 2 }
      records.set(draft.hostId, saved)
      return saved
    })
    const book = {
      get: async ({ hostId }: { hostId: string }) => records.get(hostId) ?? null,
      upsert,
    } as unknown as CompanionCredentialBook
    const upsertCompanionTarget = jest.fn(async (input: { id: string }) => target(input.id))
    const registry = {
      listTargets: async () => (options.withTarget === false ? [] : [target("host-a")]),
      upsertCompanionTarget,
    } as unknown as HostOrchestrationDependencies["registry"]
    return { deps: { book, registry }, records, upsert, upsertCompanionTarget }
  }

  it("files the new name in the pairing record and the Host picker's target, and says so", async () => {
    const { deps, records, upsertCompanionTarget } = renameHarness()
    const heard = jest.fn()
    const stop = subscribeCompanionHostLabels(heard)
    const saved = await renameCompanionHost(
      { accountId, hostId: "host-a", label: "  Cloud \n box  " },
      deps
    )
    stop()
    expect(saved.label).toBe("Cloud box")
    expect(records.get("host-a")?.label).toBe("Cloud box")
    // Everything else about the pairing is untouched.
    expect(records.get("host-a")).toMatchObject({
      deviceId: "device-host-a",
      tlsPin: "pin-host-a",
      endpoints: { baseUrl: "https://host-a.local:7890" },
    })
    expect(upsertCompanionTarget).toHaveBeenCalledWith(
      expect.objectContaining({ id: "host-a", label: "Cloud box" })
    )
    expect(heard).toHaveBeenCalledTimes(1)
  })

  it("does not create a runtime target the Host never had", async () => {
    const { deps, upsertCompanionTarget } = renameHarness({ withTarget: false })
    await renameCompanionHost({ accountId, hostId: "host-a", label: "Cloud box" }, deps)
    expect(upsertCompanionTarget).not.toHaveBeenCalled()
  })

  it("writes nothing for the same name, an empty one, or a Host that is not paired", async () => {
    const { deps, upsert } = renameHarness()
    const heard = jest.fn()
    window.addEventListener(COMPANION_HOST_LABEL_EVENT, heard)
    await renameCompanionHost({ accountId, hostId: "host-a", label: "Host host-a" }, deps)
    await expect(
      renameCompanionHost({ accountId, hostId: "host-a", label: " \t " }, deps)
    ).rejects.toThrow("cannot be empty")
    await expect(
      renameCompanionHost({ accountId, hostId: "host-z", label: "Cloud box" }, deps)
    ).rejects.toThrow("not paired")
    window.removeEventListener(COMPANION_HOST_LABEL_EVENT, heard)
    expect(upsert).not.toHaveBeenCalled()
    expect(heard).not.toHaveBeenCalled()
  })

  it("keeps at most 64 characters", async () => {
    const { deps } = renameHarness()
    const saved = await renameCompanionHost(
      { accountId, hostId: "host-a", label: "名".repeat(80) },
      deps
    )
    expect(Array.from(saved.label)).toHaveLength(64)
  })
})
