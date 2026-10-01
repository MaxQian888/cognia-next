/** @jest-environment node */
import type { Transport } from "@/lib/tauri/transport-types"
const listeners = new Set<(target: Transport | null) => void>()
const target = { call: jest.fn() } as unknown as Transport
let active: Transport | null = target
jest.mock("@/lib/tauri/transport-routing", () => ({
  getActiveRemoteTransport: () => active,
  getActiveRemoteEndpoint: () => ({ deviceId: "device-a", baseUrl: "https://host.test" }),
  subscribeActiveRemoteTransport: (listener: (target: Transport | null) => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
}))
jest.mock("@/stores/remote-host/remote-host-store", () => ({
  activeHostFeatureManifest: () => ({}),
}))
jest.mock("@/lib/platform/host-feature-manifest", () => ({
  supportsHostFeatureOperation: () => true,
}))
import {
  acquireRemoteTaskLease,
  assertRemoteGatewayTask,
  captureRemoteGatewayTarget,
} from "./remote-task-lease"
const call = target.call as jest.Mock
const response = () => ({
  ticketId: "ticket-a",
  secret: "fake-task-secret",
  endpoint: "http://127.0.0.1:12345/v1",
  accountGeneration: 1,
  ownerAccountId: null,
  expiresAtMs: Date.now() + 120000,
})
const input = () => ({
  scope: captureRemoteGatewayTarget(),
  taskId: "task-a",
  provider: {
    id: "provider",
    protocol: "openai" as const,
    enabled: true,
    baseUrl: "https://api.example.com/v1",
    apiKey: "fake-selected-key",
    models: ["model-a"],
  },
  model: "model-a",
  ingressProtocol: "openai-chat",
  assertCurrent: jest.fn(),
})
beforeEach(() => {
  jest.useFakeTimers()
  active = target
  call
    .mockReset()
    .mockImplementation(async (command: string) =>
      command.endsWith("prepare") ? response() : true
    )
})
afterEach(() => {
  expect(listeners.size).toBe(0)
  jest.useRealTimers()
})
it("delegates one provider and binds spawn authorization to the exact live Host", async () => {
  const lease = await acquireRemoteTaskLease(input())
  expect(call.mock.calls[0][1].request.provider.apiKey).toBe("fake-selected-key")
  const env = {
    COGNIA_GATEWAY_TASK_CONFIG: JSON.stringify({ taskId: "task-a" }),
    COGNIA_GATEWAY_TOKEN: lease.secret,
  }
  expect(() => assertRemoteGatewayTask(env, target)).not.toThrow()
  expect(() => assertRemoteGatewayTask(env, {} as Transport)).toThrow("another Host")
  await lease.revoke()
  expect(() => assertRemoteGatewayTask(env, target)).toThrow("missing")
})
it("reserves a task while prepare is pending", async () => {
  let resolve!: (value: ReturnType<typeof response>) => void
  call.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done
      })
  )
  const pending = acquireRemoteTaskLease(input())
  await expect(acquireRemoteTaskLease(input())).rejects.toThrow("already owns")
  resolve(response())
  await (await pending).revoke()
  expect(call.mock.calls.filter(([name]) => name.endsWith("prepare"))).toHaveLength(1)
})
it("rejects Host ABA while prepare is pending and revokes on the captured Host", async () => {
  let resolve!: (value: ReturnType<typeof response>) => void
  call.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done
      })
  )
  const pending = acquireRemoteTaskLease(input())
  listeners.forEach((listener) => listener(null))
  listeners.forEach((listener) => listener(target))
  resolve(response())
  await expect(pending).rejects.toThrow("Host changed")
  expect(call).toHaveBeenLastCalledWith(
    "agent_gateway_lease_revoke",
    expect.objectContaining({ ticketId: "ticket-a" })
  )
})
it("aborts and revokes immediately on account authority invalidation", async () => {
  let invalidate!: () => void
  const dispose = jest.fn()
  const lease = await acquireRemoteTaskLease({
    ...input(),
    subscribeAuthority: (listener) => {
      invalidate = listener
      return dispose
    },
    onDisposed: dispose,
  })
  invalidate()
  expect(lease.signal.aborted).toBe(true)
  expect(call).toHaveBeenLastCalledWith("agent_gateway_lease_revoke", expect.anything())
  expect(dispose).toHaveBeenCalled()
})
it("does not overlap slow renewal calls", async () => {
  const lease = await acquireRemoteTaskLease(input())
  call.mockImplementationOnce(() => new Promise(() => {}))
  jest.advanceTimersByTime(90000)
  expect(call.mock.calls.filter(([name]) => name.endsWith("renew"))).toHaveLength(1)
  await lease.revoke()
})
it.each(["http://127.0.0.1:99/v1", "https://10.0.0.1/v1", "https://provider.local/v1"])(
  "refuses nonpublic upstream %s before credential transfer",
  async (baseUrl) => {
    const value = input()
    value.provider.baseUrl = baseUrl
    await expect(acquireRemoteTaskLease(value)).rejects.toThrow("public HTTPS")
    expect(call).not.toHaveBeenCalled()
  }
)
it.each([
  { endpoint: "http://127.0.0.1:123/v1?other=1" },
  { endpoint: "http://127.0.0.1:0/v1" },
  { accountGeneration: -1 },
  { expiresAtMs: 0 },
])("revokes malformed minted lease %j", async (override) => {
  call.mockResolvedValueOnce({ ...response(), ...override })
  await expect(acquireRemoteTaskLease(input())).rejects.toThrow("invalid task gateway lease")
  expect(call).toHaveBeenLastCalledWith("agent_gateway_lease_revoke", expect.anything())
})
