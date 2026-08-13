import type {
  CompanionCredentialBook,
  CompanionHostCredential,
  CompanionHostRecord,
} from "./credential-book"
import { adoptMobileCompanionHosts } from "./mobile-host-adoption"

const credential: CompanionHostCredential = {
  devicePrivateKeyJwk: { kty: "EC", d: "secret" },
}

function record(accountNamespace: string, hostId: string): CompanionHostRecord {
  return {
    hostId,
    accountNamespace,
    label: hostId,
    endpoints: { baseUrl: `https://${hostId}.local:7890` },
    tlsPin: `pin-${hostId}`,
    cursorNamespace: `${accountNamespace}:${hostId}`,
    deviceId: `device-${hostId}`,
    deviceKeyThumbprint: `thumb-${hostId}`,
    serverVersion: "1.0.0",
    connection: {
      status: "unknown",
      generation: 0,
      lastOkAt: null,
      lastErrorAt: null,
      lastError: null,
    },
    createdAt: 1,
    updatedAt: 1,
  }
}

function harness(failAfterStage?: string) {
  const source = record("__local__", "host-a")
  const records = new Map([["__local__:host-a", source]])
  const secrets = new Map([["__local__:host-a", credential]])
  let active = source
  let journalStage: string | undefined
  const key = (accountNamespace: string, hostId: string) => `${accountNamespace}:${hostId}`
  const book = {
    list: async (accountNamespace?: string) =>
      [...records.values()].filter(
        (item) => !accountNamespace || item.accountNamespace === accountNamespace
      ),
    get: async ({ accountNamespace, hostId }: { accountNamespace: string; hostId: string }) =>
      records.get(key(accountNamespace, hostId)) ?? null,
    upsert: async (draft: CompanionHostRecord) => {
      const row = { ...draft, cursorNamespace: `${draft.accountNamespace}:${draft.hostId}` }
      records.set(key(row.accountNamespace, row.hostId), row)
      return row
    },
    remove: async ({ accountNamespace, hostId }: { accountNamespace: string; hostId: string }) => {
      records.delete(key(accountNamespace, hostId))
      secrets.delete(key(accountNamespace, hostId))
    },
    getActive: async (accountNamespace: string) =>
      active.accountNamespace === accountNamespace ? active : null,
    setActive: async ({
      accountNamespace,
      hostId,
    }: {
      accountNamespace: string
      hostId: string
    }) => {
      active = records.get(key(accountNamespace, hostId))!
    },
    loadCredential: async ({
      accountNamespace,
      hostId,
    }: {
      accountNamespace: string
      hostId: string
    }) => secrets.get(key(accountNamespace, hostId)) ?? null,
    saveCredential: async (
      { accountNamespace, hostId }: { accountNamespace: string; hostId: string },
      value: CompanionHostCredential
    ) => {
      secrets.set(key(accountNamespace, hostId), value)
    },
  } as unknown as CompanionCredentialBook
  const stages: string[] = []
  const dependencies = {
    book,
    journal: {
      get: async () => (journalStage ? { stage: journalStage } : undefined),
      put: async (entry: { stage: string }) => {
        journalStage = entry.stage
        stages.push(entry.stage)
        if (entry.stage === failAfterStage) throw new Error(`interrupted:${entry.stage}`)
      },
    },
    migrateDatabase: jest.fn().mockResolvedValue(undefined),
    rescopeQueue: jest.fn().mockResolvedValue(2),
  }
  return { dependencies, records, secrets, stages, active: () => active }
}

it("copies and verifies secrets, preserves active Host, migrates data, then removes source", async () => {
  const { dependencies, records, secrets, active, stages } = harness()

  await adoptMobileCompanionHosts(dependencies)

  expect(records.has("__local__:host-a")).toBe(false)
  expect(secrets.has("__local__:host-a")).toBe(false)
  expect(records.has("local_acct_a:host-a")).toBe(true)
  expect(secrets.has("local_acct_a:host-a")).toBe(true)
  expect(active()).toMatchObject({ accountNamespace: "local_acct_a", hostId: "host-a" })
  expect(dependencies.migrateDatabase).toHaveBeenCalledWith("host-a")
  expect(dependencies.rescopeQueue).toHaveBeenCalledWith("host-a")
  expect(stages).toEqual([
    "copying-credentials",
    "credentials-verified",
    "database-verified",
    "completed",
  ])
})

it("is idempotent after interruption and never deletes source before verification", async () => {
  const first = harness("credentials-verified")
  await expect(adoptMobileCompanionHosts(first.dependencies)).rejects.toThrow(
    "interrupted:credentials-verified"
  )
  expect(first.records.has("__local__:host-a")).toBe(true)
  expect(first.secrets.has("__local__:host-a")).toBe(true)

  const retryDependencies = {
    ...first.dependencies,
    journal: {
      get: async () => ({ stage: "credentials-verified" }),
      put: jest.fn().mockResolvedValue(undefined),
    },
  }
  await adoptMobileCompanionHosts(retryDependencies)
  expect(first.records.has("__local__:host-a")).toBe(false)
  expect(first.records.has("local_acct_a:host-a")).toBe(true)
})

it("does nothing after the completed journal stage", async () => {
  const { dependencies } = harness()
  dependencies.journal.get = async () => ({ stage: "completed" })

  await adoptMobileCompanionHosts(dependencies)

  expect(dependencies.migrateDatabase).not.toHaveBeenCalled()
  expect(dependencies.rescopeQueue).not.toHaveBeenCalled()
})
