/**
 * Anthropic Skills — bundled built-in plugin.
 *
 * Registers three starter Agent Skills (code review, data analysis, web
 * research) sourced inline so the plugin ships with working content out of
 * the box, no filesystem dependencies. Each skill follows the standard
 * SKILL.md YAML frontmatter + markdown body convention; the host's
 * `resolveSkillMarkdown` returns the inline body verbatim and the
 * skills-bridge folds it into the system prompt at send time.
 *
 * Authors can later swap any of these for `local-folder` sources that
 * point at a checked-out copy of anthropics/skills — the registration
 * surface is the same.
 *
 * Part of the plugin-first Computer Use plan (M4).
 */

import type { PluginContext, PluginDefinition } from "@cognia/plugin-sdk"
import { defineSkill } from "@cognia/plugin-sdk"
import manifestJson from "../plugin.json"

const CODE_REVIEW = defineSkill({
  id: "anthropic.code-review",
  name: "Code Review",
  description: "Review code changes carefully and produce structured findings.",
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
  id: "anthropic.data-analysis",
  name: "Data Analysis",
  description: "Analyze tabular data and produce clear statistical summaries.",
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
  id: "anthropic.web-research",
  name: "Web Research",
  description: "Conduct thorough web research with source quality checks.",
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

const definition: PluginDefinition = {
  // The runtime treats the manifest as the source of truth; the bundled
  // `plugin.json` next to this file is loaded by the browser-builtin
  // registry. `skills` is declared in `capabilities` so the plugin manager
  // walks the `skills` array on enable and registers each entry with the
  // M1·T3 overlay.
  // Spread plugin.json: `builtinManifest()` merges module-over-JSON, so a
  // hand-written subset here would WIN and silently drop `commands[]`.
  manifest: {
    ...(manifestJson as object),
    skills: [CODE_REVIEW, DATA_ANALYSIS, WEB_RESEARCH],
  } as never,
  activate: async (ctx: PluginContext) => {
    ctx.logger?.info("anthropic-skills plugin activated")
    // Imperative path mirrors the declarative manifest registration so the
    // plugin still works when loaded via dev-mode hot reload before the
    // manifest walker runs.
    ctx.agent?.registerSkill?.(CODE_REVIEW)
    ctx.agent?.registerSkill?.(DATA_ANALYSIS)
    ctx.agent?.registerSkill?.(WEB_RESEARCH)

    // The slash command is DECLARED in plugin.json (`commands[]`) and handled
    // here — the supported shape per the author-SDK migration table. The
    // manager owns registration (namespaced id, conflict detection, aliases,
    // command-palette entry, idle-clock refresh) and teardown.
    return {
      onCommand: async (command: string) => {
        if (command !== "skill") return false
        ctx.ui?.showToast?.(
          "Available skills from anthropic-skills plugin: code-review, data-analysis, web-research. Attach via the character settings.",
          "info"
        )
        return true
      },
    }
  },
}

export default definition
