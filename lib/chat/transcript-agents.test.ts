import type { UIMessage } from "ai"
import {
  assistantAgentKey,
  hasMultipleAgentKeys,
  transcriptHasMultipleAgents,
} from "./transcript-agents"

const turn = (id: string, run?: object, role: UIMessage["role"] = "assistant"): UIMessage => ({
  id,
  role,
  parts: [{ type: "text", text: id }],
  metadata: run ? { run } : undefined,
})

const build = { agent: { presetId: "build", name: "Build" } }
const plan = { agent: { presetId: "plan", name: "Plan" } }
const codex = { agent: { presetId: "build" }, route: { handle: "Codex", label: "Codex" } }

describe("assistantAgentKey", () => {
  it("prefers the routed handle over the stamped preset", () => {
    expect(assistantAgentKey(turn("a", codex))).toBe("route:codex")
    expect(assistantAgentKey(turn("a", build))).toBe("preset:build")
  })

  it("ignores user turns and unstamped turns", () => {
    expect(assistantAgentKey(turn("u", build, "user"))).toBeUndefined()
    expect(assistantAgentKey(turn("a"))).toBeUndefined()
    expect(assistantAgentKey(turn("a", { agent: { presetId: "  " } }))).toBeUndefined()
  })
})

describe("transcriptHasMultipleAgents", () => {
  it("is false for a one-agent chat, however long", () => {
    expect(transcriptHasMultipleAgents([])).toBe(false)
    expect(
      transcriptHasMultipleAgents([
        turn("u1", undefined, "user"),
        turn("a1", build),
        turn("a2", build),
      ])
    ).toBe(false)
  })

  it("is true once the composition changes mid-session", () => {
    expect(transcriptHasMultipleAgents([turn("a1", build), turn("a2", plan)])).toBe(true)
  })

  it("is true once a turn is addressed to another agent", () => {
    expect(transcriptHasMultipleAgents([turn("a1", build), turn("a2", codex)])).toBe(true)
  })

  it("does not count unstamped (streaming or legacy) turns as a second agent", () => {
    expect(transcriptHasMultipleAgents([turn("a1", build), turn("a2")])).toBe(false)
  })
})

describe("hasMultipleAgentKeys", () => {
  it("skips missing keys and flips on the first difference", () => {
    expect(hasMultipleAgentKeys([undefined, "preset:build", undefined, "preset:build"])).toBe(false)
    expect(hasMultipleAgentKeys(["preset:build", "route:codex"])).toBe(true)
  })

  it("reads stored rows the same way as UI messages", () => {
    const stored = {
      role: "assistant" as const,
      metadata: { run: { agent: { presetId: "plan" } } },
    }
    expect(assistantAgentKey(stored)).toBe("preset:plan")
  })
})
