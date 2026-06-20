import { runContextReport } from "./context-controller"
import { DEFAULT_RESOLVED_CONFIG, type ResolvedConfig } from "../../config/schema"
import type { SdkContextUsage } from "@/lib/claude/types"
import type { TuiAction } from "../state/types"

const config: ResolvedConfig = {
  ...DEFAULT_RESOLVED_CONFIG,
  cwd: "/work",
  model: "claude-x",
  provider: "anthropic",
}

function collect() {
  const actions: TuiAction[] = []
  return { actions, dispatch: (a: TuiAction) => actions.push(a) }
}

const noticeText = (actions: TuiAction[]): string => {
  const n = actions.find((a) => a.type === "NOTICE")
  return n && n.type === "NOTICE" ? n.message : ""
}

describe("runContextReport", () => {
  it("emits the estimate-only report when no session is live", async () => {
    const { actions, dispatch } = collect()
    await runContextReport({ dispatch, config, sessionId: "" })
    const msg = noticeText(actions)
    expect(msg).toContain("Context window")
    expect(msg).not.toContain("Live context (SDK)")
  })

  it("appends the SDK breakdown when the control round-trip resolves", async () => {
    const { actions, dispatch } = collect()
    const sdk: SdkContextUsage = {
      totalTokens: 42_000,
      maxTokens: 200_000,
      percentage: 21,
      model: "claude-x",
      categories: [
        { name: "System prompt", tokens: 5_000 },
        { name: "Messages", tokens: 37_000 },
        { name: "Free space", tokens: 0 },
      ],
      mcpTools: [{ name: "search", serverName: "exa", tokens: 1_200 }],
    }
    await runContextReport({
      dispatch,
      config,
      sessionId: "s1",
      fetchSdkContext: async () => sdk,
    })
    const msg = noticeText(actions)
    expect(msg).toContain("Context window") // estimate base still present
    expect(msg).toContain("Live context (SDK) — claude-x")
    expect(msg).toContain("Messages: 37k")
    expect(msg).toContain("MCP tools:       1")
  })

  it("falls back to the estimate when the SDK round-trip rejects", async () => {
    const { actions, dispatch } = collect()
    await runContextReport({
      dispatch,
      config,
      sessionId: "s1",
      fetchSdkContext: async () => {
        throw new Error("no_active_session")
      },
    })
    const msg = noticeText(actions)
    expect(msg).toContain("Context window")
    expect(msg).not.toContain("Live context (SDK)")
  })
})
