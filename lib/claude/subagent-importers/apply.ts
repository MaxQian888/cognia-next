// Apply subagent import drafts to cognia-next storage.
//
// Two targets:
//   - "subagent-template" → useSubagentRuntimeStore.addTemplate / updateTemplate
//   - "character"         → lib/db/characters.createCharacter / updateCharacter
//
// Three merge strategies (per draft, applied independently):
//   - skip:      if a row with the same name (case-insensitive) exists, do nothing
//   - overwrite: replace the existing row's content (built-ins are protected and
//                surface as `failed`)
//   - duplicate: always create a new row, suffixing the name with " (n)" until
//                it is unique

import { useSubagentRuntimeStore } from "@/stores/agent/subagent-runtime-store"
import { createCharacter, listCharacters, updateCharacter } from "@/lib/db/characters"

import { toCharacterDraft, toSubagentTemplate } from "./convert"
import type {
  ApplyImportArgs,
  ApplyImportResult,
  ImportMergeStrategy,
  SubagentImportDraft,
} from "./types"

function nextAvailableName(base: string, taken: Set<string>): string {
  if (!taken.has(base.toLowerCase())) return base
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base} (${i})`
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
  // Pathological fallback — should never hit.
  return `${base} (${Date.now()})`
}

/** Apply for SubAgentTemplate target. */
async function applyToTemplates(
  drafts: SubagentImportDraft[],
  strategy: ImportMergeStrategy
): Promise<ApplyImportResult> {
  const result: ApplyImportResult = {
    imported: 0,
    skipped: 0,
    overwritten: 0,
    failed: [],
  }
  const store = useSubagentRuntimeStore.getState()
  const existingByName = new Map<string, { id: string; isBuiltIn: boolean }>()
  for (const tpl of Object.values(store.templates)) {
    existingByName.set(tpl.name.toLowerCase(), {
      id: tpl.id,
      isBuiltIn: tpl.isBuiltIn ?? false,
    })
  }
  const takenNames = new Set(existingByName.keys())

  for (const draft of drafts) {
    try {
      const lcName = draft.name.toLowerCase()
      const existing = existingByName.get(lcName)
      const tpl = toSubagentTemplate(draft)

      if (!existing) {
        store.addTemplate(tpl)
        existingByName.set(lcName, { id: tpl.id, isBuiltIn: false })
        takenNames.add(lcName)
        result.imported += 1
        continue
      }

      if (strategy === "skip") {
        result.skipped += 1
        continue
      }

      if (strategy === "overwrite") {
        if (existing.isBuiltIn) {
          result.failed.push({
            name: draft.name,
            error: "Cannot overwrite a built-in template — duplicate instead.",
          })
          continue
        }
        // Re-use the existing id so the row is updated in place.
        const { id: _ignored, ...patch } = tpl
        store.updateTemplate(existing.id, patch)
        result.overwritten += 1
        continue
      }

      // strategy === "duplicate"
      const uniqueName = nextAvailableName(draft.name, takenNames)
      store.addTemplate({ ...tpl, name: uniqueName })
      takenNames.add(uniqueName.toLowerCase())
      result.imported += 1
    } catch (err) {
      result.failed.push({
        name: draft.name,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return result
}

/** Apply for Character target. */
async function applyToCharacters(
  drafts: SubagentImportDraft[],
  strategy: ImportMergeStrategy
): Promise<ApplyImportResult> {
  const result: ApplyImportResult = {
    imported: 0,
    skipped: 0,
    overwritten: 0,
    failed: [],
  }
  const existing = await listCharacters()
  const existingByName = new Map<string, { id: string; isBuiltIn: boolean }>()
  for (const c of existing) {
    existingByName.set(c.name.toLowerCase(), {
      id: c.id,
      isBuiltIn: c.isBuiltIn ?? false,
    })
  }
  const takenNames = new Set(existingByName.keys())

  for (const draft of drafts) {
    try {
      const lcName = draft.name.toLowerCase()
      const found = existingByName.get(lcName)
      const charDraft = toCharacterDraft(draft)

      if (!found) {
        const created = await createCharacter(charDraft)
        existingByName.set(lcName, { id: created.id, isBuiltIn: false })
        takenNames.add(lcName)
        result.imported += 1
        continue
      }

      if (strategy === "skip") {
        result.skipped += 1
        continue
      }

      if (strategy === "overwrite") {
        if (found.isBuiltIn) {
          result.failed.push({
            name: draft.name,
            error: "Cannot overwrite a built-in character — duplicate instead.",
          })
          continue
        }
        await updateCharacter(found.id, charDraft)
        result.overwritten += 1
        continue
      }

      // strategy === "duplicate"
      const uniqueName = nextAvailableName(draft.name, takenNames)
      const created = await createCharacter({ ...charDraft, name: uniqueName })
      existingByName.set(uniqueName.toLowerCase(), {
        id: created.id,
        isBuiltIn: false,
      })
      takenNames.add(uniqueName.toLowerCase())
      result.imported += 1
    } catch (err) {
      result.failed.push({
        name: draft.name,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return result
}

/**
 * Apply a batch of subagent import drafts to the chosen target. Failures on
 * individual drafts go into `failed[]` rather than aborting the batch.
 */
export async function applySubagentImport(args: ApplyImportArgs): Promise<ApplyImportResult> {
  if (args.target === "subagent-template") {
    return applyToTemplates(args.drafts, args.strategy)
  }
  return applyToCharacters(args.drafts, args.strategy)
}
