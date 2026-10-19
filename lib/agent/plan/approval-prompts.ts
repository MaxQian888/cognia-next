/**
 * The implementing turn sent after a direct-chat plan is approved (ADR-0236).
 *
 * Two editable templates, both resolved in the plan's session and workspace:
 *
 *  - `agent.plan.approved`: the plan is still in the model's transcript as it
 *    proposed it, so the turn points at "the plan above";
 *  - `agent.plan.approved-edited`: the user ADJUSTED the plan during review
 *    (`metadata.userEdited`), so the transcript holds a stale proposal and the
 *    turn embeds the approved version instead — the same embed-the-plan
 *    pattern as the CLI's `PLAN_EXECUTE_PROMPT`.
 *
 * The CLI's own approval turn (`cli/src/tui/runtime/plan.ts`) is different
 * wording for a different flow (it always embeds the reviewed text), so it is
 * not this definition.
 */

import { resolvePromptAsync } from "@/lib/prompts/resolve"
import { definePrompt, type PromptResolutionContext } from "@/lib/prompts/types"
import type { AgentPlan } from "@/types/agent/plan"

const APPROVAL_PROMPT_CONSUMERS = ["lib/agent/plan/approval-prompts.ts"] as const
/** A plan's text is uncapped today; far above any plan a person reviews. */
const PLAN_TEXT_MAX = 200_000

/** The synthetic turn injected after a plan is approved as proposed. */
export const PLAN_APPROVED_PROMPT = definePrompt({
  id: "agent.plan.approved",
  contractVersion: 1,
  kind: "feature-template",
  group: "agents",
  operation: "replace-template",
  scopes: ["account", "workspace", "session"],
  activation: "next-operation",
  risk: "ordinary",
  hosts: ["app"],
  maxChars: 4_000,
  outputContract:
    "Sent as a fresh user turn (no optimistic bubble) once the plan is approved, in the permission mode the user picked; a failed send is kept for retry with the same text.",
  consumers: APPROVAL_PROMPT_CONSUMERS,
  defaultBody: "The plan above is approved. Implement it now, step by step, following the plan.",
})

/** The synthetic turn injected after a plan the user adjusted is approved. */
export const PLAN_APPROVED_EDITED_PROMPT = definePrompt({
  id: "agent.plan.approved-edited",
  contractVersion: 1,
  kind: "feature-template",
  group: "agents",
  operation: "replace-template",
  scopes: ["account", "workspace", "session"],
  activation: "next-operation",
  risk: "ordinary",
  hosts: ["app"],
  maxChars: 4_000,
  variables: [
    { name: "title", required: true, maxChars: PLAN_TEXT_MAX },
    { name: "plan", required: true, maxChars: PLAN_TEXT_MAX },
  ],
  outputContract:
    "Sent as a fresh user turn once an adjusted plan is approved. {{title}} is the plan title; {{plan}} is the approved plan text, or its steps numbered in order when it has none.",
  consumers: APPROVAL_PROMPT_CONSUMERS,
  defaultBody: [
    "The plan is approved, but the user ADJUSTED it during review — the approved version below supersedes the plan you proposed earlier. Where they differ, follow the version below.",
    "",
    "# {{title}}",
    "",
    "{{plan}}",
    "",
    "Implement it now, step by step, following the approved plan above.",
  ].join("\n"),
})

/** The base approval turn, as the Prompt Center resolves it for `context`. */
export async function resolvePlanApprovedPrompt(
  context: PromptResolutionContext = {}
): Promise<string> {
  return (await resolvePromptAsync(PLAN_APPROVED_PROMPT, { context })).text
}

/**
 * The approval turn for `plan`: the base one, or — when the user adjusted the
 * plan during review — one that embeds the approved version.
 */
export async function buildPlanApprovedPrompt(
  plan: AgentPlan,
  context: PromptResolutionContext = {}
): Promise<string> {
  if (!plan.metadata?.userEdited) return resolvePlanApprovedPrompt(context)
  const meta = plan.metadata as { planText?: unknown }
  const planText = typeof meta.planText === "string" ? meta.planText.trim() : ""
  const body =
    planText ||
    [...plan.steps]
      .sort((a, b) => a.order - b.order)
      .map((s, i) => `${i + 1}. ${s.title}`)
      .join("\n")
  return (
    await resolvePromptAsync(PLAN_APPROVED_EDITED_PROMPT, {
      context,
      values: { title: plan.title, plan: body },
    })
  ).text
}
