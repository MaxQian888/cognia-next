const mockCall = jest.fn()
jest.mock("@/lib/tauri", () => ({
  transport: { call: (...args: unknown[]) => mockCall(...args) },
}))

import {
  acquireHostTaskLease,
  HOST_TASK_LEASE_RENEW_MS,
  hostTaskModelMetadata,
} from "./host-task-lease"

function prepared(overrides: Record<string, unknown> = {}) {
  return {
    ticketId: "rt_1",
    secret: "sk-cognia-rt-secret",
    endpoint: "http://127.0.0.1:47823/v1",
    accountGeneration: 3,
    ownerAccountId: null,
    expiresAtMs: Date.now() + 120_000,
    ...overrides,
  }
}

const input = {
  taskId: "task-1",
  providerId: "stub-openai",
  modelId: "stub-model",
  ingressProtocol: "openai-chat" as const,
  originDeviceId: "phone-a",
}

describe("acquireHostTaskLease", () => {
  beforeEach(() => {
    mockCall.mockReset()
    jest.useFakeTimers()
  })
  afterEach(() => {
    jest.useRealTimers()
  })

  it("asks cognia-server for a lease by provider id only and never sends a credential", async () => {
    mockCall.mockResolvedValueOnce(
      prepared({ modelMetadata: { id: "stub-model", contextLength: 64000 } })
    )
    const lease = await acquireHostTaskLease(input)
    expect(mockCall).toHaveBeenCalledWith("agent_gateway_host_task_prepare", {
      request: {
        taskId: "task-1",
        providerId: "stub-openai",
        model: "stub-model",
        ingressProtocol: "openai-chat",
        originDeviceId: "phone-a",
      },
    })
    expect(JSON.stringify(mockCall.mock.calls[0])).not.toMatch(/apiKey|baseUrl/)
    expect(lease).toMatchObject({
      ticketId: "rt_1",
      secret: "sk-cognia-rt-secret",
      endpoint: "http://127.0.0.1:47823/v1",
      ownerAccountId: null,
      modelMetadata: { id: "stub-model", contextLength: 64000 },
    })
    mockCall.mockResolvedValue(true)
    await lease.revoke()
  })

  it("renews on a heartbeat and revokes exactly once with the same scope", async () => {
    mockCall.mockResolvedValueOnce(prepared())
    const lease = await acquireHostTaskLease({ ...input, originDeviceId: undefined })
    mockCall.mockResolvedValue(true)
    await jest.advanceTimersByTimeAsync(HOST_TASK_LEASE_RENEW_MS)
    const control = {
      taskId: "task-1",
      ticketId: "rt_1",
      accountGeneration: 3,
      originDeviceId: null,
    }
    expect(mockCall).toHaveBeenCalledWith("agent_gateway_host_task_renew", control)
    await lease.revoke()
    await lease.revoke()
    expect(
      mockCall.mock.calls.filter(([name]) => name === "agent_gateway_host_task_revoke")
    ).toEqual([["agent_gateway_host_task_revoke", control]])
    await jest.advanceTimersByTimeAsync(HOST_TASK_LEASE_RENEW_MS * 2)
    expect(
      mockCall.mock.calls.filter(([name]) => name === "agent_gateway_host_task_renew")
    ).toHaveLength(1)
  })

  it("aborts the task when the server refuses a renewal", async () => {
    mockCall.mockResolvedValueOnce(prepared())
    const lease = await acquireHostTaskLease(input)
    mockCall.mockImplementation(async (name: string) =>
      name === "agent_gateway_host_task_renew" ? false : true
    )
    await jest.advanceTimersByTimeAsync(HOST_TASK_LEASE_RENEW_MS)
    expect(lease.signal.aborted).toBe(true)
    expect(() => lease.assertCurrent()).toThrow("Task gateway lease ended")
    expect(mockCall).toHaveBeenCalledWith(
      "agent_gateway_host_task_revoke",
      expect.objectContaining({ ticketId: "rt_1" })
    )
  })

  it("follows the caller's abort signal", async () => {
    mockCall.mockResolvedValueOnce(prepared())
    const controller = new AbortController()
    const lease = await acquireHostTaskLease({ ...input, signal: controller.signal })
    mockCall.mockResolvedValue(true)
    controller.abort()
    expect(lease.signal.aborted).toBe(true)
    expect(mockCall).toHaveBeenCalledWith(
      "agent_gateway_host_task_revoke",
      expect.objectContaining({ taskId: "task-1" })
    )
  })

  it.each([
    ["a non-loopback endpoint", { endpoint: "http://10.0.0.2:47823/v1" }],
    ["a foreign path", { endpoint: "http://127.0.0.1:47823/other" }],
    ["an empty secret", { secret: "" }],
    ["an expired lease", { expiresAtMs: Date.now() - 1 }],
    ["an over-long lease", { expiresAtMs: Date.now() + 3_600_000 }],
    ["a negative generation", { accountGeneration: -1 }],
  ])("refuses %s and revokes what it was given", async (_label, overrides) => {
    mockCall.mockResolvedValueOnce(prepared(overrides)).mockResolvedValue(true)
    await expect(acquireHostTaskLease(input)).rejects.toThrow("invalid task gateway lease")
    expect(mockCall).toHaveBeenCalledWith(
      "agent_gateway_host_task_revoke",
      expect.objectContaining({ ticketId: "rt_1" })
    )
  })

  it("does not ask for a lease once the caller has aborted", async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(acquireHostTaskLease({ ...input, signal: controller.signal })).rejects.toThrow()
    expect(mockCall).not.toHaveBeenCalled()
  })

  it("surfaces the server's refusal", async () => {
    mockCall.mockRejectedValueOnce(
      new Error("the selected provider has no usable credential on this Host")
    )
    await expect(acquireHostTaskLease(input)).rejects.toThrow("no usable credential")
  })
})

describe("hostTaskModelMetadata", () => {
  it("copies known facts by name and drops anything else", () => {
    expect(
      hostTaskModelMetadata("m", {
        id: "m",
        name: "Model",
        contextLength: 1000,
        maxOutputTokens: -1,
        supportsTools: true,
        supportsStreaming: "yes",
        apiKey: "never",
      })
    ).toEqual({ id: "m", name: "Model", contextLength: 1000, supportsTools: true })
  })

  it("falls back to the bare model id", () => {
    expect(hostTaskModelMetadata("m", undefined)).toEqual({ id: "m" })
    expect(hostTaskModelMetadata("m", { id: "other", contextLength: 5 })).toEqual({ id: "m" })
  })
})
