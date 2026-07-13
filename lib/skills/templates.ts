// Curated starting points for new skills. Like `lib/claude/mcp-presets.ts`,
// the catalog lives in code (not the database) so it versions with the app and
// costs no storage. Picking a template seeds the create editor with a
// ready-to-edit name / description / body / category / tags — the user always
// reviews and saves through the normal editor flow.

import type { Skill, SkillCategory } from "@cognia/agent-config-types"

export interface SkillTemplate {
  id: string
  name: string
  description: string
  category: SkillCategory
  tags: string[]
  /** Markdown body pre-filled into the editor. */
  content: string
}

export const SKILL_TEMPLATES: SkillTemplate[] = [
  {
    id: "blank",
    name: "Blank skill",
    description: "An empty skill with the standard section scaffold.",
    category: "custom",
    tags: [],
    content: [
      "# {{name}}",
      "",
      "## When to use",
      "",
      "Describe the situations where this skill applies.",
      "",
      "## Instructions",
      "",
      "1. First step",
      "2. Second step",
      "",
      "## Examples",
      "",
      "Add a worked example here.",
    ].join("\n"),
  },
  {
    id: "code-review",
    name: "Code review checklist",
    description: "Review a diff for correctness, security, and clarity.",
    category: "development",
    tags: ["review", "quality"],
    content: [
      "# Code review",
      "",
      "## When to use",
      "",
      "When asked to review a pull request or a diff before merge.",
      "",
      "## Instructions",
      "",
      "- Confirm the change matches the stated intent; flag scope creep.",
      "- Check correctness: edge cases, error handling, off-by-one, async races.",
      "- Check security: input validation, authz, secrets, injection.",
      "- Check clarity: naming, dead code, duplicated logic.",
      "- Prefer concrete, line-referenced suggestions over general advice.",
    ].join("\n"),
  },
  {
    id: "writing-style",
    name: "Writing style guide",
    description: "Enforce a consistent tone and structure in prose.",
    category: "creative-design",
    tags: ["writing", "style"],
    content: [
      "# Writing style",
      "",
      "## When to use",
      "",
      "When drafting or editing user-facing prose.",
      "",
      "## Instructions",
      "",
      "- Lead with the conclusion, then support it.",
      "- Prefer short, active sentences; cut filler.",
      "- Keep terminology consistent; define jargon once.",
      "- Match the requested tone (formal / neutral / friendly).",
    ].join("\n"),
  },
  {
    id: "research-summary",
    name: "Research & summarize",
    description: "Gather sources, verify claims, and synthesize a brief.",
    category: "productivity",
    tags: ["research", "summary"],
    content: [
      "# Research & summarize",
      "",
      "## When to use",
      "",
      "When asked to investigate a topic and report findings.",
      "",
      "## Instructions",
      "",
      "1. Clarify the question and success criteria.",
      "2. Gather sources; prefer primary / official ones.",
      "3. Cross-check load-bearing claims against a second source.",
      "4. Synthesize a brief: answer first, then evidence, then open questions.",
      "5. Cite sources inline.",
    ].join("\n"),
  },
]

/**
 * Build a Skill-shaped seed for the create editor from a template. The id and
 * timestamps are placeholders — the editor only reads the content fields and
 * produces a fresh draft on save.
 */
export function templateToSkillSeed(template: SkillTemplate): Skill {
  return {
    id: `template:${template.id}`,
    name: template.id === "blank" ? "" : template.name,
    description: template.description,
    content: template.content,
    category: template.category,
    tags: template.tags,
    source: "custom",
    status: "enabled",
    createdAt: 0,
    updatedAt: 0,
  }
}
