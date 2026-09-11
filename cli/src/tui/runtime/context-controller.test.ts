import { runContextReport } from "./context-controller"
import { DEFAULT_RESOLVED_CONFIG } from "../../config/schema"
import type { SdkContextUsage } from "@cognia/agent-config-types"
import type { TuiAction } from "../state/types"
const config = { ...DEFAULT_RESOLVED_CONFIG, cwd: "/work", provider: "anthropic" }
const sdk: SdkContextUsage = {
  totalTokens: 42000,
  maxTokens: 200000,
  percentage: 21,
  categories: [{ name: "Unique messages category", tokens: 37000 }],
  memoryFiles: [{ path: "/workspace/MEMORY.md", type: "Project", tokens: 5000 }],
}
function collect() {
  const actions: TuiAction[] = []
  return { actions, dispatch: (action: TuiAction) => actions.push(action) }
}
function document(actions: TuiAction[]) {
  const action = actions.find((action) => action.type === "OVERLAY_OPEN")
  if (action?.type !== "OVERLAY_OPEN" || action.overlay.kind !== "document")
    throw new Error("Expected context document")
  expect(action.overlay.format).toBe("markdown")
  return action.overlay
}
it("opens a searchable report without requesting a nonexistent session", async () => {
  const { actions, dispatch } = collect()
  const fetchSdkContext = jest.fn()
  await runContextReport({ dispatch, config, sessionId: "", fetchSdkContext })
  expect(fetchSdkContext).not.toHaveBeenCalled()
  expect(document(actions).title).toBe("Context details")
  expect(document(actions).body).toContain("No live session")
})
it("places authoritative full SDK detail ahead of local telemetry", async () => {
  const { actions, dispatch } = collect()
  await runContextReport({ dispatch, config, sessionId: "s1", fetchSdkContext: async () => sdk })
  const body = document(actions).body
  expect(body).toContain("Unique messages category")
  expect(body).toContain("/workspace/MEMORY.md")
  expect(body).toContain("/context")
  expect(actions.some((action) => action.type === "NOTICE")).toBe(false)
})
it.each(["codex", "pi-rpc"])(
  "does not query an unrelated Anthropic session on %s",
  async (agentBackend) => {
    const { actions, dispatch } = collect()
    const fetchSdkContext = jest.fn()
    await runContextReport({
      dispatch,
      config: { ...config, agentBackend },
      usage: { contextTokens: 400, contextWindow: 1000 },
      sessionId: "s1",
      fetchSdkContext,
    })
    expect(fetchSdkContext).not.toHaveBeenCalled()
    expect(document(actions).body).toContain("400")
    expect(document(actions).body).toContain("does not expose")
  }
)
it("skips unsupported built-in providers and localizes the report shell", async () => {
  const { actions, dispatch } = collect()
  const fetchSdkContext = jest.fn()
  await runContextReport({
    dispatch,
    config: { ...config, provider: "openai", locale: "zh-CN" },
    sessionId: "s1",
    fetchSdkContext,
  })
  expect(fetchSdkContext).not.toHaveBeenCalled()
  expect(document(actions).title).toBe("上下文详情")
})
it("keeps local telemetry usable when live retrieval fails", async () => {
  const { actions, dispatch } = collect()
  await runContextReport({
    dispatch,
    config,
    sessionId: "s1",
    usage: { inputTokens: 100 },
    fetchSdkContext: async () => {
      throw new Error("no_active_session")
    },
  })
  expect(document(actions).body).toContain("Live breakdown unavailable")
})
it("bounds a hung live fetch and never replaces the fallback with a late result", async () => {
  const { actions, dispatch } = collect()
  let release!: (value: SdkContextUsage) => void
  await runContextReport({
    dispatch,
    config,
    sessionId: "s1",
    timeoutMs: 1,
    fetchSdkContext: () =>
      new Promise((resolve) => {
        release = resolve
      }),
  })
  expect(document(actions).body).toContain("timed out")
  release(sdk)
  await Promise.resolve()
  expect(actions).toHaveLength(1)
})
it("cancels pending retrieval immediately without publishing a late overlay", async () => {
  const { actions, dispatch } = collect()
  const controller = new AbortController()
  const promise = runContextReport({
    dispatch,
    config,
    sessionId: "s1",
    signal: controller.signal,
    fetchSdkContext: () => new Promise(() => {}),
  })
  controller.abort()
  await promise
  expect(actions).toEqual([])
})
it("does no work when already cancelled", async () => {
  const { actions, dispatch } = collect()
  const controller = new AbortController()
  controller.abort()
  const fetchSdkContext = jest.fn()
  await runContextReport({
    dispatch,
    config,
    sessionId: "s1",
    signal: controller.signal,
    fetchSdkContext,
  })
  expect(actions).toEqual([])
  expect(fetchSdkContext).not.toHaveBeenCalled()
})
