import { createLumeClient, LumeClientError, lumeFailureKind } from "./lume-client"
jest.mock("@/lib/tauri/transport-instance", () => ({ localTransport: { call: jest.fn() } }))

test("renew sends the complete frozen native session identity", async () => {
  const call = jest.fn().mockResolvedValue(undefined)
  const api = createLumeClient(call)
  const binding = {
    resourceId: "r",
    generation: 1,
    bootEpoch: "boot",
    bindingId: "binding",
    sessionId: "session",
  }
  await api.renew(binding)
  expect(call).toHaveBeenCalledWith({ kind: "renew", binding })
})

test("an unknown native contract never becomes an accepted diagnostic receipt", async () => {
  const api = createLumeClient(jest.fn().mockResolvedValue({ contractVersion: 2, resources: [] }))
  await expect(api.diagnose()).rejects.toThrow("lume_contract_unsupported")
})

test("long operations use handles and preserve the exact resource identity", async () => {
  const reference = { resourceId: "r", generation: 2, bootEpoch: "boot" }
  const call = jest
    .fn()
    .mockResolvedValueOnce({ id: "op", state: "running" })
    .mockResolvedValueOnce({ id: "op", state: "succeeded", resource: reference })
  const api = createLumeClient(call, async () => undefined)
  expect((await api.run({ kind: "stop", reference })).resource).toEqual(reference)
  expect(call.mock.calls[0][0]).toMatchObject({
    kind: "begin",
    operation: { kind: "stop", reference },
  })
  expect(call.mock.calls[1][0]).toEqual({ kind: "poll", operation_id: "op" })
})

test("cancellation sends urgent native cancellation and waits for a terminal result", async () => {
  const controller = new AbortController()
  const call = jest.fn(async (request) =>
    request.kind === "begin"
      ? { id: "op", state: "running" }
      : request.kind === "poll"
        ? { id: "op", state: "failed", errorCode: "lume_stopped" }
        : null
  )
  const api = createLumeClient(call as never, async () => {
    controller.abort()
  })
  await expect(
    api.run(
      { kind: "stop", reference: { resourceId: "r", generation: 1, bootEpoch: "b" } },
      controller.signal
    )
  ).rejects.toThrow("lume_stopped")
  expect(call).toHaveBeenCalledWith({ kind: "cancel", operation_id: "op" })
})

test("unsupported VM policy refuses before dispatch and typed files carry no command", async () => {
  const call = jest.fn().mockResolvedValue({
    id: "op",
    state: "succeeded",
    output: { result: { hash: "h" }, dataBase64: "AP+A" },
  })
  const api = createLumeClient(call)
  const binding = {
    resourceId: "r",
    generation: 1,
    bootEpoch: "b",
    bindingId: "frozen",
    sessionId: "session",
  }
  await expect(
    api.execute(binding, { argv: ["sh"], policy: { network: "off" } } as never)
  ).rejects.toThrow("lume_policy_unsupported")
  expect(call).not.toHaveBeenCalled()
  expect((await api.file(binding, { kind: "read", path: "x" })).dataBase64).toBe("AP+A")
  expect(call.mock.calls[0][0].operation).toEqual({
    kind: "file",
    binding,
    operation: { kind: "read", path: "x" },
    data_base64: "",
  })
})

test("late cancellation preserves the Host's committed adoption receipt", async () => {
  const controller = new AbortController()
  const receipt = {
    id: "adopt",
    state: "succeeded",
    stage: "finished",
    output: { status: "applied", effectCommitted: true, written: ["a"] },
  }
  const call = jest.fn(async (request) =>
    request.kind === "begin"
      ? { id: "adopt", state: "running", stage: "awaitingConsent" }
      : request.kind === "poll"
        ? receipt
        : null
  )
  const progress = jest.fn()
  const api = createLumeClient(call as never, async () => controller.abort())
  await expect(
    api.run(
      {
        kind: "adoptWorkspace",
        reference: { resourceId: "r", generation: 1, bootEpoch: "boot" },
        review_id: "review",
      },
      controller.signal,
      progress
    )
  ).resolves.toBe(receipt)
  expect(call.mock.calls.filter(([request]) => request.kind === "cancel")).toHaveLength(1)
  expect(progress.mock.calls.map(([status]) => status.stage)).toEqual([
    "awaitingConsent",
    "finished",
  ])
  expect(progress.mock.calls[1][0]).not.toHaveProperty("output")
})

test("a lost poll requests cancellation once and never replays the operation", async () => {
  const call = jest.fn(async (request) => {
    if (request.kind === "begin") return { id: "op", state: "running", stage: "queued" }
    if (request.kind === "poll") throw new Error("upstream URL with a secret")
    return null
  })
  const api = createLumeClient(call as never, async () => undefined)
  await expect(
    api.run({ kind: "stop", reference: { resourceId: "r", generation: 1, bootEpoch: "b" } })
  ).rejects.toMatchObject({ code: "lume_operation_observation_lost", operationId: "op" })
  expect(call.mock.calls.filter(([request]) => request.kind === "begin")).toHaveLength(1)
  expect(call.mock.calls.filter(([request]) => request.kind === "cancel")).toHaveLength(1)
})

test("a terminal operation is not cancelled and progress observer errors cannot hide its result", async () => {
  const controller = new AbortController()
  const receipt = { id: "done", state: "succeeded", stage: "finished", output: { exitCode: 0 } }
  const call = jest.fn(async () => {
    controller.abort()
    return receipt
  })
  const api = createLumeClient(call as never)
  await expect(
    api.run(
      { kind: "stop", reference: { resourceId: "r", generation: 1, bootEpoch: "b" } },
      controller.signal,
      () => {
        throw new Error("view unmounted")
      }
    )
  ).resolves.toBe(receipt)
  expect(call).toHaveBeenCalledTimes(1)
})

test("only stable failure codes are exposed to recovery UI", () => {
  expect(lumeFailureKind(new LumeClientError("lume_capacity_disk"))).toBe("capacity")
  expect(lumeFailureKind(new LumeClientError("lume_ssh_trust_required"))).toBe("ssh")
  expect(lumeFailureKind(new LumeClientError("lume_host_key_format"))).toBe("ssh")
  expect(lumeFailureKind(new LumeClientError("lume_clone_host_key_reused"))).toBe("ssh")
  expect(lumeFailureKind(new LumeClientError("lume_workspace_root_replaced"))).toBe("workspace")
  expect(lumeFailureKind(new LumeClientError("lume_workspace_writers_active"))).toBe("writers")
  expect(lumeFailureKind(new LumeClientError("lume_guest_file_sync"))).toBe("recovery")
  expect(lumeFailureKind(new Error("ssh stderr: private-key-material"))).toBe("unknown")
})
