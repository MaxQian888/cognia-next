/** @jest-environment node */
import { bootstrapHeadlessRuntimes } from "../bootstrap"
import { __resetHeadlessRuntimesForTesting, registerHeadlessRuntime } from "../registry"
import type { HeadlessRuntimeContext } from "../types"
import { subscribePluginToolDispatchBridge } from "@/lib/claude/plugin-tool-dispatch-bridge"

jest.mock("@/lib/claude/plugin-tool-dispatch-bridge", () => ({
  subscribePluginToolDispatchBridge: jest.fn(),
}))

it("awaits the shared bridge before connector startup and stops it before the plugin host", async () => {
  const order: string[] = []
  let installed!: (stop: () => void) => void
  let reachedBridge!: () => void
  const bridgeInstalling = new Promise<void>((resolve) => {
    reachedBridge = resolve
  })
  jest.mocked(subscribePluginToolDispatchBridge).mockImplementation(
    () =>
      new Promise((resolve) => {
        installed = resolve
        reachedBridge()
      })
  )
  __resetHeadlessRuntimesForTesting()
  registerHeadlessRuntime({
    name: "plugin-runtime",
    criticality: "required",
    hosts: ["brain"],
    start: () => {
      order.push("plugins:start")
      return () => {
        order.push("plugins:stop")
      }
    },
  })
  await import("./plugin-tool-dispatch")
  registerHeadlessRuntime({
    name: "connector-runtime",
    criticality: "required",
    hosts: ["brain"],
    start: () => {
      order.push("connectors:start")
      return () => {
        order.push("connectors:stop")
      }
    },
  })
  const ctx: HeadlessRuntimeContext = {
    host: "brain",
    localAccountId: "account-a",
    bridge: {
      listen: async () => () => {},
      invoke: async () => null,
      respondMedia: async () => {},
    },
    notifyDbWrite: () => {},
    resolveMessage: (key) => key,
    log: () => {},
  }
  const booting = bootstrapHeadlessRuntimes(ctx)
  await bridgeInstalling
  expect(order).toEqual(["plugins:start"])
  expect(subscribePluginToolDispatchBridge).toHaveBeenCalledTimes(1)
  order.push("bridge:start")
  installed(() => {
    order.push("bridge:stop")
  })
  const runtime = await booting
  expect(runtime.failed).toEqual([])
  expect(runtime.status().every((entry) => entry.criticality === "required")).toBe(true)
  expect(runtime.started).toEqual(["plugin-runtime", "plugin-tool-dispatch", "connector-runtime"])
  await runtime.stop()
  await runtime.stop()
  expect(order).toEqual([
    "plugins:start",
    "bridge:start",
    "connectors:start",
    "connectors:stop",
    "bridge:stop",
    "plugins:stop",
  ])
})
