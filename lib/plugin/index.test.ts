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
  it("returns empty hook arrays and noop dispatchers", () => {
    const h = getPluginEventHooks()
    expect(h.beforeSend).toEqual([])
    expect(h.afterReceive).toEqual([])
    expect(h.onError).toEqual([])
    // noop dispatchers should be callable without error
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
