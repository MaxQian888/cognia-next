/**
 * The plugin contract's share of `lib/db/chat-templates.ts`, which re-exports these.
 */
import type { ChatTemplateLaunchSpec } from "../chat/template/launch-spec"
import type { ChatTemplateParam } from "../chat/template/template"
import type { ChatTemplateParamValue } from "../chat/template/binding"

export interface ChatTemplateRow {
  id: string
  name: string
  description?: string
  /** Message body, carrying `{{parameter}}` tokens. */
  body: string
  params: ChatTemplateParam[]
  /**
   * The session configuration this template expects — agent, team, repository,
   * model, mode.
   *
   * A suggestion, never an instruction. Inserting a template into a
   * conversation that already runs on something else changes nothing; the
   * composer offers to start a new conversation instead. Silently re-pointing
   * a conversation someone is already in makes its own history unreadable.
   */
  launchSpec?: ChatTemplateLaunchSpec
  /**
   * Bumped on every content edit.
   *
   * A draft records the revision it was inserted at and never follows: editing
   * a template must not silently rewrite a message someone is halfway through,
   * and a re-run whose body moved underneath it is a result nobody can explain.
   */
  revision: number
  /**
   * What the parameters were set to last time this template was used.
   *
   * Pre-filled on the next insert, because in practice nine uses out of ten
   * repeat most of the values. A remembered value is offered as-is, including a
   * reference: the composer paints one that no longer resolves as unresolved
   * (`paramState`) rather than dropping it, because a chip the user can see and
   * re-pick beats a field that silently emptied itself between two uses of the
   * same template.
   */
  lastParams?: Record<string, ChatTemplateParamValue>
  usageCount: number
  lastUsedAt?: number
  createdAt: number
  updatedAt: number
}
