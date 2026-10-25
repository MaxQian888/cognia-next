/**
 * @jest-environment jsdom
 */

import {
  createAdapterInstance,
  getAdapterInstance,
  setAdapterInstanceOwner,
  type AdapterInstanceInput,
} from "@/lib/db/adapter-instances"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"

import requestSchemas from "@/protocol/companion-request-schemas.json"

import {
  instanceCreatePayload,
  LOCAL_ADAPTER_FIELDS,
  mutateAdapterInstanceOnHost,
  PORTABLE_ADAPTER_FIELDS,
  portableAdapterInstance,
  projectAdapterInstanceForDevice,
} from "./instance-transfer"

const mockKeyringDelete = jest.fn(async (_id: string, _credential: string) => undefined)
jest.mock("@/lib/connectors/tauri/commands", () => ({
  connectorsKeyringDelete: (id: string, credential: string) => mockKeyringDelete(id, credential),
}))

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

const OPERATION = "123e4567-e89b-42d3-a456-426614174000"
const OTHER_OPERATION = "123e4567-e89b-42d3-a456-426614174001"

function localRow(overrides: Partial<AdapterInstanceRow> = {}): AdapterInstanceRow {
  return {
    id: "cai_laptop",
    type: "telegram",
    displayName: "Family bot",
    enabled: true,
    transportMode: "longpoll",
    settings: { allowGroups: true },
    credentialsRef: { keyringService: "com.cognia.platforms", accounts: ["botToken"] },
    trigger: {
      rules: [{ kind: "private-default" }],
      blockers: [],
      storeUnmatchedInDraftMode: true,
    },
    defaultMode: "auto",
    mediaModelPolicy: "local_extract_only",
    publicUrl: "https://laptop.example",
    lastWhoamiAt: 5,
    implMetadata: { version: "x" } as never,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  } as AdapterInstanceRow
}

describe("portableAdapterInstance", () => {
  it("sends configuration and leaves this machine's address and runtime state behind", () => {
    const portable = portableAdapterInstance(localRow())
    expect(portable).toMatchObject({
      type: "telegram",
      displayName: "Family bot",
      settings: { allowGroups: true },
      credentialsRef: { keyringService: "com.cognia.platforms", accounts: ["botToken"] },
    })
    expect(portable).not.toHaveProperty("publicUrl")
    expect(portable).not.toHaveProperty("lastWhoamiAt")
    expect(portable).not.toHaveProperty("implMetadata")
    expect(portable).not.toHaveProperty("id")
  })

  it("classifies every field exactly once", () => {
    const portable = new Set<string>(PORTABLE_ADAPTER_FIELDS)
    for (const field of LOCAL_ADAPTER_FIELDS) expect(portable.has(field)).toBe(false)
  })
})

describe("instanceCreatePayload", () => {
  const contract = (
    requestSchemas as unknown as {
      commands: Record<
        string,
        { properties: { instance: { properties: Record<string, unknown>; required: string[] } } }
      >
    }
  ).commands.adapter_instance_mutate.properties.instance

  it("creates with exactly what the wire contract admits, and configures the rest", () => {
    const { instance, remainder } = instanceCreatePayload(
      localRow({ muted: true, defaultModel: "deepseek-v4-flash" }),
      { enabled: false }
    )
    expect(Object.keys(instance).sort()).toEqual(Object.keys(contract.properties).sort())
    for (const field of contract.required) expect(instance).toHaveProperty(field)
    expect(instance).toMatchObject({ type: "telegram", enabled: false, transportMode: "longpoll" })
    expect(remainder).toEqual({
      mediaModelPolicy: "local_extract_only",
      muted: true,
      defaultModel: "deepseek-v4-flash",
    })
    // Runtime state and this machine's address go nowhere.
    expect(remainder).not.toHaveProperty("publicUrl")
    expect(remainder).not.toHaveProperty("lastWhoamiAt")
  })

  it("fills the open objects a sparse row leaves out, and has no remainder when there is none", () => {
    const sparse = localRow({
      mediaModelPolicy: undefined,
      settings: undefined,
      trigger: undefined,
    })
    const { instance, remainder } = instanceCreatePayload(sparse)
    expect(instance).toMatchObject({ settings: {}, trigger: {}, enabled: true })
    expect(remainder).toBeNull()
  })
})

