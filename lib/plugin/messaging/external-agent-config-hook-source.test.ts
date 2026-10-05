/** @jest-environment jsdom */
import {
  __resetExternalAgentConfigHookSourceForTesting,
  installExternalAgentConfigHookSource,
} from "./external-agent-config-hook-source"
import { useExternalAgentStore } from "@/stores/agent/external-agent-store"

const mockDispatch = jest.fn()
jest.mock("./hooks-system", () => ({
  getPluginEventHooks: () => ({
    dispatchExternalAgentConfigChange: (...args: unknown[]) => mockDispatch(...args),
  }),
}))

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  jest.clearAllMocks()
  mockDispatch.mockResolvedValue([])
  __resetExternalAgentConfigHookSourceForTesting()
  useExternalAgentStore.getState().reset()
})

it("fires onExternalAgentConfigChange for each store change", async () => {
  const dispose = installExternalAgentConfigHookSource()
  await flush()
  const id = useExternalAgentStore.getState().addAgent({
    name: "A",
    protocol: "acp",
    transport: "stdio",
    process: { command: "a" },
  })
  useExternalAgentStore.getState().setConnectionStatus(id, "connected")
  await flush()
  expect(mockDispatch.mock.calls.map(([event]) => event)).toEqual([
    { type: "config-added", agentId: id },
    { type: "connection-changed", agentId: id },
  ])
  dispose()
})

it("shares one feed between installs and stops only when the last one is released", async () => {
  const first = installExternalAgentConfigHookSource()
  const second = installExternalAgentConfigHookSource()
  await flush()
  useExternalAgentStore.getState().setEnabled(false)
  await flush()
  // Two installs, one subscription: the event is not fired twice.
  expect(mockDispatch).toHaveBeenCalledTimes(1)

  first()
  first() // releasing twice is a no-op
  useExternalAgentStore.getState().setEnabled(true)
  await flush()
  expect(mockDispatch).toHaveBeenCalledTimes(2)

  second()
  useExternalAgentStore.getState().setEnabled(false)
  await flush()
  expect(mockDispatch).toHaveBeenCalledTimes(2)
})

it("survives a rejected dispatch", async () => {
  mockDispatch.mockRejectedValueOnce(new Error("hook system down"))
  const dispose = installExternalAgentConfigHookSource()
  await flush()
  useExternalAgentStore.getState().setChatFailurePolicy("strict")
  await flush()
  useExternalAgentStore.getState().setChatFailurePolicy("fallback")
  await flush()
  expect(mockDispatch).toHaveBeenCalledTimes(2)
  dispose()
})
