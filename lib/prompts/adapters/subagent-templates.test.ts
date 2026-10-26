/** @jest-environment jsdom */

import { useSubagentRuntimeStore } from "@/stores/agent/subagent-runtime-store"
import type { SubAgentTemplate } from "@/types/agent/sub-agent"
import { resourceKey } from "../resources"
import { subagentTemplatePromptAdapter } from "./subagent-templates"

const adapter = subagentTemplatePromptAdapter
const keyOf = (id: string) => resourceKey("subagent-template", id)

function template(patch: Partial<SubAgentTemplate> & { id: string }): SubAgentTemplate {
  return {
    name: patch.id,
    description: "",
    category: "general",
    taskTemplate: "",
    config: {},
    ...patch,
  }
}

const reviewer = template({
  id: "reviewer",
  name: "Reviewer",
  description: "Reviews diffs",
  config: { systemPrompt: "Review carefully.", tools: ["read_file"], maxSteps: 7 },
})
const tasky = template({ id: "tasky", name: "Tasky", taskTemplate: "Do {{task}}." })
const starter = template({
  id: "starter",
  name: "Starter",
  isBuiltIn: true,
  description: "A starting point",
  taskTemplate: "Start on {{task}}.",
  config: { model: "haiku" },
})

beforeEach(() => {
  useSubagentRuntimeStore.setState({
    templates: { [reviewer.id]: reviewer, [tasky.id]: tasky, [starter.id]: starter },
  })
})

describe("subagentTemplatePromptAdapter", () => {
  it("lists every template, the user's in place and the seeded ones as fork sources", async () => {
    const listed = await adapter.list({})
    expect(listed.map((entry) => [entry.key, entry.edit, entry.builtIn])).toEqual([
      [keyOf("reviewer"), "source", false],
      [keyOf("starter"), "custom-copy", true],
      [keyOf("tasky"), "source", false],
    ])
    expect(listed[0]).toMatchObject({ detail: "Reviews diffs", ownerSection: "subagents" })
  })

  it("reads the prompt the delegation rails send", async () => {
    expect((await adapter.read(keyOf("reviewer"), {}))?.text).toBe("Review carefully.")
    expect((await adapter.read(keyOf("tasky"), {}))?.text).toBe("Do {{task}}.")
    expect(await adapter.read(keyOf("starter"), {})).toEqual({
      key: keyOf("starter"),
      text: "Start on {{task}}.",
      readOnlyReason: "built-in",
    })
    expect(await adapter.read(keyOf("gone"), {})).toBeUndefined()
  })

  it("saves only the prompt of the user's template", async () => {
    await adapter.save!(keyOf("reviewer"), "Review strictly.", undefined, {})
    expect(useSubagentRuntimeStore.getState().templates.reviewer.config).toEqual({
      systemPrompt: "Review strictly.",
      tools: ["read_file"],
      maxSteps: 7,
    })
  })

  it("forks a seeded template with the edited prompt and its settings", async () => {
    await expect(adapter.save!(keyOf("starter"), "x", undefined, {})).rejects.toThrow("fork it")
    const copyKey = await adapter.saveCustom!(
      keyOf("starter"),
      "My starter.",
      {},
      {
        name: "Starter (my version)",
      }
    )
    const copy =
      useSubagentRuntimeStore.getState().templates[copyKey.slice("subagent-template:".length)]
    expect(copy).toMatchObject({
      name: "Starter (my version)",
      isBuiltIn: false,
      config: { model: "haiku", systemPrompt: "My starter." },
    })
    expect(useSubagentRuntimeStore.getState().templates.starter).toEqual(starter)
  })

  it("rejects other owners' keys and unknown templates", async () => {
    await expect(adapter.read("preset:x", {})).rejects.toThrow("not a subagent template")
    await expect(adapter.save!(keyOf("gone"), "x", undefined, {})).rejects.toThrow("not found")
    await expect(adapter.saveCustom!(keyOf("gone"), "x", {})).rejects.toThrow("not found")
  })
})
