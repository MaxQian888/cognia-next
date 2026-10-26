/**
 * The plugin contract's share of `lib/prompts/plugin-prompts.ts`, which re-exports these.
 */
import type { PromptGroup, PromptVariableSpec } from "./types"

/** What a plugin declares for one prompt. */
export interface PluginPromptDeclaration {
  /** Unique within the plugin. */
  id: string
  /** Shown in the Prompt Center; plugins localize it themselves. */
  title: string
  description?: string
  /** The plugin's own default, exactly as it sends it with no override. */
  defaultBody: string
  /** Bump when the variables, fragments or output contract change. Defaults to 1. */
  contractVersion?: number
  variables?: readonly PromptVariableSpec[]
  requiredFragments?: readonly string[]
  outputContract?: string
  maxChars?: number
  /** Where the entry is grouped; `agents` when omitted. */
  group?: PromptGroup
}