describe("mutateAdapterInstanceOnHost", () => {
  const create = (overrides: Record<string, unknown> = {}) => ({
    operation: "create",
    operationId: OPERATION,
    id: "cai_laptop",
    instance: portableAdapterInstance(localRow()),
    sourceLabel: "Work laptop",
    adminLease: "lease-token",
    ...overrides,
  })

  it("creates the instance under the id it had, so keychain entries still address it", async () => {
    const created = await mutateAdapterInstanceOnHost(create())
    expect(created).toMatchObject({ id: "cai_laptop", type: "telegram", enabled: true })
    const row = await getAdapterInstance("cai_laptop")
    expect(row).toMatchObject({
      displayName: "Family bot",
      provenance: { kind: "migration", operationId: OPERATION, sourceLabel: "Work laptop" },
    })
    expect(row?.publicUrl).toBeUndefined()
  })

  it("answers a replay with the row it created, and refuses a different instance under that id", async () => {
    const first = await mutateAdapterInstanceOnHost(create())
    expect(await mutateAdapterInstanceOnHost(create())).toEqual(first)
    expect(await getDb().adapterInstances.count()).toBe(1)
    await expect(
      mutateAdapterInstanceOnHost(create({ operationId: OTHER_OPERATION }))
    ).rejects.toThrow(/adapter_instance_exists/)
  })

  it("refuses a connector type this host cannot build", async () => {
    await expect(
      mutateAdapterInstanceOnHost(
        create({ instance: { ...portableAdapterInstance(localRow()), type: "acme-chat" } })
      )
    ).rejects.toThrow(/adapter_type_unavailable: "acme-chat" is not a connector/)
    await expect(
      mutateAdapterInstanceOnHost(
        create({
          instance: {
            ...portableAdapterInstance(localRow()),
            type: "acme-chat",
            plugin: { pluginId: "acme", contributionId: "chat", pluginRelease: "1.0.0" },
          },
        })
      )
    ).rejects.toThrow(/plugin acme, which is not installed on this host/)
  })

  it("rejects a malformed or partial request before writing anything", async () => {
    await expect(
      mutateAdapterInstanceOnHost(create({ instance: { type: "telegram" } }))
    ).rejects.toThrow()
    await expect(mutateAdapterInstanceOnHost(create({ operationId: "nope" }))).rejects.toThrow()
    await expect(mutateAdapterInstanceOnHost({ ...create(), extra: 1 })).rejects.toThrow()
    expect(await getDb().adapterInstances.count()).toBe(0)
  })

  it("configures an instance this host runs, and leaves an audit breadcrumb", async () => {
    const row = await createAdapterInstance(
      portableAdapterInstance(localRow()) as unknown as AdapterInstanceInput
    )
    const configured = await mutateAdapterInstanceOnHost({
      operation: "configure",
      operationId: OPERATION,
      id: row.id,
      patch: { transportMode: "gateway", displayName: "Renamed", publicUrl: "https://x" },
    })
    expect(configured).toMatchObject({ transportMode: "gateway", displayName: "Renamed" })
    expect((await getAdapterInstance(row.id))?.publicUrl).toBeUndefined()
    const audit = await getDb().connectorAudit.where("adapterId").equals(row.id).toArray()
    expect(audit.at(-1)?.fields).toMatchObject({ source: "paired-device" })
  })

  // ADR-0239: a paired device's edit of the recipient list, under its lease.
  it("configures the recipient list through its validated writer", async () => {
    const row = await createAdapterInstance(
      portableAdapterInstance(localRow()) as unknown as AdapterInstanceInput
    )
    const grant = {
      recipient: { kind: "person", channel: row.id, recipient: `person:${row.id}:u1` },
      addedAt: 1,
      addedBy: "local-user",
    }
    const configured = await mutateAdapterInstanceOnHost({
      operation: "configure",
      operationId: OPERATION,
      id: row.id,
      patch: { outboundRecipients: [grant] },
    })
    expect(configured).toMatchObject({ outboundRecipients: [grant] })
    const audit = await getDb().connectorAudit.where("adapterId").equals(row.id).toArray()
    expect(audit.at(-1)?.fields).toMatchObject({
      section: "outboundRecipients",
      source: "paired-device",
    })
    await expect(
      mutateAdapterInstanceOnHost({
        operation: "configure",
        operationId: OPERATION,
        id: row.id,
        patch: { outboundRecipients: [{ ...grant, addedBy: "agent" }] },
      })
    ).rejects.toThrow("Invalid outbound recipients")
  })

  it("refuses to configure a missing instance or a placeholder", async () => {
    await expect(
      mutateAdapterInstanceOnHost({
        operation: "configure",
        operationId: OPERATION,
        id: "cai_missing",
        patch: {},
      })
    ).rejects.toThrow(/adapter_instance_missing/)
    const row = await createAdapterInstance(
      portableAdapterInstance(localRow()) as unknown as AdapterInstanceInput
    )
    await setAdapterInstanceOwner(row.id, {
      kind: "remote-host",
      hostId: "mini",
      hostLabel: "Mac mini",
      remoteItemId: row.id,
      operationId: OPERATION,
      movedAt: 1,
    })
    await expect(
      mutateAdapterInstanceOnHost({
        operation: "configure",
        operationId: OPERATION,
        id: row.id,
        patch: { muted: true },
      })
    ).rejects.toThrow(/item_owned_elsewhere/)
  })
})

describe("removing a moved instance (take-back)", () => {
  it("deletes the row and its keychain entries, and answers a repeat as done", async () => {
    await mutateAdapterInstanceOnHost({
      operation: "create",
      operationId: OPERATION,
      id: "cai_laptop",
      instance: portableAdapterInstance(localRow()),
    })
    mockKeyringDelete.mockClear()
    const remove = { operation: "remove", operationId: OTHER_OPERATION, id: "cai_laptop" }
    await expect(mutateAdapterInstanceOnHost(remove)).resolves.toEqual({
      id: "cai_laptop",
      removed: true,
    })
    expect(await getAdapterInstance("cai_laptop")).toBeUndefined()
    expect(mockKeyringDelete).toHaveBeenCalledWith("cai_laptop", "botToken")
    await expect(mutateAdapterInstanceOnHost(remove)).resolves.toEqual({
      id: "cai_laptop",
      removed: true,
    })
  })
})

describe("projectAdapterInstanceForDevice", () => {
  it("never includes a secret value or runtime state", () => {
    const projected = projectAdapterInstanceForDevice(localRow())
    expect(projected).toMatchObject({ id: "cai_laptop", createdAt: 1, updatedAt: 2 })
    expect(projected).not.toHaveProperty("lastWhoamiAt")
    expect(JSON.stringify(projected)).not.toContain("laptop.example")
  })
})
