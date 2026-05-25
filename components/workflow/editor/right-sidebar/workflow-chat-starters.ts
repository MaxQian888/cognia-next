import { CheckCircle2Icon, HelpCircleIcon, LightbulbIcon, WorkflowIcon } from "lucide-react"
import type { StarterSample } from "@/components/chat/empty-state"

/**
 * Workflow-specific starter cards for the editor chat tab's empty state.
 *
 * Replaces the generic dev-tool starters (explore project / git diff / commit
 * message / run tests) with flows that make sense against a workflow graph.
 * Each card sends a natural-language prompt through the same workflow send
 * path the composer uses, so the workflow Copilot (subagents + `wf_*` tools
 * injected by `resolveSendOptions`) can read and act on the current graph.
 *
 * Pulled out of `chat-tab.tsx` so it's unit-testable without rendering the
 * Tauri/Dexie-dependent component — mirrors the `applyWorkflowMentionExpansion`
 * / `dispatchWorkflowAction` extraction in the same directory.
 *
 * @param t  `next-intl` translate fn scoped to `workflowEditor.chat`.
 */
export function buildWorkflowChatStarters(t: (key: string) => string): StarterSample[] {
  return [
    {
      key: "build",
      icon: WorkflowIcon,
      title: t("starters.buildTitle"),
      prompt: t("starters.buildPrompt"),
    },
    {
      key: "explain",
      icon: HelpCircleIcon,
      title: t("starters.explainTitle"),
      prompt: t("starters.explainPrompt"),
    },
    {
      key: "validate",
      icon: CheckCircle2Icon,
      title: t("starters.validateTitle"),
      prompt: t("starters.validatePrompt"),
    },
    {
      key: "suggest",
      icon: LightbulbIcon,
      title: t("starters.suggestTitle"),
      prompt: t("starters.suggestPrompt"),
    },
  ]
}
