import type { EvalConfigurationApplyRow } from "@/lib/db/eval-lab"

export interface EvalConfigurationTarget {
  targetType: EvalConfigurationApplyRow["targetType"]
  targetId: string
}

export interface EvalConfigurationDiffEntry {
  path: string
  before: unknown
  after: unknown
}

export interface EvalConfigurationApplicationDeps {
  read(target: EvalConfigurationTarget): Promise<Record<string, unknown>>
  write(target: EvalConfigurationTarget, value: Record<string, unknown>): Promise<void>
  saveRecord(record: EvalConfigurationApplyRow): Promise<void>
  getRecord(id: string): Promise<EvalConfigurationApplyRow | undefined>
  updateRecord(id: string, patch: Partial<EvalConfigurationApplyRow>): Promise<void>
  now(): number
  newId(): string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical(value[key])])
  )
}

function sameConfiguration(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right))
}

function flattenDiff(
  before: unknown,
  after: unknown,
  path: string,
  output: EvalConfigurationDiffEntry[]
): void {
  if (isRecord(before) && isRecord(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
    for (const key of keys)
      flattenDiff(before[key], after[key], path ? `${path}.${key}` : key, output)
    return
  }
  if (!sameConfiguration(before, after)) output.push({ path, before, after })
}

export function previewConfigurationDiff(
  before: Record<string, unknown>,
  after: Record<string, unknown>
): EvalConfigurationDiffEntry[] {
  const output: EvalConfigurationDiffEntry[] = []
  flattenDiff(before, after, "", output)
  return output
}

export async function applyEvalRecommendation(
  experimentId: string,
  target: EvalConfigurationTarget,
  configuration: Record<string, unknown>,
  deps: EvalConfigurationApplicationDeps
): Promise<EvalConfigurationApplyRow> {
  const previousConfiguration = await deps.read(target)
  const diff = previewConfigurationDiff(previousConfiguration, configuration)
  if (!diff.length) throw new Error("Recommended configuration is already applied")
  const record: EvalConfigurationApplyRow = {
    id: deps.newId(),
    experimentId,
    ...target,
    previousConfiguration: structuredClone(previousConfiguration),
    appliedConfiguration: structuredClone(configuration),
    appliedAt: deps.now(),
  }
  await deps.write(target, record.appliedConfiguration)
  try {
    await deps.saveRecord(record)
  } catch (error) {
    await deps.write(target, record.previousConfiguration)
    throw error
  }
  return record
}

export async function rollbackEvalRecommendation(
  applicationId: string,
  deps: EvalConfigurationApplicationDeps
): Promise<void> {
  const record = await deps.getRecord(applicationId)
  if (!record) throw new Error(`Recommendation application ${applicationId} not found`)
  if (record.rolledBackAt) throw new Error("Recommendation application was already rolled back")
  const target = { targetType: record.targetType, targetId: record.targetId }
  const current = await deps.read(target)
  if (!sameConfiguration(current, record.appliedConfiguration)) {
    throw new Error("Target configuration changed after recommendation application")
  }
  await deps.write(target, record.previousConfiguration)
  await deps.updateRecord(record.id, { rolledBackAt: deps.now() })
}
