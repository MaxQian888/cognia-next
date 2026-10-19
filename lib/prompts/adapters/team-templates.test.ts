/** @jest-environment jsdom */

const mockPublish = jest.fn(async (_template: unknown) => undefined)
jest.mock("@/lib/agent-team/publish-template-to-platform", () => ({
  publishSquadTemplateToPlatform: (template: unknown) => mockPublish(template),
}))

import {
  __resetAgentTeamTemplatesForTesting,
  registerAgentTeamTemplate,
} from "@/lib/plugin/registries/agent-team-template-registry"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import type { AgentTeamTemplate } from "@/types/agent/agent-team"
import { resourceKey } from "../resources"
import { teamTemplatePromptAdapter } from "./team-templates"

const adapter = teamTemplatePromptAdapter
const keyOf = (templateId: string, index: number) =>
  resourceKey("team-template", `${templateId}#${index}`)

function template(patch: Partial<AgentTeamTemplate> & { id: string }): AgentTeamTemplate {
  return {
    name: patch.id,
    description: "",
    category: "general",
    teammates: [],
    ...patch,
  }
}

const mine = template({
  id: "mine",
  name: "My squad",
  teammates: [
    {
      name: "Lead",
      description: "Runs it",
      systemPrompt: "Lead text.",
      config: { tools: ["read_file"] } as never,
    },
    { name: "Writer", description: "", config: { systemPrompt: "Config text." } as never },
  ],
})
const shipped = template({
  id: "builtin-review",
  name: "Review",
  isBuiltIn: true,
  teammates: [{ name: "Reviewer", description: "", systemPrompt: "Review text." }],
})

beforeEach(() => {
  mockPublish.mockClear()
  __resetAgentTeamTemplatesForTesting()
  useAgentTeamStore.setState({ templates: { [mine.id]: mine, [shipped.id]: shipped } })
})

describe("teamTemplatePromptAdapter", () => {
  it("lists one resource per teammate, the user's own editable in place", async () => {
    registerAgentTeamTemplate(
      "cell",
      {
        id: "cell",
        name: "Knowledge cell",
        description: "",
        category: "general",
        teammates: [{ name: "Analyst", description: "", systemPrompt: "Analyst text." }],
      },
      { pluginId: "work" }
    )
    const listed = await adapter.list({})
    expect(listed.map((entry) => [entry.key, entry.name, entry.edit])).toEqual([
      [keyOf("work:cell", 0), "Knowledge cell · Analyst", "custom-copy"],
      [keyOf("mine", 0), "My squad · Lead", "source"],
      [keyOf("mine", 1), "My squad · Writer", "source"],
      [keyOf("builtin-review", 0), "Review · Reviewer", "custom-copy"],
    ])
    expect(listed[1]).toMatchObject({ detail: "Runs it", ownerSection: "squads", builtIn: false })
    expect(await adapter.read(keyOf("work:cell", 0), {})).toEqual({
      key: keyOf("work:cell", 0),
      text: "Analyst text.",
      readOnlyReason: "plugin",
    })
  })

  it("reads the prompt instantiation uses: the teammate's own, else its config's", async () => {
    expect((await adapter.read(keyOf("mine", 0), {}))?.text).toBe("Lead text.")
    expect((await adapter.read(keyOf("mine", 1), {}))?.text).toBe("Config text.")
    expect(await adapter.read(keyOf("mine", 5), {})).toBeUndefined()
    expect(await adapter.read(keyOf("gone", 0), {})).toBeUndefined()
  })

  it("saves only the teammate's prompt and mirrors the template to the platform", async () => {
    await adapter.save!(keyOf("mine", 1), "Writer text.", undefined, {})
    const saved = useAgentTeamStore.getState().templates.mine
    expect(saved.teammates[1]).toMatchObject({
      name: "Writer",
      systemPrompt: "Writer text.",
      config: { systemPrompt: "Config text." },
    })
    expect(saved.teammates[0]).toEqual(mine.teammates[0])
    expect(mockPublish).toHaveBeenCalledWith(expect.objectContaining({ id: "mine" }))
  })

  it("copies a shipped template whole, with only this teammate's prompt changed", async () => {
    await expect(adapter.save!(keyOf("builtin-review", 0), "x", undefined, {})).rejects.toThrow(
      "edit a copy"
    )
    const copyKey = await adapter.saveCustom!(
      keyOf("builtin-review", 0),
      "My review.",
      {},
      {
        name: "Review (my version)",
      }
    )
    const copyId = copyKey.slice("team-template:".length, copyKey.lastIndexOf("#"))
    const copy = useAgentTeamStore.getState().templates[copyId]
    expect(copy).toMatchObject({
      name: "Review (my version)",
      isBuiltIn: false,
      teammates: [{ name: "Reviewer", systemPrompt: "My review." }],
    })
    expect(useAgentTeamStore.getState().templates["builtin-review"]).toEqual(shipped)
    expect(mockPublish).toHaveBeenCalledWith(copy)
    expect(copyKey.endsWith("#0")).toBe(true)
  })

  it("rejects keys of other owners and malformed teammate references", async () => {
    await expect(adapter.read("preset:x", {})).rejects.toThrow("not a team template")
    await expect(adapter.read("team-template:mine", {})).rejects.toThrow("not a team template")
    await expect(adapter.read("team-template:mine#-1", {})).rejects.toThrow("not a team template")
    await expect(adapter.saveCustom!(keyOf("gone", 0), "x", {})).rejects.toThrow("not found")
  })
})
