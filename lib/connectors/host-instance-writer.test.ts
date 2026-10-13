import type { AdapterInstanceRow } from "@/lib/db/connector-types"

import {
  ADAPTER_INSTANCE_MUTATE,
  HostConnectorWriteRefusedError,
  createHostAdapterInstanceWriter,
  type HostAdapterInstanceWriterDeps,
} from "./host-instance-writer"

const row = {
  id: "lark-1",
  type: "lark",
  displayName: "Feishu bot",
  enabled: true,
  transportMode: "gateway",
  settings: { transport: "long-connection" },
  credentialsRef: { keyringService: "com.cognia.platforms", accounts: ["appId", "appSecret"] },
  trigger: { kind: "private-chat" },
  defaultMode: "auto",
  mediaModelPolicy: "local_extract_only",
  createdAt: 1,
  updatedAt: 1,
  lastWhoamiAt: 99,
} as unknown as AdapterInstanceRow

function setup(overrides: Partial<HostAdapterInstanceWriterDeps> = {}) {
  let n = 0
  const call = jest.fn(async (_command: string, args: Record<string, unknown>) =>
    args.operation === "create" ? { id: args.id, type: "lark", createdAt: 5, updatedAt: 5 } : {}
  )
  const markStarted = jest.fn(async () => undefined)
  const writer = createHostAdapterInstanceWriter({
    applies: () => true,
    call: call as unknown as HostAdapterInstanceWriterDeps["call"],
    ensureLease: async () => "held",
    leaseToken: () => "lease-1",
    consentCode: () => null,
    newOperationId: () => `op-${++n}`,
    markStarted,
    ...overrides,
  })
  return { writer, call, markStarted }
}

describe("createHostAdapterInstanceWriter", () => {
  it("creates the instance on the Host stopped, and starts it once its credentials are in", async () => {
    const { writer, call, markStarted } = setup()
    const stored = await writer.create(row)

    expect(call).toHaveBeenCalledWith(ADAPTER_INSTANCE_MUTATE, {
      operation: "create",
      id: "lark-1",
      operationId: "op-1",
      adminLease: "lease-1",
      instance: expect.objectContaining({ type: "lark", enabled: false, transportMode: "gateway" }),
    })
    const instance = (call.mock.calls[0][1] as { instance: Record<string, unknown> }).instance
    // Runtime state and identity stay behind, and so does what the create's
    // contract does not admit: it follows as a configure.
    expect(instance).not.toHaveProperty("lastWhoamiAt")
    expect(instance).not.toHaveProperty("id")
    expect(instance).not.toHaveProperty("mediaModelPolicy")
    expect(call).toHaveBeenNthCalledWith(2, ADAPTER_INSTANCE_MUTATE, {
      operation: "configure",
      id: "lark-1",
      patch: { mediaModelPolicy: "local_extract_only" },
      operationId: "op-2",
      adminLease: "lease-1",
    })
    expect(stored).toMatchObject({ id: "lark-1", enabled: false, createdAt: 5 })
    expect([...writer.pendingStarts()]).toEqual(["lark-1"])

    await writer.completeCreate("lark-1")
    expect(call).toHaveBeenLastCalledWith(ADAPTER_INSTANCE_MUTATE, {
      operation: "configure",
      id: "lark-1",
      patch: { enabled: true },
      operationId: "op-3",
      adminLease: "lease-1",
    })
    expect(markStarted).toHaveBeenCalledWith("lark-1")
    expect(writer.pendingStarts().size).toBe(0)

    // Nothing pending: completing again sends nothing.
    await writer.completeCreate("lark-1")
    expect(call).toHaveBeenCalledTimes(3)
  })

  it("never starts an instance the form created disabled", async () => {
    const { writer, call } = setup()
    await writer.create({ ...row, enabled: false })
    await writer.completeCreate("lark-1")
    // The create and the remainder's configure; no start.
    expect(call).toHaveBeenCalledTimes(2)
  })

  it("sends only portable fields, and holds a pending start back until the credentials land", async () => {
    const { writer, call } = setup()
    await writer.configure("lark-1", { lastWhoamiAt: 3 } as never)
    expect(call).not.toHaveBeenCalled()

    await writer.configure("lark-1", { displayName: "Renamed", muted: true })
    expect(call).toHaveBeenLastCalledWith(
      ADAPTER_INSTANCE_MUTATE,
      expect.objectContaining({
        operation: "configure",
        id: "lark-1",
        patch: { displayName: "Renamed", muted: true },
      })
    )

    await writer.create(row)
    call.mockClear()
    await writer.configure("lark-1", { enabled: true })
    expect(call).not.toHaveBeenCalled()
    await writer.configure("lark-1", { enabled: true, displayName: "X" })
    expect(call).toHaveBeenCalledWith(
      ADAPTER_INSTANCE_MUTATE,
      expect.objectContaining({ patch: { displayName: "X" } })
    )
  })

  it("removes on the Host and forgets a pending start", async () => {
    const { writer, call } = setup()
    await writer.create(row)
    await writer.remove("lark-1")
    expect(call).toHaveBeenLastCalledWith(
      ADAPTER_INSTANCE_MUTATE,
      expect.objectContaining({ operation: "remove", id: "lark-1" })
    )
    expect(writer.pendingStarts().size).toBe(0)
  })

  it("refuses without a lease, naming the approval the Host is waiting on", async () => {
    const { writer, call } = setup({
      ensureLease: async () => "unavailable",
      leaseToken: () => null,
      consentCode: () => "K7Q2",
    })
    const refusal = writer.create(row)
    await expect(refusal).rejects.toBeInstanceOf(HostConnectorWriteRefusedError)
    await expect(refusal).rejects.toThrow(/K7Q2/)
    expect(call).not.toHaveBeenCalled()

    const flat = setup({ ensureLease: async () => "unavailable", leaseToken: () => null })
    await expect(flat.writer.remove("lark-1")).rejects.toThrow(/did not allow/)
  })

  it("applies where the connector keychain is the Host's", () => {
    expect(setup({ applies: () => false }).writer.applies()).toBe(false)
    expect(setup().writer.applies()).toBe(true)
  })
})
