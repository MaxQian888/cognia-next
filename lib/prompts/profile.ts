/**
 * Portable prompt profiles (ADR-0236): export the published overrides of
 * code-owned prompt slots, and import them with a preview.
 *
 * A profile carries static template text only, never rendered prompts, and
 * names targets by their local ids. Ids are meaningless on another install, so
 * an import never trusts them: account-scoped entries apply directly, and an
 * entry for a workspace, agent or session applies only to a target the user
 * maps it to. Every entry is re-validated against the definition this build
 * ships, so text written for another contract, or failing the PII gate, is
 * reported instead of activated.
 */

import { z } from "zod"
import { listPromptOverrideBindings, getPromptOverrideRevisions } from "@/lib/db/prompt-overrides"
import { getPromptDefinition } from "./catalog"
import { publishPromptBody, readPromptSlot, shippedBodyDigest } from "./service"
import { validatePromptBody, type PromptValidationIssue } from "./template"
import type { PromptDefinitionV1, PromptScope, PromptTargetRef } from "./types"

export const PROMPT_PROFILE_KIND = "cognia.prompt-profile" as const
export const PROMPT_PROFILE_SCHEMA_VERSION = 1 as const

const scopeSchema = z.enum(["account", "workspace", "agent", "session"])

const entrySchema = z.object({
  promptId: z.string().min(1).max(200),
  scope: scopeSchema,
  targetId: z.string().max(200),
  contractVersion: z.number().int().positive(),
  /** Digest of the shipped body the text was written against. */
  baseDigest: z.string().max(200),
  body: z.string().max(200_000),
})

const profileSchema = z.object({
  kind: z.literal(PROMPT_PROFILE_KIND),
  schemaVersion: z.literal(PROMPT_PROFILE_SCHEMA_VERSION),
  exportedAt: z.string(),
  entries: z.array(entrySchema).max(2_000),
})

export type PromptProfileEntryV1 = z.infer<typeof entrySchema>
export type PromptProfileV1 = z.infer<typeof profileSchema>

export class PromptProfileFormatError extends Error {
  readonly code = "prompt_profile_invalid"
  constructor(message: string) {
    super(message)
    this.name = "PromptProfileFormatError"
  }
}

