import type { PluginContext } from "@cognia/plugin-sdk"

import { createGovernanceHost } from "./host"

function context() {
  return {
    agentConfig: { listSurfaces: jest.fn() },
    storage: { get: jest.fn(), set: jest.fn(), remove: jest.fn() },
    ai: { chat: jest.fn(() => "stream"), getDefaultModel: jest.fn(() => "m") },
    session: { listSessions: jest.fn(), getMessages: jest.fn(), getSession: jest.fn() },
    project: {
      listProjects: jest.fn(async () => [
        { id: "a", name: "A", roots: [{ path: "/extra" }, { path: "/main", isPrimary: true }] },
        { id: "b", name: "B", roots: [], rootDir: "/legacy" },
        { id: "c", name: "C", roots: [] },
      ]),
      getCurrentProjectId: jest.fn(() => "a"),
    },
    prompts: { resolve: jest.fn(async () => ({ text: "resolved", source: "default" })) },
    eval: {
      runDataset: jest.fn(),
      listDatasets: jest.fn(async () => [{ id: "d", name: "D", caseCount: 2 }]),
    },
    configuration: { getOrDefault: jest.fn((_key: string, fallback: unknown) => fallback) },
    ui: { showNotification: jest.fn(), navigate: jest.fn(() => true) },
    i18n: { t: jest.fn((key: string) => `t:${key}`) },
    logger: { warn: jest.fn() },
  }
}

describe("createGovernanceHost", () => {
  it("projects the plugin context onto the runtime's host", async () => {
    const ctx = context()
    const host = createGovernanceHost(ctx as unknown as PluginContext)
    expect(host.agentConfig).toBe(ctx.agentConfig)
    expect(await host.listWorkspaces()).toEqual([
      { id: "a", name: "A", roots: ["/main", "/extra"] },
      { id: "b", name: "B", roots: ["/legacy"] },
      { id: "c", name: "C", roots: [] },
    ])
    expect(host.currentWorkspaceId()).toBe("a")
    expect(await host.resolvePrompt("x", { rule: "r" })).toBe("resolved")
    expect(ctx.prompts.resolve).toHaveBeenCalledWith("x", { values: { rule: "r" } })
    await host.resolvePrompt("y")
    expect(ctx.prompts.resolve).toHaveBeenLastCalledWith("y", {})
    await host.runEval({ datasetId: "d", model: "m", cwd: "/main" })
    expect(ctx.eval.runDataset).toHaveBeenCalledWith({
      targetKind: "chat",
      datasetId: "d",
      model: "m",
      cwd: "/main",
    })
    expect(await host.listEvalDatasets()).toEqual([{ id: "d", name: "D" }])
    expect(host.config().backtestSessionLimit).toBe(50)
    host.notify("title", "body")
    expect(ctx.ui.showNotification).toHaveBeenCalledWith({
      title: "title",
      body: "body",
      type: "info",
    })
    expect(host.navigate("/x")).toBe(true)
    expect(host.t("k")).toBe("t:k")
    expect(host.ai.getDefaultModel()).toBe("m")
    expect(host.ai.chat([], {})).toBe("stream")
    host.log("oops", new Error("e"))
    expect(ctx.logger.warn).toHaveBeenCalledWith("[config-governance] oops", expect.any(Error))
    expect(host.newId()).not.toBe(host.newId())
    expect(typeof host.now()).toBe("number")
  })
})
