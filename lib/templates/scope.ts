/**
 * Which shelf of the library a template sits on, and whether this workspace
 * sees it at all.
 *
 * Two independent questions, kept apart on purpose.
 *
 * OWNERSHIP is `TemplateDefinitionRow.workspaceId`. A definition with one
 * belongs to that workspace and does not exist anywhere else. It is stored on
 * the local row rather than in the envelope so it never reaches an export, a
 * package or a content hash, which is what keeps a confined template portable
 * the moment someone shares it.
 *
 * VISIBILITY is the workspace capability overlay. It only ever applies to
 * SHARED definitions: a built-in, a plugin's, a marketplace one. "I would
 * rather not see this here" is a preference, not a claim about who made the
 * thing, and answering both with one flag is how a library starts lying.
 *
 * The tier is derived from `provenance.source`, which is a closed enum, plus
 * ownership. Deliberately NOT from `metadata.author` (free text a package
 * author controls) or from a node group's `distribution.scope` (real, but
 * workflow-only, so it labels rather than decides).
 */

import type { TemplateDefinitionEnvelope } from "./contracts"

/** The shelves the library is grouped into, in the order they are offered. */
export const TEMPLATE_SCOPE_TIERS = [
  "workspace",
  "mine",
  "builtin",
  "plugin",
  "marketplace",
] as const

export type TemplateScopeTier = (typeof TEMPLATE_SCOPE_TIERS)[number]

/**
 * Ownership wins over provenance: a built-in you forked and confined to one
 * workspace is that workspace's, not a built-in.
 */
export function templateScopeTier(
  definition: TemplateDefinitionEnvelope,
  ownerWorkspaceId?: string
): TemplateScopeTier {
  if (ownerWorkspaceId !== undefined) return "workspace"
  switch (definition.provenance.source) {
    case "built-in":
      return "builtin"
    case "plugin":
      return "plugin"
    case "marketplace":
    case "link":
      return "marketplace"
    default:
      // `user`, `file` and `legacy` are all "something in my own library".
      return "mine"
  }
}

export interface TemplateVisibilityInput {
  definition: TemplateDefinitionEnvelope
  /** The workspace that owns it, from `listTemplateOwners`. */
  ownerWorkspaceId?: string
  /** The active workspace. Nothing is filtered while this is unknown. */
  activeWorkspaceId?: string | null
  /** The active workspace's overlay position for this definition id. */
  hiddenHere?: boolean
}

/**
 * Whether this workspace should list the definition.
 *
 * An owned definition is invisible outside its workspace, full stop. A shared
 * one is visible unless the workspace has said otherwise. With no active
 * workspace nothing is hidden, because a filter nobody asked for that removes
 * rows silently is worse than no filter at all.
 */
export function isTemplateVisibleInWorkspace({
  ownerWorkspaceId,
  activeWorkspaceId,
  hiddenHere,
}: TemplateVisibilityInput): boolean {
  if (!activeWorkspaceId) return true
  if (ownerWorkspaceId !== undefined) return ownerWorkspaceId === activeWorkspaceId
  return hiddenHere !== true
}
