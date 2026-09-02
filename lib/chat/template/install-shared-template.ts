"use client"

/**
 * Adopt a chat template that arrived over a share link.
 *
 * Deliberately the same shape as the settings panel's "adopt a repository
 * template" path: a NEW row in the local table with a freshly minted id, never
 * a revision of anything. The sender's id names a row in the sender's database
 * and reusing it would collide with a local template the reader already has.
 *
 * The launch spec is whatever `parseSharedChatTemplate` let through, which is
 * the demoted one. Adopting a shared template must not become a way to launder
 * a setup the demotion refused, which is the identical rule
 * `chat-templates-section.tsx` applies when adopting out of a checkout.
 */

import { createChatTemplate, type ChatTemplateRow } from "@/lib/db/chat-templates"
import { parseSharedChatTemplate, type SharedChatTemplate } from "@/lib/share/chat-template"

export interface InstallSharedChatTemplateDeps {
  /** Injected in tests. Production writes through the Dexie table. */
  create?: typeof createChatTemplate
}

/** Write a parsed shared template into the local table. */
export async function installSharedChatTemplate(
  shared: SharedChatTemplate,
  deps: InstallSharedChatTemplateDeps = {}
): Promise<ChatTemplateRow> {
  const create = deps.create ?? createChatTemplate
  return create({
    name: shared.name,
    ...(shared.description ? { description: shared.description } : {}),
    body: shared.body,
    params: shared.params,
    ...(shared.launchSpec ? { launchSpec: shared.launchSpec } : {}),
  })
}

/**
 * Parse a `chat-template` share payload body and adopt it.
 *
 * One entry point for the viewer so the parse (which re-demotes the launch
 * spec) can never be skipped by a caller that happens to hold the raw JSON.
 */
export async function adoptSharedChatTemplatePayload(
  body: string,
  deps: InstallSharedChatTemplateDeps = {}
): Promise<ChatTemplateRow> {
  const shared = parseSharedChatTemplate(body)
  if (!shared) throw new Error("This shared chat template could not be read")
  return installSharedChatTemplate(shared, deps)
}
