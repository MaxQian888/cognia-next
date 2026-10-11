/** @jest-environment jsdom */

import "fake-indexeddb/auto"

import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import type { BotInstallationRow } from "@/lib/db/bot-types"
import type { ScheduledTask } from "@/types/scheduler"

import type { HostFacts } from "./host-facts"
import {
  armCompanionOnHost,
  armOnHost,
  checkItem,
  companionsOf,
  connectorSchedules,
  createCompanionOnHost,
  createOnHost,
  portableScheduledTask,
  remoteItemIdFor,
  remoteStatus,
  removeCompanionFromHost,
  removeFromHost,
  setCompanionOwner,
  setLocalOwner,
  type LoadedBotInstallation,
  type LoadedConnectorInstance,
  type LoadedScheduledTask,
  type TransferContext,
} from "./items"

const mockKeyringGet = jest.fn(async (_id: string, _name: string): Promise<string | null> => null)
jest.mock("@/lib/connectors/tauri/commands", () => ({
  connectorsKeyringGet: (id: string, name: string) => mockKeyringGet(id, name),
}))

const mockSetTaskOwner = jest.fn(async (..._args: unknown[]) => ({ id: "t" }))
const mockGetTask = jest.fn(async (_id: string): Promise<ScheduledTask | undefined> => undefined)
jest.mock("@/lib/scheduler/task-scheduler", () => ({
  getTaskScheduler: () => ({
    setTaskOwner: mockSetTaskOwner,
    getTask: (id: string) => mockGetTask(id),
  }),
}))

const OP = "123e4567-e89b-42d3-a456-426614174000"

function task(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "task-1",
    name: "Morning digest",
    type: "chat",
    trigger: { type: "once", runAt: new Date("2030-01-01T09:00:00Z") },
    payload: { prompt: "Summarise" },
    config: { timeout: 1000, maxRetries: 0, retryDelay: 1000, runMissedOnStartup: false },
    notification: { onStart: false, onComplete: false, onError: true },
    status: "active",
    runCount: 3,
    successCount: 3,
    failureCount: 0,
    nextRunAt: new Date("2030-01-01T09:00:00Z"),
    lastRunAt: new Date("2029-01-01T09:00:00Z"),
    createdAt: new Date("2029-01-01T00:00:00Z"),
    updatedAt: new Date("2029-06-01T00:00:00Z"),
    ...overrides,
  }
}

function loadedTask(overrides: Partial<ScheduledTask> = {}): LoadedScheduledTask {
  const t = task(overrides)
  return { kind: "scheduled-task", id: t.id, label: t.name, localStatus: t.status, task: t }
}

function connectorRow(overrides: Partial<AdapterInstanceRow> = {}): AdapterInstanceRow {
  return {
    id: "cai_1",
    type: "telegram",
    displayName: "Family bot",
    enabled: true,
    transportMode: "longpoll",
    settings: {},
    credentialsRef: {
      keyringService: "com.cognia.platforms",
      accounts: ["botToken", "webhookSecret"],
    },
    trigger: { rules: [], blockers: [], storeUnmatchedInDraftMode: false },
    defaultMode: "auto",
    mediaModelPolicy: "local_extract_only",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  } as AdapterInstanceRow
}

function loadedConnector(
  overrides: Partial<AdapterInstanceRow> = {},
  schedules: ScheduledTask[] = []
): LoadedConnectorInstance {
  const row = connectorRow(overrides)
  return {
    kind: "connector-instance",
    id: row.id,
    label: row.displayName,
    localStatus: row.enabled ? "enabled" : "disabled",
    row,
    schedules,
  }
}

function digest(id: string, overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return task({
    id,
    name: `Digest ${id}`,
    type: "connection:scheduled:digest",
    payload: {
      adapterId: "cai_1",
      conversationKey: "telegram:cai_1:42",
      characterId: "c-1",
      prompt: "x",
    },
    ...overrides,
  })
}

