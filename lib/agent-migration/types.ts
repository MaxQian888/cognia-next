import type { SettingsImportMergeStrategy } from "@/lib/settings-import"

export const MIGRATION_VENDORS = ["claude-code", "codex", "opencode"] as const
export type MigrationVendor = (typeof MIGRATION_VENDORS)[number]

export const MIGRATION_ARTIFACTS = [
  "settings",
  "sessions",
  "skills",
  "subagents",
  "mcp",
  "commands",
  "memory",
] as const
export type MigrationArtifact = (typeof MIGRATION_ARTIFACTS)[number]
export type MigrationArtifactStatus = "ready" | "shared" | "empty" | "unsupported" | "error"

export interface MigrationVendorProbe {
  vendor: MigrationVendor
  installed: boolean
  configPath?: string
}

export interface MigrationPreviewCell {
  artifact: MigrationArtifact
  status: MigrationArtifactStatus
  count: number
  warnings: string[]
  /** Opaque items owned by the delegated artifact subsystem. */
  items: unknown[]
  metadata?: unknown
}

export interface MigrationPreview {
  vendor: MigrationVendor
  artifacts: Partial<Record<MigrationArtifact, MigrationPreviewCell>>
}

export interface MigrationPlan {
  vendor: MigrationVendor
  artifacts: MigrationArtifact[]
  strategy: SettingsImportMergeStrategy
  preview: MigrationPreview
  cwd?: string
  projectId?: string
}

export interface MigrationArtifactResult {
  imported: number
  updated?: number
  skipped?: number
  warnings: string[]
  error?: string
}

export interface MigrationResult {
  vendor: MigrationVendor
  aborted: boolean
  artifacts: Partial<Record<MigrationArtifact, MigrationArtifactResult>>
}

export interface MigrationProgress {
  artifact: MigrationArtifact
  phase: "started" | "completed" | "failed"
  done: number
  total: number
}

export function isMigrationVendor(value: unknown): value is MigrationVendor {
  return typeof value === "string" && (MIGRATION_VENDORS as readonly string[]).includes(value)
}
