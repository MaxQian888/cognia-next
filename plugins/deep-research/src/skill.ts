/**
 * Agent skill (playbook) that teaches the model when + how to use the
 * `deep_research` tool. Inline markdown, declared on the plugin manifest —
 * the manager registers it in the skill registry on enable and drops it on
 * disable. Its id is namespaced `<pluginId>:<slug>` like every plugin skill.
 */
import { defineSkill, type PluginSkillDef } from "@cognia/plugin-sdk"

import { PLUGIN_ID } from "./config"

const PLAYBOOK = `# Deep Research

Use the **\`deep_research\`** tool for any question that needs current, citable
web evidence or multi-hop investigation — comparisons, "latest" / "state of the
art", market/landscape scans, fact-finding across several sources.

## When to use it
- The answer depends on information you may not hold or that changes over time.
- The user asks to "research", "investigate", "find sources for", or compare options.
- A single search wouldn't suffice — the question has sub-parts.

## When NOT to use it
- Trivia you already know, or pure reasoning/coding tasks with no web dependency.

## How
Call \`deep_research\` with a precise \`query\`. Pick \`depth\`:
- \`quick\` — a fast check (~8 steps).
- \`standard\` — the default.
- \`deep\` — exhaustive, for hard or broad questions.

Pick \`mode\`:
- \`search\` (default) — one cited answer.
- \`report\` — a multi-section cited report, also saved as a workspace
  artifact the user can open and export (\`artifactId\` in the result).

The tool runs an autonomous search → read → reason loop and returns a
**citation-backed** answer. Present its answer with the sources it provides;
never strip or invent citations. If the result carries \`gaveUp\`, say the
answer was produced under budget limits.`

export const DEEP_RESEARCH_SKILL: PluginSkillDef = defineSkill({
  id: `${PLUGIN_ID}:deep-research`,
  slug: "deep-research",
  name: "Deep Research playbook",
  description:
    "Teaches the assistant when to run the deep_research tool (current, citable, multi-source questions), which depth and mode to pick, and how to present its cited answer.",
  source: { kind: "inline", markdown: PLAYBOOK },
  scope: "global",
  allowedTools: ["deep_research"],
})
