import { pluginManager, getPluginEventHooks, getPluginLifecycleHooks } from "./index"

describe("pluginManager", () => {
  it("list() returns []", () => {
    expect(pluginManager.list()).toEqual([])
  })

  it("get(any) returns undefined", () => {
    expect(pluginManager.get("any")).toBeUndefined()
  })
})

describe("getPluginEventHooks", () => {
  it("returns callable noop dispatchers when no plugin is registered", () => {
    // Phase 2 wired the real `HookDispatcher` in; the legacy
    // `beforeSend` / `afterReceive` / `onError` arrays are no longer
    // surfaced as state — plugins register through the dispatcher API
    // instead. The dispatchers are still safe to call when nothing is
    // registered, which is what cognia-next's runtime guarantees.
    const h = getPluginEventHooks()
    h.dispatchExternalAgentConnect()
    h.dispatchExternalAgentDisconnect()
    h.dispatchExternalAgentError()
    h.dispatchExternalAgentExecutionStart()
    h.dispatchExternalAgentExecutionComplete()
    h.dispatchArtifactCreate()
    h.dispatchArtifactUpdate()
    h.dispatchArtifactDelete()
    h.dispatchArtifactOpen()
    h.dispatchArtifactClose()
  })
})

describe("getPluginLifecycleHooks", () => {
  it("returns no-op scheduled task dispatchers", () => {
    const h = getPluginLifecycleHooks()
    h.dispatchOnScheduledTaskStart("t", "e")
    h.dispatchOnScheduledTaskComplete("t", "e", { success: true })
    h.dispatchOnScheduledTaskError("t", "e", new Error("fail"))
  })
})
