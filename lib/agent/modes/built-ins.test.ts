import {
  BUILT_IN_AGENT_MODES,
  BUILT_IN_MODE_PROMPTS,
  MODE_PROMPT_PASSTHROUGH_VALUES,
  getAgentMode,
  getAgentModeByType,
  shippedModePrompt,
} from "./built-ins"
import { resolvePrompt } from "@/lib/prompts/resolve"
import {
  __setPromptOverrideSnapshotForTests,
  buildPromptOverrideSnapshot,
} from "@/lib/prompts/snapshot"
import { validatePromptBody } from "@/lib/prompts/template"
import type { AgentModeType } from "@cognia/provider-types/agent-mode"
import type { RoutingContext } from "@cognia/provider-types/auto-router"

describe("shared agent mode contract", () => {
  it("keeps built-in modes usable by the routing context", () => {
    for (const mode of BUILT_IN_AGENT_MODES) {
      const agentMode: AgentModeType = mode.type
      const context: RoutingContext = { agentMode }
      expect(getAgentModeByType(context.agentMode!)).toBe(mode)
      expect(getAgentMode(mode.id)).toBe(mode)
    }
  })

  it("preserves plan and build permissions after moving the shared type", () => {
    expect(getAgentModeByType("plan")?.permissionMode).toBe("plan")
    expect(getAgentModeByType("build")?.permissionMode).toBe("acceptEdits")
    expect(getAgentMode("unknown")).toBeUndefined()
  })
})

describe("built-in mode prompts (ADR-0236)", () => {
  afterEach(() => __setPromptOverrideSnapshotForTests(null))

  it("defines one entry per mode that ships a prompt, with the shipped text as its default", () => {
    const withPrompt = BUILT_IN_AGENT_MODES.filter((mode) => mode.systemPrompt)
    expect([...BUILT_IN_MODE_PROMPTS.keys()]).toEqual(withPrompt.map((mode) => mode.id))
    for (const mode of withPrompt) {
      const def = BUILT_IN_MODE_PROMPTS.get(mode.id)!
      expect(def.id).toBe(`agent.mode.${mode.id}`)
      expect(def.defaultBody).toBe(mode.systemPrompt)
      expect(validatePromptBody(def, def.defaultBody)).toEqual([])
    }
    expect(BUILT_IN_MODE_PROMPTS.has("general")).toBe(false)
  })

  it("matches only the shipped text under the shipped id", () => {
    const research = getAgentMode("research")!
    expect(shippedModePrompt("research", research.systemPrompt)).toBe(
      BUILT_IN_MODE_PROMPTS.get("research")
    )
    expect(shippedModePrompt("research", "edited")).toBeUndefined()
    expect(shippedModePrompt("custom-research", research.systemPrompt)).toBeUndefined()
    expect(shippedModePrompt("general", undefined)).toBeUndefined()
    expect(shippedModePrompt(undefined, research.systemPrompt)).toBeUndefined()
  })

  it("lets an override use the mode template placeholders, leaving them for the send path", () => {
    const def = BUILT_IN_MODE_PROMPTS.get("writing")!
    const body = "Today is {{date}}; tools: {{tools_list}}."
    expect(validatePromptBody(def, body)).toEqual([])
    __setPromptOverrideSnapshotForTests(
      buildPromptOverrideSnapshot("test-db", [
        {
          bindingId: "pob",
          promptId: def.id,
          scope: "account",
          targetId: "",
          revisionId: "por-writing",
          body,
          contractVersion: def.contractVersion,
        },
      ])
    )
    expect(resolvePrompt(def, { values: MODE_PROMPT_PASSTHROUGH_VALUES }).text).toBe(body)
  })
})
