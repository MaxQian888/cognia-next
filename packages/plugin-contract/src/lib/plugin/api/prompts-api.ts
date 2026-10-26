/**
 * The plugin contract's share of `lib/plugin/api/prompts-api.ts`, which re-exports these.
 */
import type { PluginPromptDeclaration } from "../../prompts/plugin-prompts"

export interface PluginPromptRegistration {
  /** The namespaced ids, `plugin:<pluginId>/<id>`. */
  promptIds: string[]
  /** Remove exactly these prompts. Idempotent. */
  unregister(): void
}

export interface PluginPromptResolveOptions {
  /** Values for the declared `{{name}}` placeholders. */
  values?: Record<string, string>
  /** The chat the call belongs to; its workspace's override applies. */
  sessionId?: string
}

export interface PluginResolvedPrompt {
  text: string
  /** Whether the user's override or the plugin's default was used. */
  source: "default" | "override"
}

export interface PluginPromptsAPI {
  /** Declare prompts as Prompt Center slots. Replaces earlier ones with the same ids. */
  register(declarations: readonly PluginPromptDeclaration[]): PluginPromptRegistration
  /** The text to send for one of this plugin's registered prompts. */
  resolve(id: string, options?: PluginPromptResolveOptions): Promise<PluginResolvedPrompt>
}
