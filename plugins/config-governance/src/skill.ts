/**
 * The playbook skill: when the agent should reach for the governance tools,
 * and what it must not do with them. Inline markdown on the manifest; the
 * manager registers it on enable as `<pluginId>:config-governance`.
 */
import { defineSkill, type PluginSkillDef } from "@cognia/plugin-sdk"

import { PLUGIN_ID } from "./model"

export const REPORT_TOOL = "config_governance_report"
export const ADHERENCE_TOOL = "config_governance_adherence"

const PLAYBOOK = `# Agent configuration governance

Use these tools when the user asks whether their agent instructions, Skills,
agents or prompts are still right — "audit my CLAUDE.md", "which rules are
outdated", "does the agent actually follow our rules", "clean up my Skills".

- \`${REPORT_TOOL}\` returns the latest audit of the workspace's agent
  configuration: findings with their location, quoted evidence, pattern,
  confidence and proposed action. Pass \`refresh: true\` to re-run the audit
  first (it reads every surface and makes model calls; say so before you do).
- \`${ADHERENCE_TOOL}\` returns how often each checkable rule was actually
  followed in past sessions. Pass \`refresh: true\` to replay the checks over
  recent sessions (local, no model call).

Present findings as the report states them; never invent a finding, a line
number or a follow rate. A finding is a proposal, not a verdict: the user
decides. You cannot apply changes or adopt enforcement rules with these tools
— point the user to the Config Governance view, where each change is shown as
a diff and confirmed one surface at a time. Do not edit instruction files
yourself to "fix" a finding unless the user asks you to.`

export const GOVERNANCE_SKILL: PluginSkillDef = defineSkill({
  id: `${PLUGIN_ID}:config-governance`,
  slug: "config-governance",
  name: "Configuration governance playbook",
  description:
    "When the user asks whether their agent instructions, Skills, agents or prompts are outdated, conflicting or actually followed: read the governance audit and adherence results and present them faithfully.",
  source: { kind: "inline", markdown: PLAYBOOK },
  scope: "global",
  allowedTools: [REPORT_TOOL, ADHERENCE_TOOL],
})
