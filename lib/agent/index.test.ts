import * as agent from "./index"

describe("agent module barrel", () => {
  it("re-exports status configs and helpers from constants", () => {
    expect(agent.SUB_AGENT_STATUS_CONFIG).toBeDefined()
    expect(agent.BACKGROUND_AGENT_STATUS_CONFIG).toBeDefined()
    expect(agent.LOG_LEVEL_CONFIG).toBeDefined()
    expect(typeof agent.getSubAgentStatusConfig).toBe("function")
    expect(typeof agent.getBackgroundAgentStatusConfig).toBe("function")
  })

  it("re-exports formatting helpers from utils", () => {
    expect(typeof agent.formatToolName).toBe("function")
    expect(typeof agent.formatBytes).toBe("function")
    expect(typeof agent.formatTokens).toBe("function")
    expect(typeof agent.formatDuration).toBe("function")
    expect(typeof agent.downloadFile).toBe("function")
    expect(typeof agent.parseReplayEvent).toBe("function")
  })

  it("no longer re-exports the markdown formatter for a shape nothing builds", () => {
    // `formatAgentAsMarkdown` rendered a `BackgroundAgent` — a record the
    // manager stopped producing when it became a facade over
    // `BackgroundTaskRegistry`. It had no callers and could not be given real
    // data.
    expect("formatAgentAsMarkdown" in agent).toBe(false)
  })

  it("re-exports the static config registries from utils", () => {
    expect(agent.TOOL_STATE_CONFIG).toBeDefined()
    expect(agent.STEP_PRIORITY_CONFIG).toBeDefined()
    expect(agent.GRAPH_STATUS_ICONS).toBeDefined()
    expect(agent.PRIORITY_DOT_COLORS).toBeDefined()
    expect(Array.isArray(agent.TASK_BOARD_COLUMNS)).toBe(true)
    expect(agent.TASK_PRIORITY_COLORS).toBeDefined()
    expect(agent.REPLAY_EVENT_ICONS).toBeDefined()
    expect(agent.LIVE_TRACE_EVENT_ICONS).toBeDefined()
    expect(agent.LIVE_TRACE_EVENT_COLORS).toBeDefined()
  })

  it("re-exports LucideIcons from resolve-icon", () => {
    expect(agent.LucideIcons).toBeDefined()
  })

  it("re-exports buildAgentModeSessionUpdate from mode-session-update", () => {
    expect(typeof agent.buildAgentModeSessionUpdate).toBe("function")
  })
})
