/**
 * The code-owned prompt catalog (ADR-0236).
 *
 * A list of references to definitions that live with their owners; it is not
 * a second home for any prompt text. Every entry here has a real consumer
 * that resolves it (see each definition's `consumers`), and the catalog test
 * fails on a duplicate id, a default that does not validate against its own
 * contract, or a definition nothing resolves.
 *
 * Imported by the Prompt Center and the CLI `prompts` command only, never on
 * a send path: consumers import their own definition directly.
 */

import { BRIEF_MODE_PROMPT } from "@/lib/agent/prompts/brief-mode"
import { CLI_BASE_IDENTITY_PROMPT } from "@/lib/agent/prompts/cli-base"
import { PLAN_MODE_PROMPT, PLAN_MODE_STRUCTURED_STEPS_PROMPT } from "@/lib/agent/prompts/plan-mode"
import { CANVAS_ACTION_PROMPTS } from "@/lib/ai/generation/canvas-actions"
import { SELECTION_SUMMARY_PROMPT } from "@/lib/ai/generation/summarize-material"
import { CONVERSATION_SUMMARY_PROMPT } from "@/lib/ai/generation/summarizer"
import { TITLE_CHAT_PROMPT, TITLE_WORK_PROMPT } from "@/lib/ai/generation/title"
import { ENHANCE_STYLE_PROMPTS, ENHANCE_SYSTEM_PROMPT } from "@/lib/chat/completion/enhance"
import { GHOST_TEXT_PROMPT } from "@/lib/chat/completion/ghost-prompt"
import {
  GOAL_CONTINUATION_PROMPT,
  GOAL_JUDGE_PROMPT,
  GOAL_OBJECTIVE_UPDATED_PROMPT,
  GOAL_PROMISE_VERIFICATION_PROMPT,
  GOAL_SUBGOALS_PROMPT,
  GOAL_SYSTEM_SECTION_PROMPT,
} from "@/lib/goal/prompts"
import {
  FOLLOW_UP_SUGGESTIONS_PROMPT,
  STARTER_SUGGESTIONS_PROMPT,
} from "@/lib/chat/completion/suggestions"
import { DIFF_REVIEW_PROMPT } from "@/lib/git/ai-review"
import {
  ISSUE_DRAFT_PROMPT,
  ISSUE_IMPROVE_PROMPT,
  ISSUE_METADATA_PROMPT,
  ISSUE_RELATIONS_PROMPT,
  ISSUE_TITLE_PROMPT,
} from "@/lib/issues/ai-issue-assist"
import { RADAR_SYSTEM_PROMPT } from "@/lib/radar/prompts"
import { TERMINAL_COMPLETION_PROMPT } from "@/lib/terminal/completion/prompt"
import {
  EVALUATOR_PROMPT,
  KNOWLEDGE_AGENT_PROMPT,
  PLAYBOOK_AGENT_PROMPT,
  STYLE_AGENT_PROMPT,
  SYNTHESIZER_PROMPT,
} from "@/lib/twin/distill/prompts"
import { WIKI_SYSTEM_VOICE_PROMPT } from "@/lib/wiki/prompts"
import {
  COMPACT_HANDOFF_PROMPT,
  POST_COMPACTION_RECOVERY_PROMPT,
} from "@/lib/claude/compact-instructions"
import type { PromptDefinitionV1 } from "./types"

export const PROMPT_DEFINITIONS: readonly PromptDefinitionV1[] = [
  // chat
  BRIEF_MODE_PROMPT,
  COMPACT_HANDOFF_PROMPT,
  POST_COMPACTION_RECOVERY_PROMPT,
  CLI_BASE_IDENTITY_PROMPT,
  // agents
  PLAN_MODE_PROMPT,
  PLAN_MODE_STRUCTURED_STEPS_PROMPT,
  // generation
  TITLE_CHAT_PROMPT,
  TITLE_WORK_PROMPT,
  CONVERSATION_SUMMARY_PROMPT,
  SELECTION_SUMMARY_PROMPT,
  ...Object.values(CANVAS_ACTION_PROMPTS),
  // completion
  GHOST_TEXT_PROMPT,
  STARTER_SUGGESTIONS_PROMPT,
  FOLLOW_UP_SUGGESTIONS_PROMPT,
  ENHANCE_SYSTEM_PROMPT,
  ...Object.values(ENHANCE_STYLE_PROMPTS),
  TERMINAL_COMPLETION_PROMPT,
  // goals
  GOAL_SYSTEM_SECTION_PROMPT,
  GOAL_JUDGE_PROMPT,
  GOAL_SUBGOALS_PROMPT,
  GOAL_CONTINUATION_PROMPT,
  GOAL_PROMISE_VERIFICATION_PROMPT,
  GOAL_OBJECTIVE_UPDATED_PROMPT,
  // twin
  STYLE_AGENT_PROMPT,
  PLAYBOOK_AGENT_PROMPT,
  KNOWLEDGE_AGENT_PROMPT,
  SYNTHESIZER_PROMPT,
  EVALUATOR_PROMPT,
  // knowledge
  WIKI_SYSTEM_VOICE_PROMPT,
  RADAR_SYSTEM_PROMPT,
  // developer
  DIFF_REVIEW_PROMPT,
  ISSUE_DRAFT_PROMPT,
  ISSUE_IMPROVE_PROMPT,
  ISSUE_METADATA_PROMPT,
  ISSUE_TITLE_PROMPT,
  ISSUE_RELATIONS_PROMPT,
]

const BY_ID = new Map<string, PromptDefinitionV1>()
for (const def of PROMPT_DEFINITIONS) {
  if (BY_ID.has(def.id)) throw new Error(`duplicate prompt definition id: ${def.id}`)
  BY_ID.set(def.id, def)
}

export function getPromptDefinition(id: string): PromptDefinitionV1 | undefined {
  return BY_ID.get(id)
}

export function listPromptDefinitions(): readonly PromptDefinitionV1[] {
  return PROMPT_DEFINITIONS
}
