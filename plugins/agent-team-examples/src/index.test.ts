/**
 * End-to-end registration test for the agent-team-examples reference plugin:
 * its manifest subagents + templates flow through the overlay registries and
 * are cleaned up on unregister.
 */

import definition, { manifest } from "./index"
import {
  registerSubagent,
  unregisterSubagentsByPlugin,
  getSubagent,
  __resetSubagentsForTesting,
} from "@/lib/plugin/registries/subagent-registry"
import {
  registerAgentTeamTemplate,
  unregisterAgentTeamTemplatesByPlugin,
  getAgentTeamTemplate,
  __resetAgentTeamTemplatesForTesting,
} from "@/lib/plugin/registries/agent-team-template-registry"

const PLUGIN_ID = "cognia-agent-team-examples"

describe("agent-team-examples plugin", () => {
  beforeEach(() => {
    __resetSubagentsForTesting()
    __resetAgentTeamTemplatesForTesting()
  })

  it("declares 3 subagents and 2 templates in its manifest", () => {
    expect(manifest.subagents).toHaveLength(3)
    expect(manifest.agentTeamTemplates).toHaveLength(2)
    expect(definition.manifest.id).toBe(PLUGIN_ID)
  })

  it("registers + resolves its subagents, then cleans up on unregister", () => {
    for (const sa of manifest.subagents ?? []) {
      registerSubagent(sa.id, sa, { pluginId: PLUGIN_ID })
    }
    expect(getSubagent("researcher")).toBeDefined()
    expect(getSubagent("coder")).toBeDefined()
    expect(getSubagent("tester")).toBeDefined()

    expect(unregisterSubagentsByPlugin(PLUGIN_ID)).toBe(3)
    expect(getSubagent("researcher")).toBeUndefined()
  })

  it("registers + resolves its templates, then cleans up on unregister", () => {
    for (const tpl of manifest.agentTeamTemplates ?? []) {
      registerAgentTeamTemplate(tpl.id, tpl, { pluginId: PLUGIN_ID })
    }
    expect(getAgentTeamTemplate("research-pair")).toBeDefined()
    expect(getAgentTeamTemplate("tdd-trio")).toBeDefined()

    expect(unregisterAgentTeamTemplatesByPlugin(PLUGIN_ID)).toBe(2)
    expect(getAgentTeamTemplate("research-pair")).toBeUndefined()
  })

  it("template teammates carry the extended schema fields", () => {
    const trio = manifest.agentTeamTemplates?.find((t) => t.id === "tdd-trio")
    expect(trio).toBeDefined()
    const coder = trio?.teammates.find((m) => m.name === "Coder")
    expect(coder?.systemPrompt).toBeTruthy()
    expect(coder?.capabilities?.subagentIds?.add).toContain(`${PLUGIN_ID}:coder`)
    expect(coder?.governanceHints?.approval?.requirePlanApproval).toBe(true)
    expect(coder?.tags).toContain("build")
  })
})