function botRow(overrides: Partial<BotInstallationRow> = {}): BotInstallationRow {
  return {
    id: "boti_local",
    definitionId: "acme:digest",
    definitionSource: "plugin",
    pinnedVersion: "1.0.0",
    scope: { kind: "account" },
    status: "enabled",
    config: { repository: "owner/repo" },
    credentialBindings: { chat: { adapterId: "cai_1" } },
    triggerOverrides: { nightly: false },
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function loadedBot(
  overrides: Partial<BotInstallationRow> = {},
  withEntry = true
): LoadedBotInstallation {
  const installation = botRow(overrides)
  return {
    kind: "bot-installation",
    id: installation.id,
    label: "Digest",
    localStatus: installation.status,
    installation,
    ...(withEntry
      ? {
          entry: {
            definitionId: "acme:digest",
            source: "plugin",
            name: "Digest",
            version: "1.0.0",
            executor: "handler",
            triggers: [{ id: "nightly", kind: "schedule", cron: "0 9 * * *" }],
            requiredSlots: [],
            slots: [],
            pluginId: "acme",
            installedCount: 1,
          } as never,
        }
      : {}),
  }
}

function fakeTransport(answers: Record<string, (args: Record<string, unknown>) => unknown> = {}) {
  const call = jest.fn(async (name: string, args: Record<string, unknown> = {}) => {
    const answer = answers[name]
    return answer ? answer(args) : null
  })
  return call
}

function context(call: jest.Mock): TransferContext {
  return { transport: { call } as never, adminLease: "lease", operationId: OP, sourceLabel: "Mac" }
}

function facts(overrides: Partial<HostFacts> = {}): HostFacts {
  return {
    manifest: async () => null,
    ids: async () => new Set(),
    plugins: async () => new Map(),
    botCatalog: async () => new Map(),
    botCredentialIds: async () => new Set(),
    externalAgentIds: async () => new Set(),
    hasScheduledTask: async () => false,
    ...overrides,
  }
}

beforeEach(async () => {
  __resetDbForTesting()
  const db = getDb()
  await Promise.all([
    db.plugins.clear(),
    db.mcpServers.clear(),
    db.projects.clear(),
    db.adapterInstances.clear(),
  ])
  mockKeyringGet.mockReset().mockResolvedValue(null)
  mockSetTaskOwner.mockClear()
}, 15_000)

describe("remoteItemIdFor", () => {
  it("keeps task and connector ids, and keys a Bot installation by the operation", () => {
    expect(remoteItemIdFor(loadedTask(), OP)).toBe("task-1")
    expect(remoteItemIdFor(loadedConnector(), OP)).toBe("cai_1")
    expect(remoteItemIdFor(loadedBot(), OP)).toBe(`boti_${OP}`)
  })
})

describe("portableScheduledTask", () => {
  it("leaves this machine's timer, owner and run times behind, with dates as strings", () => {
    const portable = portableScheduledTask(
      task({
        promotion: { systemTaskId: "s", token: "t", promotedAt: new Date(0) },
        owner: { kind: "this-device", reason: "manual", pinnedAt: 1 },
        endAt: new Date("2031-01-01T00:00:00Z"),
      }),
      "paused"
    )
    expect(portable).toMatchObject({
      id: "task-1",
      status: "paused",
      trigger: { type: "once", runAt: "2030-01-01T09:00:00.000Z" },
      endAt: "2031-01-01T00:00:00.000Z",
      createdAt: "2029-01-01T00:00:00.000Z",
    })
    for (const field of ["promotion", "owner", "provenance", "nextRunAt", "lastRunAt"]) {
      expect(portable).not.toHaveProperty(field)
    }
  })
})

describe("createOnHost", () => {
  it("imports a running task paused, so nothing fires before this copy is fenced", async () => {
    const call = fakeTransport({
      scheduled_task_import: () => ({ imported: 1, skipped: 0, errors: [] }),
    })
    await createOnHost(loadedTask(), context(call))
    const [name, args] = call.mock.calls[0]!
    expect(name).toBe("scheduled_task_import")
    expect(args).toMatchObject({
      mode: "merge",
      adminLease: "lease",
      provenance: { kind: "migration", operationId: OP, sourceLabel: "Mac" },
      data: { version: 1, tasks: [expect.objectContaining({ id: "task-1", status: "paused" })] },
    })
  })

  it("treats its own earlier import as a replay and anyone else's as a conflict", async () => {
    const ours = fakeTransport({
      scheduled_task_import: () => ({ imported: 0, skipped: 1, errors: [] }),
      scheduled_task_get: () => ({ id: "task-1", provenance: { operationId: OP } }),
    })
    await expect(createOnHost(loadedTask(), context(ours))).resolves.toBeUndefined()
    const theirs = fakeTransport({
      scheduled_task_import: () => ({ imported: 0, skipped: 1, errors: [] }),
      scheduled_task_get: () => ({ id: "task-1", provenance: { operationId: "other" } }),
    })
    await expect(createOnHost(loadedTask(), context(theirs))).rejects.toThrow(/item_id_conflict/)
    const refused = fakeTransport({
      scheduled_task_import: () => ({ imported: 0, skipped: 1, errors: ['Skipped "x": nope'] }),
    })
    await expect(createOnHost(loadedTask(), context(refused))).rejects.toThrow('Skipped "x": nope')
  })

  it("sends a connector switched off, then each stored secret to the host's keychain", async () => {
    mockKeyringGet.mockImplementation(async (_id, name) => (name === "botToken" ? "s3cret" : null))
    const call = fakeTransport()
    await createOnHost(loadedConnector(), context(call))
    expect(call.mock.calls.map(([name]) => name)).toEqual([
      "adapter_instance_mutate",
      "connectors_keyring_set",
    ])
    expect(call.mock.calls[0]![1]).toMatchObject({
      operation: "create",
      operationId: OP,
      id: "cai_1",
      instance: { enabled: false, type: "telegram" },
      adminLease: "lease",
    })
    expect(call.mock.calls[1]![1]).toEqual({
      adapterId: "cai_1",
      credential: "botToken",
      value: "s3cret",
      adminLease: "lease",
    })
  })

  it("installs a Bot switched off, in one operation, with only a complete grant", async () => {
    const call = fakeTransport()
    await createOnHost(
      loadedBot({ policyGrant: { maxAuthority: "acceptEdits" } as never }),
      context(call)
    )
    expect(call).toHaveBeenCalledWith(
      "bot_installation_mutate",
      expect.objectContaining({
        operation: "install",
        operationId: OP,
        definitionId: "acme:digest",
        enabled: false,
        triggerOverrides: { nightly: false },
        credentialBindings: { chat: { adapterId: "cai_1" } },
        // Interactive on the host since ADR-0224 A6.
        adminLease: "lease",
      })
    )
    expect(call.mock.calls[0]![1]).not.toHaveProperty("policyGrant")
    await expect(createOnHost(loadedBot({}, false), context(call))).rejects.toThrow(
      /bot_definition_missing/
    )
  })
})

describe("armOnHost", () => {
  it("starts the host's copy only when it ran here", async () => {
    const call = fakeTransport()
    await armOnHost({ kind: "scheduled-task", localStatus: "active" }, "task-1", context(call))
    await armOnHost({ kind: "scheduled-task", localStatus: "paused" }, "task-1", context(call))
    await armOnHost(
      { kind: "bot-installation", localStatus: "needs_setup" },
      "boti_x",
      context(call)
    )
    await armOnHost({ kind: "bot-installation", localStatus: "disabled" }, "boti_x", context(call))
    await armOnHost({ kind: "connector-instance", localStatus: "enabled" }, "cai_1", context(call))
    await armOnHost({ kind: "connector-instance", localStatus: "disabled" }, "cai_1", context(call))
    expect(
      call.mock.calls.map(([name, args]) => [name, (args as { operation?: string }).operation])
    ).toEqual([
      ["scheduled_task_resume", undefined],
      ["bot_installation_mutate", "set_enabled"],
      ["adapter_instance_mutate", "configure"],
    ])
    expect(call.mock.calls[1]![1]).toMatchObject({ adminLease: "lease" })
  })
})

describe("removeFromHost and remoteStatus", () => {
  it("removes each kind through its own command", async () => {
    const call = fakeTransport()
    const ctx = { transport: { call } as never, adminLease: "lease", operationId: OP }
    await removeFromHost("scheduled-task", "task-1", ctx)
    await removeFromHost("bot-installation", "boti_x", ctx)
    await removeFromHost("connector-instance", "cai_1", ctx)
    expect(call.mock.calls.map(([name]) => name)).toEqual([
      "scheduled_task_delete",
      "bot_installation_mutate",
      "adapter_instance_mutate",
    ])
    expect(call.mock.calls[0]![1]).toEqual({ taskId: "task-1", adminLease: "lease" })
    expect(call.mock.calls[1]![1]).toMatchObject({
      operation: "uninstall",
      installationId: "boti_x",
      adminLease: "lease",
    })
    expect(call.mock.calls[2]![1]).toMatchObject({
      operation: "remove",
      id: "cai_1",
      adminLease: "lease",
    })
  })

  it("reads the host's status in this machine's vocabulary, null when gone", async () => {
    const call = fakeTransport({
      scheduled_task_get: (args) => (args.taskId === "task-1" ? { status: "paused" } : null),
      bot_console_read: () => ({ rows: [{ id: "boti_x", status: "needs_setup" }] }),
      sync_pull: () => ({ rows: [{ id: "cai_1", enabled: true }] }),
    })
    const transport = { call } as never
    expect(await remoteStatus("scheduled-task", "task-1", transport)).toBe("paused")
    expect(await remoteStatus("scheduled-task", "task-2", transport)).toBeNull()
    expect(await remoteStatus("bot-installation", "boti_x", transport)).toBe("needs_setup")
    expect(await remoteStatus("bot-installation", "boti_y", transport)).toBeNull()
    expect(await remoteStatus("connector-instance", "cai_1", transport)).toBe("enabled")
    expect(await remoteStatus("connector-instance", "cai_2", transport)).toBeNull()
  })
})

describe("checkItem", () => {
  it("lists everything a task names that the host lacks", async () => {
    const checks = await checkItem(
      loadedTask({
        type: "agent",
        projectId: "p-1",
        payload: { prompt: "x", characterId: "c-1", sessionId: "s-1", mcpServerIds: ["mcp-1"] },
      }),
      facts({ ids: async (table) => new Set(table === "characters" ? ["c-1"] : []) }),
      "headless",
      false
    )
    expect(checks.blockers).toEqual([
      { kind: "reference-missing", reference: "conversation", id: "s-1" },
      { kind: "reference-missing", reference: "mcp-server", id: "mcp-1" },
      { kind: "reference-missing", reference: "workspace", id: "p-1" },
    ])
  })

  it("flags an id the host already uses, unless this is the same move resuming", async () => {
    const hostHasIt = facts({ hasScheduledTask: async () => true })
    expect((await checkItem(loadedTask(), hostHasIt, "headless", false)).blockers).toEqual([
      { kind: "id-conflict", id: "task-1" },
    ])
    expect((await checkItem(loadedTask(), hostHasIt, "headless", true)).blockers).toEqual([])
  })

  it("asks for a plugin task's plugin at this machine's version", async () => {
    await getDb().plugins.put({ id: "acme", version: "2.0.0" } as never)
    const checks = await checkItem(
      loadedTask({ type: "plugin", payload: { pluginId: "acme", handler: "sweep" } }),
      facts({ plugins: async () => new Map([["acme", "1.0.0"]]) }),
      "headless",
      false
    )
    expect(checks.plugins).toEqual([{ pluginId: "acme", version: "2.0.0" }])
    expect(checks.blockers).toContainEqual({
      kind: "plugin-version-mismatch",
      pluginId: "acme",
      version: "2.0.0",
      hostVersion: "1.0.0",
    })
  })

  it("makes an IM push wait for its connector, and says the chat address is relearned", async () => {
    await getDb().adapterInstances.put(connectorRow({ id: "cai_tg" }))
    const checks = await checkItem(
      loadedTask({
        type: "im-push",
        payload: { conversationKey: "telegram:cai_tg:42", text: "hi" },
      }),
      facts(),
      "headless",
      false
    )
    expect(checks.blockers).toContainEqual({
      kind: "depends-on",
      item: { kind: "connector-instance", id: "cai_tg" },
      label: "Family bot",
    })
    expect(checks.notes).toEqual([
      { kind: "conversation-address-relearned", conversationKey: "telegram:cai_tg:42" },
    ])
  })

  it("asks for a plugin Bot's plugin rather than its definition, and checks its bindings", async () => {
    await getDb().plugins.put({ id: "acme", version: "1.0.0" } as never)
    await getDb().adapterInstances.put(connectorRow())
    const checks = await checkItem(
      loadedBot({
        credentialBindings: { chat: { adapterId: "cai_1" }, gh: { integrationAccountId: "acct" } },
      }),
      facts(),
      "headless",
      false
    )
    expect(checks.blockers).toEqual([
      {
        kind: "depends-on",
        item: { kind: "connector-instance", id: "cai_1" },
        label: "Family bot",
      },
      { kind: "reference-missing", reference: "integration-account", id: "acct" },
      { kind: "plugin-missing", pluginId: "acme", version: "1.0.0" },
    ])
  })

  it("reports a definition authored here that the host lacks", async () => {
    const checks = await checkItem(
      { ...loadedBot({ definitionSource: "local", credentialBindings: {} }), entry: undefined },
      facts(),
      "headless",
      false
    )
    expect(checks.blockers).toEqual([
      { kind: "bot-definition-missing", definitionId: "acme:digest", version: "1.0.0" },
    ])
  })

  it("carries a connector's stored secrets and reports one this machine cannot read", async () => {
    mockKeyringGet.mockImplementation(async (_id, name) => {
      if (name === "botToken") return "s3cret"
      throw new Error("keychain locked")
    })
    const checks = await checkItem(
      loadedConnector(),
      facts({ ids: async (table) => new Set(table === "adapterInstances" ? ["cai_1"] : []) }),
      "headless",
      false
    )
    expect(checks.blockers).toEqual([
      { kind: "id-conflict", id: "cai_1" },
      { kind: "secret-unreadable", name: "webhookSecret" },
    ])
    expect(checks.notes).toEqual([{ kind: "secret-transferred", name: "botToken" }])
  })
})

describe("setLocalOwner", () => {
  it("writes a task's owner through the scheduler, with the status to restore", async () => {
    await setLocalOwner("scheduled-task", "task-1", undefined, "active")
    expect(mockSetTaskOwner).toHaveBeenCalledWith("task-1", undefined, { status: "active" })
  })

  it("fences a connector and reports one that vanished", async () => {
    await getDb().adapterInstances.put(connectorRow())
    await setLocalOwner("connector-instance", "cai_1", {
      kind: "remote-host",
      hostId: "mini",
      hostLabel: "Mac mini",
      remoteItemId: "cai_1",
      operationId: OP,
      movedAt: 1,
    })
    expect(await getDb().adapterInstances.get("cai_1")).toMatchObject({ enabled: false })
    await expect(setLocalOwner("connector-instance", "cai_gone", undefined)).rejects.toThrow(
      /item_missing/
    )
  })
})

describe("a connector's chat schedules", () => {
  it("travel with the connector they send through, when they run here", () => {
    const moved = {
      kind: "remote-host" as const,
      hostId: "h",
      hostLabel: "Mac mini",
      remoteItemId: "d3",
      operationId: OP,
      movedAt: 1,
    }
    const tasks = [
      digest("d1"),
      digest("d2", { payload: { adapterId: "cai_other" } }),
      digest("d3", { owner: moved }),
      task({ id: "t1", payload: { adapterId: "cai_1" } }),
    ]
    expect(connectorSchedules(tasks, "cai_1").map((t) => t.id)).toEqual(["d1"])
    expect(companionsOf(loadedConnector({}, [digest("d1", { status: "paused" })]))).toEqual([
      { kind: "scheduled-task", id: "d1", label: "Digest d1", localStatus: "paused" },
    ])
    expect(companionsOf(loadedTask())).toEqual([])
  })

  it("are checked against the host along with the connector", async () => {
    const checks = await checkItem(
      loadedConnector({ credentialsRef: undefined }, [digest("d1"), digest("d2")]),
      facts({ hasScheduledTask: async (id) => id === "d2" }),
      "headless",
      false
    )
    expect(checks.notes).toContainEqual({ kind: "schedules-travel", count: 2 })
    expect(checks.blockers).toEqual([
      { kind: "reference-missing", reference: "character", id: "c-1" },
      { kind: "reference-missing", reference: "character", id: "c-1" },
      { kind: "id-conflict", id: "d2" },
    ])
  })

  it("are created paused, fenced, armed and removed one by one", async () => {
    mockGetTask.mockImplementation(async (id) => (id === "d1" ? digest("d1") : undefined))
    const call = fakeTransport({
      scheduled_task_import: () => ({ imported: 1 }),
      scheduled_task_get: (args) => (args.taskId === "d1" ? { status: "paused" } : null),
    })
    const companion = {
      kind: "scheduled-task" as const,
      id: "d1",
      label: "Digest d1",
      localStatus: "active",
    }
    await createCompanionOnHost(companion, context(call))
    // Deleted here since the move started: left behind, not an error.
    await createCompanionOnHost({ ...companion, id: "gone" }, context(call))
    const imported = call.mock.calls.filter(([name]) => name === "scheduled_task_import")
    expect(imported).toHaveLength(1)
    expect(
      (imported[0]![1] as { data: { tasks: Array<{ status: string }> } }).data.tasks[0]!.status
    ).toBe("paused")

    await setCompanionOwner(companion, undefined, "paused")
    expect(mockSetTaskOwner).toHaveBeenCalledWith("d1", undefined, { status: "paused" })

    call.mockClear()
    await armCompanionOnHost(companion, context(call))
    await armCompanionOnHost({ ...companion, localStatus: "paused" }, context(call))
    expect(call.mock.calls.map(([name]) => name)).toEqual([
      "scheduled_task_get",
      "scheduled_task_resume",
    ])

    call.mockClear()
    expect(await removeCompanionFromHost(companion, context(call))).toBe("paused")
    expect(await removeCompanionFromHost({ ...companion, id: "d9" }, context(call))).toBeNull()
    expect(call.mock.calls.filter(([name]) => name === "scheduled_task_delete")).toHaveLength(1)
  })
})
