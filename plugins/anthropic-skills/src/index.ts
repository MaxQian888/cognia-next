/**
 * Starter Skills (`cognia-anthropic-skills`) — bundled built-in plugin.
 *
 * Contributes three hand-written starter skills (code review, data analysis,
 * web research). They follow the Agent Skills convention (SKILL.md YAML
 * frontmatter + markdown body) and are sourced inline, so the plugin ships
 * working content with no filesystem dependency. They are NOT copies of the
 * anthropics/skills repository — the plugin id keeps its historical name only
 * so existing installs are not orphaned.
 *
 * Registration is declarative: `manifest.skills` is walked by the plugin
 * manager's overlay dispatch on enable and dropped on disable. The host's
 * `resolveSkillMarkdown` returns an inline body verbatim and the skills bridge
 * folds it into the system prompt of a conversation that turned the skill on.
 *
 * Activation is lazy (`onCommand:skill`): nothing runs for users who never
 * enable the plugin or type `/skill`.
 */

import {
  definePlugin,
  definePluginManifest,
  defineSkill,
  type PluginCommandResult,
  type PluginContext,
  type PluginSkillDef,
} from "@cognia/plugin-sdk"
import manifestJson from "../plugin.json"

export const PLUGIN_ID = "cognia-anthropic-skills"

/** Registry id for a skill this plugin contributes (`<pluginId>:<slug>`). */
export function starterSkillId(slug: string): string {
  return `${PLUGIN_ID}:${slug}`
}

const CODE_REVIEW = defineSkill({
  id: starterSkillId("code-review"),
  slug: "code-review",
  name: "Code Review",
  description:
    "Review a diff or files for bugs, security issues, and missing tests, with file:line findings and suggested fixes.",
  category: "development",
  source: {
    kind: "inline",
    markdown: `---
name: code-review
description: Review code changes for quality, security, and correctness.
---

# Code Review

When the user asks you to review code:

1. Read the diff or changed files carefully
2. Look for: bugs, security issues, performance problems, unclear naming, missing tests
3. Structure your response as: **Strengths**, **Issues (Critical/Important/Minor)**, **Assessment**
4. Be specific — quote file:line references
5. Suggest fixes, don't just identify problems
`,
  },
})

const DATA_ANALYSIS = defineSkill({
  id: starterSkillId("data-analysis"),
  slug: "data-analysis",
  name: "Data Analysis",
  description:
    "Inspect tabular data, check quality, and report statistics with stated uncertainty.",
  category: "data-analysis",
  source: {
    kind: "inline",
    markdown: `---
name: data-analysis
description: Analyze tabular data carefully.
---

# Data Analysis

When the user asks you to analyze data:

1. First, understand the data shape (rows, columns, types)
2. Check for missing values, outliers, and basic distributions
3. Form testable hypotheses before computing statistics
4. Report results with clear language and uncertainty bounds
5. Suggest visualizations when patterns are non-obvious
`,
  },
})

const WEB_RESEARCH = defineSkill({
  id: starterSkillId("web-research"),
  slug: "web-research",
  name: "Web Research",
  description: "Research a topic from primary sources, cross-check claims, and cite URLs.",
  category: "productivity",
  source: {
    kind: "inline",
    markdown: `---
name: web-research
description: Research topics on the web with source quality checks.
---

# Web Research

When the user asks you to research a topic:

1. Use specific search queries with year and version constraints
2. Read primary sources, not aggregators
3. Cross-check claims across multiple sources
4. Note publication dates and author credibility
5. Cite sources with URLs in your response
`,
  },
})

export const STARTER_SKILLS: readonly PluginSkillDef[] = [CODE_REVIEW, DATA_ANALYSIS, WEB_RESEARCH]

/** i18n key prefix per skill, for the `/skill` listing. */
const SKILL_MESSAGE_KEYS: Record<string, string> = {
  [CODE_REVIEW.id]: "skill.codeReview",
  [DATA_ANALYSIS.id]: "skill.dataAnalysis",
  [WEB_RESEARCH.id]: "skill.webResearch",
}

// Spread plugin.json (commands, activation, i18n bundle) and add only the
// TypeScript-authored skills; the manager registers them on enable, so the
// plugin never registers them a second time imperatively.
export const manifest = definePluginManifest({
  ...manifestJson,
  skills: [...STARTER_SKILLS],
})

/** The plugin's `ctx.i18n.t`, narrowed to the params this plugin passes. */
export type SkillListTranslate = (key: string, params?: Record<string, string | number>) => string

/** The `/skill` response: the localized skill list plus how to turn one on. */
export function renderSkillList(t: SkillListTranslate): string {
  const lines = [`### ${t("skill.title")}`, "", t("skill.intro"), ""]
  for (const skill of STARTER_SKILLS) {
    const key = SKILL_MESSAGE_KEYS[skill.id]
    lines.push(t("skill.item", { name: t(`${key}.name`), description: t(`${key}.description`) }))
  }
  lines.push("", t("skill.howTo"))
  return lines.join("\n")
}

export default definePlugin({
  manifest,
  activate: async (ctx: PluginContext) => {
    // The slash command is DECLARED in plugin.json (`commands[]`) and handled
    // here. The manager owns registration (namespaced id, conflict detection,
    // aliases, command-palette entry, idle-clock refresh) and teardown.
    return {
      onCommand: async (command: string): Promise<boolean | PluginCommandResult> => {
        if (command !== "skill") return false
        return { handled: true, message: renderSkillList(ctx.i18n.t) }
      },
    }
  },
})
