import * as messaging from "./index"

describe("lib/plugin/messaging re-exports", () => {
  test("exposes the documented public surface", () => {
    const expected = [
      "HookDispatcher",
      "PluginLifecycleHooks",
      "PluginEventHooks",
      "getPluginLifecycleHooks",
      "getPluginEventHooks",
      "resetPluginLifecycleHooks",
      "resetPluginEventHooks",
      "normalizePriority",
      "priorityToNumber",
      "priorityToString",
      "HookPriority",
      "PluginIPC",
      "getPluginIPC",
      "resetPluginIPC",
      "createIPCAPI",
      "MessageBus",
      "getMessageBus",
      "resetMessageBus",
      "createEventAPI",
      "SystemEvents",
    ] as const

    for (const name of expected) {
      expect(messaging).toHaveProperty(name)
      expect((messaging as Record<string, unknown>)[name]).toBeDefined()
    }
  })
})
