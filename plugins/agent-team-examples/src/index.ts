/**
 * Agent Team Examples — reference plugin (ADR-0032).
 *
 * Demonstrates the `subagent` + `agent-team-template` capabilities end-to-end:
 * three subagents (researcher / coder / tester) and two team templates
 * (research-pair / tdd-trio) that reference them. The templates exercise the
 * extended teammate schema (systemPrompt / capabilities / governanceHints /
 * tags / iconKey) so this plugin doubles as the schema-extension fixture.
 *
 * Registration is fully declarative — the plugin manager's
 * `OVERLAY_REGISTRY_CAPABILITIES` dispatch loop reads `manifest.subagents` and
 * `manifest.agentTeamTemplates`, so no imperative activate() wiring is needed.
 */

import type { PluginDefinition, PluginManifest } from "@/types/plugin"
import { defineSubagent, defineAgentTeamTemplate } from "@/lib/plugin/sdk"
import { demoSharedMemoryAdapter } from "./demo-adapter"
import { demoBalanceAdapter } from "./demo-balance-adapter"

const PLUGIN_ID = "cognia-agent-team-examples"

const researcher = defineSubagent({
  id: "researcher",
  name: "Researcher",
  description: "Gathers context, reads source material, and produces a findings brief.",
  prompt:
    "You are a researcher. Investigate the assigned topic using the available read/search tools, then produce a concise findings brief with citations. Never modify files.",
  tools: ["Read", "Grep", "Glob", "WebSearch"],
  model: "sonnet",
  effort: "medium",
})

const coder = defineSubagent({
  id: "coder",
  name: "Coder",
  description: "Implements changes against a brief and keeps the build green.",
  prompt:
    "You are an implementer. Turn the researcher's brief into working code with minimal, surgical changes. Run the project's checks before declaring done.",
  tools: ["Read", "Edit", "Write", "Bash", "Grep", "Glob"],
  model: "sonnet",
  effort: "high",
})

const tester = defineSubagent({
  id: "tester",
  name: "Tester",
  description: "Writes failing tests first, then verifies the implementation passes them.",
  prompt:
    "You are a test author. Write tests that capture the required behavior, confirm they fail for the right reason, then verify the implementation makes them pass.",
  tools: ["Read", "Write", "Edit", "Bash", "Grep", "Glob"],
  model: "sonnet",
  effort: "high",
})

const researchPair = defineAgentTeamTemplate({
  id: "research-pair",
  name: "Research Pair",
  description: "A researcher feeds a coder — investigate, then implement.",
  category: "research",
  icon: "search",
  teammates: [
    {
      name: "Researcher",
      description: "Investigates and briefs.",
      systemPrompt: researcher.prompt,
      capabilities: { subagentIds: { add: [`${PLUGIN_ID}:researcher`] } },
      tags: ["research"],
      iconKey: "search",
    },
    {
      name: "Coder",
      description: "Implements from the brief.",
      systemPrompt: coder.prompt,
      capabilities: { subagentIds: { add: [`${PLUGIN_ID}:coder`] } },
      tags: ["build"],
      iconKey: "code",
    },
  ],
  taskTemplates: [
    {
      title: "Investigate the topic",
      description: "Produce a findings brief.",
      priority: "high",
      assignedToIndex: 0,
    },
    {
      title: "Implement the change",
      description: "Apply the brief.",
      priority: "high",
      assignedToIndex: 1,
    },
  ],
  requires: {
    subagentIds: [`${PLUGIN_ID}:researcher`, `${PLUGIN_ID}:coder`],
  },
})

const tddTrio = defineAgentTeamTemplate({
  id: "tdd-trio",
  name: "TDD Trio",
  description: "Researcher + coder + tester running a test-driven loop.",
  category: "development",
  icon: "flask-conical",
  config: {
    governancePolicy: {
      approval: { requirePlanApproval: true, requireDelegationApproval: false },
      budget: {
        tokenBudget: 0,
        warningThreshold: 0.8,
        criticalThreshold: 0.95,
        onCritical: "notify",
      },
      escalation: { allowOperatorPatternOverride: true, pauseOnHighRisk: false },
    },
  },
  teammates: [
    {
      name: "Researcher",
      description: "Investigates and briefs.",
      systemPrompt: researcher.prompt,
      capabilities: { subagentIds: { add: [`${PLUGIN_ID}:researcher`] } },
      tags: ["research"],
      iconKey: "search",
    },
    {
      name: "Coder",
      description: "Implements from the brief.",
      systemPrompt: coder.prompt,
      capabilities: { subagentIds: { add: [`${PLUGIN_ID}:coder`] } },
      governanceHints: {
        approval: { requirePlanApproval: true, requireDelegationApproval: false },
      },
      tags: ["build"],
      iconKey: "code",
    },
    {
      name: "Tester",
      description: "Writes and runs the tests.",
      systemPrompt: tester.prompt,
      capabilities: { subagentIds: { add: [`${PLUGIN_ID}:tester`] } },
      tags: ["test"],
      iconKey: "flask-conical",
    },
  ],
  taskTemplates: [
    { title: "Investigate", description: "Findings brief.", priority: "high", assignedToIndex: 0 },
    {
      title: "Write failing tests",
      description: "Capture behavior.",
      priority: "high",
      assignedToIndex: 2,
    },
    {
      title: "Implement",
      description: "Make the tests pass.",
      priority: "high",
      assignedToIndex: 1,
    },
  ],
  requires: {
    subagentIds: [`${PLUGIN_ID}:researcher`, `${PLUGIN_ID}:coder`, `${PLUGIN_ID}:tester`],
  },
})

export const manifest: PluginManifest = {
  id: PLUGIN_ID,
  name: "Agent Team Examples",
  version: "0.1.0",
  type: "frontend",
  capabilities: ["subagent", "agent-team-template", "shared-memory-adapter", "balance-adapter"],
  main: "src/index.ts",
  subagents: [researcher, coder, tester],
  agentTeamTemplates: [researchPair, tddTrio],
  sharedMemoryAdapters: [demoSharedMemoryAdapter],
  balanceAdapters: [demoBalanceAdapter],
} as PluginManifest

const definition: PluginDefinition = {
  manifest,
  // Registration is declarative (manifest arrays are dispatched by the plugin
  // manager). The lifecycle hook is required by the type but has no work here.
  activate: async () => {},
}

export default definition