/** Parse a profile file's text. Throws {@link PromptProfileFormatError} on anything malformed. */
export function parsePromptProfile(text: string): PromptProfileV1 {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new PromptProfileFormatError("not JSON")
  }
  const parsed = profileSchema.safeParse(raw)
  if (!parsed.success) {
    throw new PromptProfileFormatError(
      parsed.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join(".") || "profile"}: ${issue.message}`)
        .join("; ")
    )
  }
  return parsed.data
}

export interface ExportPromptProfileOptions {
  /** Only these scopes; every scope when omitted. */
  scopes?: readonly PromptScope[]
  now?: () => Date
}

/** Every published override in the active account, as a portable profile. */
export async function exportPromptProfile(
  options: ExportPromptProfileOptions = {}
): Promise<PromptProfileV1> {
  const bindings = (await listPromptOverrideBindings()).filter(
    (binding) =>
      binding.activeRevisionId && (!options.scopes || options.scopes.includes(binding.scope))
  )
  const revisions = await getPromptOverrideRevisions(
    bindings.map((binding) => binding.activeRevisionId!)
  )
  const entries: PromptProfileEntryV1[] = []
  bindings.forEach((binding, index) => {
    const revision = revisions[index]
    if (!revision || revision.kind !== "published") return
    entries.push({
      promptId: binding.promptId,
      scope: binding.scope,
      targetId: binding.targetId,
      contractVersion: revision.contractVersion,
      baseDigest: revision.baseDigest,
      body: revision.body,
    })
  })
  entries.sort(
    (a, b) =>
      a.promptId.localeCompare(b.promptId) ||
      a.scope.localeCompare(b.scope) ||
      a.targetId.localeCompare(b.targetId)
  )
  return {
    kind: PROMPT_PROFILE_KIND,
    schemaVersion: PROMPT_PROFILE_SCHEMA_VERSION,
    exportedAt: (options.now?.() ?? new Date()).toISOString(),
    entries,
  }
}

export type PromptImportStatus =
  /** Applies as a new override. */
  | "new"
  /** Replaces a different published override in the same slot. */
  | "replace"
  /** The slot already publishes this exact text. */
  | "unchanged"
  /** This build has no such prompt. */
  | "unknown-prompt"
  /** Written for another contract version of the prompt. */
  | "contract-mismatch"
  /** The prompt cannot be overridden at this scope. */
  | "scope-unsupported"
  /** A workspace / agent / session entry the user has not mapped to a local target. */
  | "needs-target"
  /** Fails the definition's validation (placeholders, fragments, length, PII). */
  | "invalid"

export interface PromptImportPreviewEntry {
  index: number
  entry: PromptProfileEntryV1
  status: PromptImportStatus
  /** The local slot the entry applies to, when it applies at all. */
  target?: PromptTargetRef
  /** The shipped default changed since the text was written; the user should review it. */
  upstreamChanged: boolean
  issues: PromptValidationIssue[]
}

/** Local target id for each `scope:targetId` an entry names. */
export type PromptImportTargetMap = Readonly<Record<string, string>>

export function importTargetKey(entry: Pick<PromptProfileEntryV1, "scope" | "targetId">): string {
  return `${entry.scope}:${entry.targetId}`
}

function applicable(status: PromptImportStatus): boolean {
  return status === "new" || status === "replace"
}

/** What importing `profile` would do, slot by slot. Reads only. */
export async function previewPromptProfileImport(
  profile: PromptProfileV1,
  targetMap: PromptImportTargetMap = {}
): Promise<PromptImportPreviewEntry[]> {
  const preview: PromptImportPreviewEntry[] = []
  for (const [index, entry] of profile.entries.entries()) {
    const def = getPromptDefinition(entry.promptId)
    const base = { index, entry, upstreamChanged: false, issues: [] as PromptValidationIssue[] }
    if (!def) {
      preview.push({ ...base, status: "unknown-prompt" })
      continue
    }
    if (def.operation === "inspect-only" || !def.scopes.includes(entry.scope)) {
      preview.push({ ...base, status: "scope-unsupported" })
      continue
    }
    if (entry.contractVersion !== def.contractVersion) {
      preview.push({ ...base, status: "contract-mismatch" })
      continue
    }
    const target = mapTarget(entry, targetMap)
    if (!target) {
      preview.push({ ...base, status: "needs-target" })
      continue
    }
    const upstreamChanged = entry.baseDigest !== (await shippedBodyDigest(def))
    const issues = validatePromptBody(def, entry.body)
    if (issues.length > 0) {
      preview.push({ ...base, status: "invalid", target, upstreamChanged, issues })
      continue
    }
    const slot = await readPromptSlot(def.id, target)
    const status: PromptImportStatus = !slot.active
      ? "new"
      : slot.active.kind === "published" && slot.active.body === entry.body
        ? "unchanged"
        : "replace"
    preview.push({ ...base, status, target, upstreamChanged })
  }
  return preview
}

function mapTarget(
  entry: PromptProfileEntryV1,
  targetMap: PromptImportTargetMap
): PromptTargetRef | undefined {
  if (entry.scope === "account") return { scope: "account", targetId: "" }
  const mapped = targetMap[importTargetKey(entry)]
  return mapped ? { scope: entry.scope, targetId: mapped } : undefined
}

export interface PromptImportResult {
  applied: number
  /** Entries that changed between preview and apply (a concurrent edit); left untouched. */
  conflicted: PromptImportPreviewEntry[]
}

/**
 * Publish the previewed entries the user selected. Each entry publishes on its
 * own (origin `import`), against the binding revision read now, so a slot
 * edited since the preview is reported as a conflict instead of overwritten.
 */
export async function applyPromptProfileImport(
  preview: readonly PromptImportPreviewEntry[],
  selected: ReadonlySet<number>
): Promise<PromptImportResult> {
  let applied = 0
  const conflicted: PromptImportPreviewEntry[] = []
  for (const item of preview) {
    if (!selected.has(item.index) || !applicable(item.status) || !item.target) continue
    const def = getPromptDefinition(item.entry.promptId) as PromptDefinitionV1
    const slot = await readPromptSlot(def.id, item.target)
    const stillAsPreviewed =
      item.status === "new"
        ? !slot.active
        : Boolean(slot.active) && slot.active?.body !== item.entry.body
    if (!stillAsPreviewed) {
      conflicted.push(item)
      continue
    }
    await publishPromptBody({
      def,
      target: item.target,
      body: item.entry.body,
      expectedRev: slot.binding?.rev ?? 0,
      origin: "import",
    })
    applied += 1
  }
  return { applied, conflicted }
}

/** Serialize a profile for a download, with a stable layout for diffing. */
export function serializePromptProfile(profile: PromptProfileV1): string {
  return `${JSON.stringify(profile, null, 2)}\n`
}
