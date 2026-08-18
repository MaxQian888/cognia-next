/**
 * End-to-end registration test for the agent-team-examples reference plugin:
 * every contribution array on its manifest (subagents / team templates /
 * shared-memory adapter / balance adapter) flows through the matching overlay
 * registry and is cleaned up on unregister.
 *
 * The contribution entries ride the TypeScript module-manifest overlay rather
 * than `plugin.json` (browser-builtin-registry merges module over JSON), so
 * this suite is the only thing pinning them — including the capability parity
 * between the two manifests.
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
import {
  registerSharedMemoryAdapter,
  unregisterSharedMemoryAdaptersByPlugin,
  getSharedMemoryAdapter,
  __resetSharedMemoryAdaptersForTesting,
} from "@/lib/plugin/registries/shared-memory-adapter-registry"
import {
  registerBalanceAdapter,
  unregisterBalanceAdaptersByPlugin,
  getBalanceAdapter,
  __resetBalanceAdaptersForTesting,
} from "@/lib/plugin/registries/balance-adapter-registry"
import jsonManifest from "../plugin.json"

const PLUGIN_ID = "cognia-agent-team-examples"

describe("agent-team-examples plugin", () => {
  beforeEach(() => {
    __resetSubagentsForTesting()
    __resetAgentTeamTemplatesForTesting()
    __resetSharedMemoryAdaptersForTesting()
    __resetBalanceAdaptersForTesting()
  })

  it("declares every contribution array in its manifest", () => {
    expect(manifest.subagents).toHaveLength(3)
    expect(manifest.agentTeamTemplates).toHaveLength(2)
    expect(manifest.sharedMemoryAdapters).toHaveLength(1)
    expect(manifest.balanceAdapters).toHaveLength(1)
    expect(definition.manifest.id).toBe(PLUGIN_ID)
  })

  // The overlay wins the merge, so a capability present only on the TS side
  // would ship unvalidated by the first-party manifest gate (which reads the
  // JSON). Keep the two capability lists identical.
  it("keeps plugin.json capabilities in parity with the module overlay", () => {
    expect([...(manifest.capabilities ?? [])].sort()).toEqual(
      [...(jsonManifest.capabilities as string[])].sort()
    )
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

  it("registers + resolves its shared-memory adapter, then cleans up", () => {
    for (const ad of manifest.sharedMemoryAdapters ?? []) {
      registerSharedMemoryAdapter(ad.id, ad, { pluginId: PLUGIN_ID })
    }
    expect(getSharedMemoryAdapter("cognia-agent-team-examples:in-memory")).toBeDefined()

    expect(unregisterSharedMemoryAdaptersByPlugin(PLUGIN_ID)).toBe(1)
    expect(getSharedMemoryAdapter("cognia-agent-team-examples:in-memory")).toBeUndefined()
  })

  it("registers + resolves its balance adapter, then cleans up", () => {
    for (const ad of manifest.balanceAdapters ?? []) {
      registerBalanceAdapter(ad.id, ad, { pluginId: PLUGIN_ID })
    }
    expect(getBalanceAdapter("cognia-agent-team-examples:demo-balance")).toBeDefined()

    expect(unregisterBalanceAdaptersByPlugin(PLUGIN_ID)).toBe(1)
    expect(getBalanceAdapter("cognia-agent-team-examples:demo-balance")).toBeUndefined()
  })
})
