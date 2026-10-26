import type { PluginSubagentDef } from "@/types/plugin/plugin-subagent"
import { __resetPluginPromptsForTesting, getPluginPromptEntry } from "./plugin-prompts"
import {
  registerPluginSubagentPrompt,
  resolvePluginSubagentPrompt,
  unregisterPluginSubagentPrompts,
} from "./plugin-subagent-prompts"
import { __setPromptOverrideSnapshotForTests, buildPromptOverrideSnapshot } from "./snapshot"

const researcher: PluginSubagentDef = {
  id: "researcher",
  name: "Researcher",
  description: "Finds sources",
  prompt: "Research the question.",
  effort: "high",
  disallowedTools: ["Bash"],
}
const SLOT = "plugin:work/subagent.researcher"

function publishAccount(body: string) {
  const def = getPluginPromptEntry(SLOT)!.def
  __setPromptOverrideSnapshotForTests(
    buildPromptOverrideSnapshot("test-db", [
      {
        bindingId: "pob-1",
        promptId: SLOT,
        scope: "account",
        targetId: "",
        revisionId: "por-1",
        body,
        contractVersion: def.contractVersion,
      },
    ])
  )
}

afterEach(() => {
  __resetPluginPromptsForTesting()
  __setPromptOverrideSnapshotForTests(null)
})

describe("plugin subagent prompt slots", () => {
  it("registers an account-only slot titled after the subagent", () => {
    registerPluginSubagentPrompt("work", researcher)
    expect(getPluginPromptEntry(SLOT)).toMatchObject({
      title: "Researcher",
      description: "Finds sources",
      def: {
        defaultBody: "Research the question.",
        scopes: ["account"],
        consumers: ["lib/claude/agents/subagents/index.ts"],
      },
    })
  })

  it("sends the plugin's own prompt until an account override is published", () => {
    registerPluginSubagentPrompt("work", researcher)
    __setPromptOverrideSnapshotForTests(buildPromptOverrideSnapshot("test-db", []))
    expect(resolvePluginSubagentPrompt("work", researcher)).toBe("Research the question.")
    publishAccount("Research with primary sources only.")
    expect(resolvePluginSubagentPrompt("work", researcher)).toBe(
      "Research with primary sources only."
    )
  })

  it("ignores a slot that no longer matches the definition, and untagged entries", () => {
    registerPluginSubagentPrompt("work", researcher)
    publishAccount("Override.")
    const changed = { ...researcher, prompt: "A new shipped prompt." }
    expect(resolvePluginSubagentPrompt("work", changed)).toBe("A new shipped prompt.")
    expect(resolvePluginSubagentPrompt(undefined, researcher)).toBe("Research the question.")
  })

  it("gives no slot to a prompt the Prompt Center could not check, and keeps it runnable", () => {
    const dispose = registerPluginSubagentPrompt("work", {
      ...researcher,
      prompt: "Fill {{unknown}} in.",
    })
    expect(getPluginPromptEntry(SLOT)).toBeUndefined()
    expect(() => dispose()).not.toThrow()
    expect(
      resolvePluginSubagentPrompt("work", { ...researcher, prompt: "Fill {{unknown}} in." })
    ).toBe("Fill {{unknown}} in.")
  })

  it("drops a plugin's subagent slots on disable", () => {
    registerPluginSubagentPrompt("work", researcher)
    unregisterPluginSubagentPrompts("work")
    expect(getPluginPromptEntry(SLOT)).toBeUndefined()
  })
})
