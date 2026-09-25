/**
 * Agent Team Examples — opt-in EXAMPLE plugin (ADR-0032).
 *
 * Not enabled by default (no `startup` activation event): a user turns it on
 * from the Plugins page to try the examples, and every contribution is named
 * "(example)" so it is never mistaken for a curated default in a picker. The
 * names are literal because subagent / team-template / adapter defs carry no
 * `nameKey` the pickers could resolve through the plugin i18n bundle.
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

import {
  defineAgentTeamTemplate,
  definePlugin,
  definePluginManifest,
  defineSubagent,
} from "@cognia/plugin-sdk"
import manifestJson from "../plugin.json"
import { demoSharedMemoryAdapter } from "./demo-adapter"
import { demoBalanceAdapter } from "./demo-balance-adapter"

const PLUGIN_ID = "cognia-agent-team-examples"

/** Suffix every contributed display name carries, so an example never reads as a default. */
export const EXAMPLE_NAME_SUFFIX = " (example)"

const researcher = defineSubagent({
  id: "researcher",
  name: `Researcher${EXAMPLE_NAME_SUFFIX}`,
  description: "Gathers context, reads source material, and produces a findings brief.",
  prompt:
    "You are a researcher. Investigate the assigned topic using the available read/search tools, then produce a concise findings brief with citations. Never modify files.",
  tools: ["Read", "Grep", "Glob", "WebSearch"],
  model: "sonnet",
  effort: "medium",
})

const coder = defineSubagent({
  id: "coder",
  name: `Coder${EXAMPLE_NAME_SUFFIX}`,
  description: "Implements changes against a brief and keeps the build green.",
  prompt:
    "You are an implementer. Turn the researcher's brief into working code with minimal, surgical changes. Run the project's checks before declaring done.",
  tools: ["Read", "Edit", "Write", "Bash", "Grep", "Glob"],
  model: "sonnet",
  effort: "high",
})

const tester = defineSubagent({
  id: "tester",
  name: `Tester${EXAMPLE_NAME_SUFFIX}`,
  description: "Writes failing tests first, then verifies the implementation passes them.",
  prompt:
    "You are a test author. Write tests that capture the required behavior, confirm they fail for the right reason, then verify the implementation makes them pass.",
  tools: ["Read", "Write", "Edit", "Bash", "Grep", "Glob"],
  model: "sonnet",
  effort: "high",
})

const researchPair = defineAgentTeamTemplate({
  id: "research-pair",
  name: `Research Pair${EXAMPLE_NAME_SUFFIX}`,
  description: "A researcher feeds a coder — investigate, then implement.",
  category: "research",
  icon: "Search",
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
  name: `TDD Trio${EXAMPLE_NAME_SUFFIX}`,
  description: "Researcher + coder + tester running a test-driven loop.",
  category: "development",
  icon: "FlaskConical",
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

// Spread plugin.json so no field it declares is dropped (a built-in's module
// manifest is merged OVER its JSON at discovery); only the TypeScript-authored
// contribution arrays are added here.
export const manifest = definePluginManifest({
  ...manifestJson,
  subagents: [researcher, coder, tester],
  agentTeamTemplates: [researchPair, tddTrio],
  sharedMemoryAdapters: [demoSharedMemoryAdapter],
  balanceAdapters: [demoBalanceAdapter],
})

export default definePlugin({
  manifest,
  // Registration is declarative (manifest arrays are dispatched by the plugin
  // manager). The lifecycle hook is required by the type but has no work here.
  activate: async () => {},
})
