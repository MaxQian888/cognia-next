/**
 * Agent skill (playbook) that teaches the model when + how to use the
 * `deep_research` tool. Inline markdown, registered via the host skill
 * registry; auto-unregistered on disable.
 */
import type { PluginContext } from "@/types/plugin"
import type { PluginSkillDef } from "@/types/plugin/plugin-skill"

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

The tool runs an autonomous search → read → reason loop and returns a
**citation-backed** answer. Present its answer with the sources it provides;
never strip or invent citations.`

export const DEEP_RESEARCH_SKILL: PluginSkillDef = {
  id: "deep-research",
  name: "Deep Research",
  description: "Playbook for the autonomous web deep-research tool.",
  source: { kind: "inline", markdown: PLAYBOOK },
  scope: "global",
  allowedTools: ["deep_research"],
}

export function registerResearchSkill(ctx: PluginContext): void {
  ctx.agent?.registerSkill?.(DEEP_RESEARCH_SKILL)
}
