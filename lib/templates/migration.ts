import { sha256Hex } from "@/lib/share/hash"
import type { CreateTemplateDraftInput, TemplateService } from "./service"
import type { TemplateJson, TemplateDomain } from "./contracts"
import { canonicalTemplateStringify } from "./contracts"
import type { TemplateMigrationJournalRecord, TemplateRepository } from "./repository"

export interface LegacyTemplateSource<Row = unknown> {
  domain: TemplateDomain
  read(): Promise<readonly Row[]>
  sourceKey(row: Row): string
  convert(row: Row): Promise<CreateTemplateDraftInput> | CreateTemplateDraftInput
}

export interface TemplateMigrationJournalStore {
  list(domain?: string): Promise<TemplateMigrationJournalRecord[]>
  put(record: TemplateMigrationJournalRecord): Promise<void>
}

export interface TemplateMigrationReport {
  examined: number
  migrated: number
  skipped: number
  quarantined: number
}

function portableSnapshot(value: unknown): TemplateJson {
  return JSON.parse(JSON.stringify(value)) as TemplateJson
}

function deterministicDefinitionId(domain: TemplateDomain, sourceKey: string): string {
  const normalized = sourceKey
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
  return `legacy.${domain}.${normalized || "item"}`
}

async function sourceFingerprint(value: unknown): Promise<string> {
  return sha256Hex(canonicalTemplateStringify(portableSnapshot(value)))
}

export async function migrateLegacyTemplates(input: {
  sources: readonly LegacyTemplateSource[]
  service: Pick<TemplateService, "createDraft" | "validate" | "hydrateCatalog">
  repository: Pick<TemplateRepository, "getDraft">
  journal: TemplateMigrationJournalStore
  now?: () => number
}): Promise<TemplateMigrationReport> {
  const now = input.now ?? Date.now
  const report: TemplateMigrationReport = {
    examined: 0,
    migrated: 0,
    skipped: 0,
    quarantined: 0,
  }
  for (const source of input.sources) {
    const previous = new Map(
      (await input.journal.list(source.domain)).map((record) => [record.sourceKey, record])
    )
    for (const row of await source.read()) {
      report.examined += 1
      const key = source.sourceKey(row)
      const fingerprint = await sourceFingerprint(row)
      const journalId = `${source.domain}:${key}`
      const prior = previous.get(key)
      if (prior?.status === "completed" && prior.sourceFingerprint === fingerprint) {
        report.skipped += 1
        continue
      }
      try {
        const converted = await source.convert(row)
        const definitionId = converted.id || deterministicDefinitionId(source.domain, key)
        if (await input.repository.getDraft(definitionId)) {
          await input.journal.put({
            id: journalId,
            domain: source.domain,
            sourceKey: key,
            status: "completed",
            sourceFingerprint: fingerprint,
            targetDefinitionId: definitionId,
            rollbackSnapshot: portableSnapshot(row),
            updatedAt: now(),
          })
          report.skipped += 1
          continue
        }
        const definition = await input.service.createDraft({
          ...converted,
          id: definitionId,
          domain: source.domain,
        })
        const validation = input.service.validate(definition)
        if (!validation.ok) {
          throw new Error(
            validation.issues
              .filter((issue) => issue.severity === "error")
              .map((issue) => `${issue.path}: ${issue.message}`)
              .join("; ")
          )
        }
        await input.journal.put({
          id: journalId,
          domain: source.domain,
          sourceKey: key,
          status: "completed",
          sourceFingerprint: fingerprint,
          targetDefinitionId: definition.id,
          rollbackSnapshot: portableSnapshot(row),
          updatedAt: now(),
        })
        report.migrated += 1
      } catch (error) {
        await input.journal.put({
          id: journalId,
          domain: source.domain,
          sourceKey: key,
          status: "quarantined",
          sourceFingerprint: fingerprint,
          rollbackSnapshot: portableSnapshot(row),
          diagnostics: [error instanceof Error ? error.message : String(error)],
          updatedAt: now(),
        })
        report.quarantined += 1
      }
    }
  }
  await input.service.hydrateCatalog()
  return report
}

export async function rollbackTemplateMigration(input: {
  domain: TemplateDomain
  repository: Pick<TemplateRepository, "deleteDraft">
  journal: TemplateMigrationJournalStore
  now?: () => number
}): Promise<number> {
  const now = input.now ?? Date.now
  const rows = await input.journal.list(input.domain)
  let rolledBack = 0
  for (const row of rows) {
    if (row.status !== "completed" || !row.targetDefinitionId) continue
    await input.repository.deleteDraft(row.targetDefinitionId)
    await input.journal.put({ ...row, status: "rolled-back", updatedAt: now() })
    rolledBack += 1
  }
  return rolledBack
}
