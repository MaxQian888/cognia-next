// Saved chat templates: a message body with `{{parameter}}` tokens, plus the
// declarations that give those tokens labels and say which are required.
//
// Account-wide, not workspace-scoped. A phrase you reuse belongs to you, not to
// whichever repository happened to be open when you saved it; templates that
// belong to a repository travel IN the repository (ADR-0147's declared-workspace
// file), which is a different source entirely.
//
// Device-local for now: this table has no `lib/sync` handler, so a template
// saved here does not follow the account to another device. Nothing depends on
// it doing so — a template that is missing simply is not offered — but it is a
// real limit, not an oversight.

import { getDb } from "./schema"
import { deriveParams, templateSlug, type ChatTemplateParam } from "@/lib/chat/template/template"
import type { ChatTemplateParamValue } from "@/lib/chat/template/binding"
import type { ChatTemplateLaunchSpec } from "@/lib/chat/template/launch-spec"

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

/** What a caller supplies to create one. Declarations are derived when absent. */
export interface ChatTemplateDraft {
  name: string
  description?: string
  body: string
  params?: ChatTemplateParam[]
  launchSpec?: ChatTemplateLaunchSpec
}

function newId(name: string): string {
  // The random tail is load-bearing, not decoration: the table is keyed `&id`,
  // and a timestamp alone collides for two templates saved in the same
  // millisecond — which silently overwrites the first. Same shape as
  // `prompt-presets.ts`.
  const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  return `tpl_${templateSlug(name)}_${suffix}`
}

/** Newest-first, which is the order the picker offers them in. */
export async function listChatTemplates(): Promise<ChatTemplateRow[]> {
  const rows = await getDb().chatTemplates.toArray()
  return rows.sort((a, b) => (b.lastUsedAt ?? b.updatedAt) - (a.lastUsedAt ?? a.updatedAt))
}

export async function getChatTemplate(id: string): Promise<ChatTemplateRow | undefined> {
  return getDb().chatTemplates.get(id)
}

export async function createChatTemplate(draft: ChatTemplateDraft): Promise<ChatTemplateRow> {
  const now = Date.now()
  const row: ChatTemplateRow = {
    id: newId(draft.name),
    name: draft.name,
    ...(draft.description ? { description: draft.description } : {}),
    body: draft.body,
    // Derived from the body when the caller did not declare them, which is what
    // makes "save what I just wrote" work without a form in the way first.
    params: draft.params ?? deriveParams(draft.body),
    ...(draft.launchSpec ? { launchSpec: draft.launchSpec } : {}),
    revision: 1,
    usageCount: 0,
    createdAt: now,
    updatedAt: now,
  }
  await getDb().chatTemplates.put(row)
  return row
}

/**
 * Edit a template's content.
 *
 * Bumps `revision` only when something a message would notice actually
 * changed — the body or the declarations. Renaming a template or fixing its
 * description does not invalidate the drafts that quoted it, and bumping for
 * those would make every open draft claim to be out of date.
 */
export async function updateChatTemplate(
  id: string,
  patch: Partial<Pick<ChatTemplateRow, "name" | "description" | "body" | "params" | "launchSpec">>
): Promise<ChatTemplateRow | undefined> {
  const db = getDb()
  const current = await db.chatTemplates.get(id)
  if (!current) return undefined
  const body = patch.body ?? current.body
  const params =
    patch.params ?? (patch.body !== undefined ? deriveParams(body, current.params) : current.params)
  const contentChanged =
    body !== current.body || JSON.stringify(params) !== JSON.stringify(current.params)
  const next: ChatTemplateRow = {
    ...current,
    ...patch,
    body,
    params,
    revision: contentChanged ? current.revision + 1 : current.revision,
    updatedAt: Date.now(),
  }
  await db.chatTemplates.put(next)
  return next
}

/**
 * Record a use, remembering the values supplied.
 *
 * Best-effort by design: losing the "last used" counters must never take down
 * the send that just succeeded, so callers fire this without awaiting it.
 */
export async function recordChatTemplateUse(
  id: string,
  params: Record<string, ChatTemplateParamValue>
): Promise<void> {
  const db = getDb()
  const current = await db.chatTemplates.get(id)
  if (!current) return
  await db.chatTemplates.put({
    ...current,
    lastParams: params,
    usageCount: current.usageCount + 1,
    lastUsedAt: Date.now(),
  })
}

export async function deleteChatTemplate(id: string): Promise<void> {
  await getDb().chatTemplates.delete(id)
}
