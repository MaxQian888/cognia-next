import { defineAgentTeamTemplate } from "@cognia/plugin-sdk"
import type { PluginAgentTeamTemplateDef } from "@cognia/plugin-sdk"
import { workSkillId, workSubagentId } from "./ids"

export const KNOWLEDGE_WORK_TEAM = defineAgentTeamTemplate({
  id: "knowledge-work-cell",
  name: "Knowledge Work Cell",
  description:
    "Planner, researcher, analyst, and editor collaborate from an approved brief to a reviewed deliverable.",
  category: "analysis",
  icon: "BriefcaseBusiness",
  config: {
    governancePolicy: {
      approval: { requirePlanApproval: true, requireDelegationApproval: false },
      budget: {
        tokenBudget: 0,
        warningThreshold: 0.8,
        criticalThreshold: 0.95,
        onCritical: "notify",
      },
      escalation: { allowOperatorPatternOverride: true, pauseOnHighRisk: true },
    },
  },
  teammates: [
    {
      name: "Planner",
      description: "Owns the brief, constraints, work plan, and definition of done.",
      systemPrompt:
        "Turn the requested outcome into a concise brief: audience, decision, inputs, constraints, review criteria, risks, and an ordered plan. Keep research and analysis tasks independent where they can run in parallel. Do not approve execution until the definition of done is observable.",
      tags: ["plan", "coordinate"],
      iconKey: "clipboard-check",
    },
    {
      name: "Researcher",
      description: "Builds the source-backed evidence pack.",
      systemPrompt:
        "Gather primary evidence for the approved brief. Preserve direct links, dates, versions, and uncertainty. Return an evidence pack to the editor; do not write the final deliverable.",
      capabilities: {
        skillIds: { add: [workSkillId("source-grounded-research")] },
        subagentIds: { add: [workSubagentId("researcher")] },
      },
      tags: ["research", "sources"],
      iconKey: "search",
    },
    {
      name: "Analyst",
      description: "Validates data, calculations, assumptions, and implications.",
      systemPrompt:
        "Validate the supplied evidence and data against the brief. Reproduce consequential calculations, surface gaps and conflicting evidence, and return decision-relevant findings. Do not modify the source material.",
      capabilities: {
        skillIds: { add: [workSkillId("spreadsheet-deliverable")] },
        subagentIds: { add: [workSubagentId("analyst")] },
      },
      tags: ["analysis", "verification"],
      iconKey: "chart-no-axes-combined",
    },
    {
      name: "Editor",
      description: "Synthesizes the evidence into the final artifact and closes review findings.",
      systemPrompt:
        "Create the requested finished deliverable from the approved brief, evidence pack, and analysis. Keep claims traceable, make the next action obvious, and use the requested format. Dispatch the independent deliverable reviewer before handoff and address every blocking finding.",
      capabilities: {
        skillIds: {
          add: [
            workSkillId("document-deliverable"),
            workSkillId("spreadsheet-deliverable"),
            workSkillId("presentation-deliverable"),
            workSkillId("deliverable-qa"),
          ],
        },
        subagentIds: { add: [workSubagentId("deliverable-reviewer")] },
      },
      tags: ["synthesis", "delivery", "review"],
      iconKey: "file-check-2",
    },
  ],
  taskTemplates: [
    {
      title: "Approve the work brief",
      description:
        "Confirm audience, outcome, inputs, constraints, review criteria, and definition of done.",
      priority: "high",
      assignedToIndex: 0,
    },
    {
      title: "Build the evidence pack",
      description: "Gather and cross-check primary sources with direct links and evidence gaps.",
      priority: "high",
      assignedToIndex: 1,
    },
    {
      title: "Validate the analysis",
      description: "Check data quality, calculations, assumptions, and implications.",
      priority: "high",
      assignedToIndex: 2,
    },
    {
      title: "Create the deliverable",
      description:
        "Synthesize the approved brief, evidence, and analysis into the requested artifact.",
      priority: "high",
      assignedToIndex: 3,
    },
    {
      title: "Run independent review",
      description:
        "Review against acceptance criteria, fix blockers, and record remaining caveats.",
      priority: "high",
      assignedToIndex: 3,
    },
  ],
  requires: {
    skillIds: [
      workSkillId("source-grounded-research"),
      workSkillId("document-deliverable"),
      workSkillId("spreadsheet-deliverable"),
      workSkillId("presentation-deliverable"),
      workSkillId("deliverable-qa"),
    ],
    subagentIds: [
      workSubagentId("researcher"),
      workSubagentId("analyst"),
      workSubagentId("deliverable-reviewer"),
    ],
  },
}) satisfies PluginAgentTeamTemplateDef
