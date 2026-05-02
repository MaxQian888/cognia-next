/**
 * Tests for Plugin Permission Requests queue
 */

import {
  requestPluginPermission,
  resolvePluginPermission,
  subscribePermissionRequests,
  clearPermissionRequests,
} from "./permission-requests"

describe("permission-requests", () => {
  beforeEach(() => {
    clearPermissionRequests()
  })

  it("should resolve a single permission request", async () => {
    const updates: Array<{ current: string | null; queue: number }> = []
    const unsubscribe = subscribePermissionRequests((state) => {
      updates.push({
        current: state.current?.id ?? null,
        queue: state.queue.length,
      })
    })

    const requestPromise = requestPluginPermission({
      pluginId: "plugin-a",
      permission: "session:read",
      reason: "Need session access",
      kind: "api",
    })

    const currentId = updates[updates.length - 1]?.current
    expect(currentId).toBeTruthy()
    expect(updates[updates.length - 1]?.queue).toBe(0)

    resolvePluginPermission(currentId!, true)
    const result = await requestPromise

    expect(result).toBe(true)
    expect(updates[updates.length - 1]?.current).toBeNull()

    unsubscribe()
  })

  it("should dequeue requests in order", async () => {
    const states: Array<{ current: string | null; queue: number }> = []
    const unsubscribe = subscribePermissionRequests((state) => {
      states.push({
        current: state.current?.id ?? null,
        queue: state.queue.length,
      })
    })

    const firstPromise = requestPluginPermission({
      pluginId: "plugin-a",
      permission: "session:read",
      kind: "api",
    })
    const firstId = states[states.length - 1]?.current

    const secondPromise = requestPluginPermission({
      pluginId: "plugin-b",
      permission: "session:write",
      kind: "api",
    })

    expect(states[states.length - 1]?.queue).toBe(1)

    resolvePluginPermission(firstId!, false)
    const firstResult = await firstPromise
    expect(firstResult).toBe(false)

    const secondId = states[states.length - 1]?.current
    expect(secondId).toBeTruthy()

    resolvePluginPermission(secondId!, true)
    const secondResult = await secondPromise
    expect(secondResult).toBe(true)

    unsubscribe()
  })
})
