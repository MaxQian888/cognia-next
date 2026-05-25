/**
 * "Refactor Review Board" agent-team template.
 *
 * A multi-agent deliberation surface for the *reasoning* phases of a refactor
 * — analysis, plan consensus, and final review. Agent-Team teammate dispatch
 * is text-only (it does not edit code), which is exactly right here: the board
 * produces the analysis/plan/review prose, while the actual edits run through
 * the `agent.turn` node + role characters in the workflow. The two are
 * complementary, not redundant.
 *
 * `requires` is validated (non-blocking) against the live overlay registries:
 * the pack id is the raw registry id (`refactor-roles`), skill ids are the
 * self-namespaced registry ids, and subagent ids are `<pluginId>:<id>` — all
 * contributed by this same plugin (see `validateTemplateRequires`).
 */

import { defineAgentTeamTemplate } from "@/lib/plugin/sdk/define-agent-team-template"
import type { PluginAgentTeamTemplateDef } from "@/types/plugin/plugin-agent-team-template"
import { REFACTOR_PACK_ID } from "../characters/pack"
import { packSkillId, subagentRuntimeId } from "../ids"

export const REVIEW_BOARD_TEMPLATE = defineAgentTeamTemplate({
  id: "refactor-review-board",
  name: "Refactor Review Board",
  description:
    "Architect, analyst, and reviewer deliberate on the refactor plan and review the result. Use for the reasoning phases; edits run via the agent.turn workflow node.",
  category: "review",
  icon: "users",
  teammates: [
    {
      name: "Architect",
      description: "Owns the target architecture and the ordered, safe refactor plan.",
      systemPrompt:
        "You are the architect on a refactor review board. Turn the analysis into a concrete, ordered, build-green plan: target layering (handler → service → repository with DI), unified config/errors, and the dependency/Go-version upgrade order. Sequence steps so each is independently reviewable; call out risky migrations and how to de-risk them. Argue your plan and converge with the board.",
      iconKey: "compass",
      tags: ["plan"],
    },
    {
      name: "Analyst",
      description: "Surfaces layering, error-handling, and test-gap findings.",
      systemPrompt:
        "You are the analyst on a refactor review board. Read the codebase and surface, with file:line evidence, the layering problems, error-handling gaps, dependency risks, and test gaps that should drive the plan. You may dispatch the go-analyzer subagent for focused package analysis. Be concrete and prioritized.",
      capabilities: { subagentIds: { add: [subagentRuntimeId("go-analyzer")] } },
      iconKey: "microscope",
      tags: ["analyze"],
    },
    {
      name: "Reviewer",
      description: "Reviews the resulting diff and gives the go/no-go verdict.",
      systemPrompt:
        "You are the reviewer on a refactor review board. Review the resulting change for regressions, layering violations, missing tests, and over-engineering. You may dispatch the diff-reviewer subagent. End with APPROVE or REQUEST CHANGES and the blocking items.",
      capabilities: { subagentIds: { add: [subagentRuntimeId("diff-reviewer")] } },
      iconKey: "search-check",
      tags: ["review"],
    },
  ],
  taskTemplates: [
    {
      title: "Analyze the codebase",
      description: "Produce a prioritized findings report (layering, errors, deps, tests).",
      priority: "high",
      assignedToIndex: 1,
    },
    {
      title: "Agree the refactor plan",
      description: "Turn the analysis into an ordered, build-green plan with acceptance criteria.",
      priority: "high",
      assignedToIndex: 0,
    },
    {
      title: "Review the result",
      description: "Review the diff and give a go/no-go verdict with blocking items.",
      priority: "normal",
      assignedToIndex: 2,
    },
  ],
  requires: {
    characterPackIds: [REFACTOR_PACK_ID],
    skillIds: [
      packSkillId("go-clean-architecture"),
      packSkillId("refactor-playbook"),
      packSkillId("backend-infra"),
    ],
    subagentIds: [subagentRuntimeId("go-analyzer"), subagentRuntimeId("diff-reviewer")],
  },
}) satisfies PluginAgentTeamTemplateDef
