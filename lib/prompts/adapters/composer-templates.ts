/**
 * Chat templates as a linked Prompt Center category (ADR-0236 §3.1).
 *
 * A template is text the user inserts into the composer as their own message,
 * never a system instruction, so it is listed for discovery and read here but
 * edited only in Chat templates, its owner, which keeps parameters, launch
 * specs and revisions consistent.
 */

import { getChatTemplate, listChatTemplates } from "@/lib/db/chat-templates"
import {
  parseResourceKey,
  resourceKey,
  type OwnerPromptAdapter,
  type PromptResourceSummary,
} from "../resources"

export const composerTemplatePromptAdapter: OwnerPromptAdapter = {
  source: "composer-template",

  async list() {
    const templates = await listChatTemplates()
    return templates.map((template): PromptResourceSummary => ({
      key: resourceKey("composer-template", template.id),
      source: "composer-template",
      kind: "composer-template",
      operation: "inspect-only",
      name: template.name,
      builtIn: false,
      modified: false,
      edit: "owner-only",
      ownerSection: "chatTemplates",
      ...(template.description ? { detail: template.description } : {}),
    }))
  },

  async read(key) {
    const { source, id } = parseResourceKey(key)
    if (source !== "composer-template") return undefined
    const template = await getChatTemplate(id)
    return template ? { key, text: template.body } : undefined
  },
}
