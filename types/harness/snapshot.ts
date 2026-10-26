/**
 * Harness snapshots (ADR-0237).
 *
 * A snapshot is the editable harness one run used, frozen and content
 * addressed: the eight components plus the execution configuration they ran
 * with. The execution part is recorded so runs are reproducible and caches can
 * be invalidated, but evolution can never edit it.
 */

import type {
  HarnessSubagentDefinition,
  HarnessToolRule,
} from "@cognia/agent-config-types/agent-harness"

export const HARNESS_SNAPSHOT_SCHEMA_VERSION = 1

/** Where a harness version applies. `task` is never persisted beyond its run. */
export type HarnessScope = "task" | "session" | "workspace" | "global"

export const HARNESS_SCOPES: readonly HarnessScope[] = ["task", "session", "workspace", "global"]

/** The eight editable components, by the name settings and locks use. */
export type HarnessComponentName =
  | "systemPrompt"
  | "guardrails"
  | "memory"
  | "toolGuidance"
  | "subagents"
  | "skills"
  | "scripts"
  | "toolRules"

export const HARNESS_COMPONENT_NAMES: readonly HarnessComponentName[] = [
  "systemPrompt",
  "guardrails",
  "memory",
  "toolGuidance",
  "subagents",
  "skills",
  "scripts",
  "toolRules",
]

export type HarnessSkillResourceKind = "script" | "reference" | "asset"

export interface HarnessSkillResourceV1 {
  /** Path inside the skill, e.g. `scripts/check_totals.py`. */
  path: string
  kind: HarnessSkillResourceKind
  content: string
  encoding?: "utf-8" | "base64"
}

/** One skill as the harness carries it (components C6 and C7). */
export interface HarnessSkillV1 {
  /** Directory key in the editable tree: lowercase slug. Unique within a snapshot. */
  key: string
  name: string
  description: string
  /** SKILL.md body without frontmatter. */
  content: string
  allowedTools?: string[]
  resources: HarnessSkillResourceV1[]
  /** The library row this skill was captured from; absent for an editor-created skill. */
  sourceSkillId?: string
  /** SHA-256 of the source row's content and resources at capture time. */
  sourceHash?: string
}

export interface HarnessComponentsV1 {
  systemPrompt: string
  guardrails: string
  memory: string
  toolGuidance: string
  skills: HarnessSkillV1[]
  subagents: HarnessSubagentDefinition[]
  toolRules: HarnessToolRule[]
}

/** Captured configuration. Recorded for fingerprints; never on the editable surface. */
export interface HarnessExecutionConfigV1 {
  providerId?: string
  model?: string
  effort?: string
  permissionMode?: string
  allowedTools?: string[]
  disallowedTools?: string[]
  mcpServerIds?: string[]
  sandboxEnabled?: boolean
  workspaceConfinementEnabled?: boolean
  runtimeKind?: string
}

export type HarnessSnapshotOriginKind =
  "captured" | "candidate" | "composed" | "adopted" | "restored"

export interface HarnessSnapshotOrigin {
  kind: HarnessSnapshotOriginKind
  runId?: string
  /** The stage label that produced it: `inv1`, `dom2`, `agg1`, `c3`, ... */
  label?: string
}

export interface HarnessSnapshotV1 {
  schemaVersion: typeof HARNESS_SNAPSHOT_SCHEMA_VERSION
  id: string
  /** SHA-256 over the canonical JSON of `components` and `execution`. */
  contentHash: string
  parentId?: string
  characterId: string
  characterName: string
  projectId?: string
  scope: HarnessScope
  components: HarnessComponentsV1
  execution: HarnessExecutionConfigV1
  /**
   * App version, runtime kind, provider/model, enabled MCP server ids and the
   * tool-rule engine version. A mismatch marks cached rollouts and experiences
   * built on this snapshot as stale.
   */
  runtimeFingerprint: string
  origin: HarnessSnapshotOrigin
  createdAt: number
}

/** Component-level difference between two snapshots. */
export interface HarnessComponentChange {
  component: HarnessComponentName
  /** Editable-tree path, e.g. `skills/report/SKILL.md`. */
  path: string
  change: "added" | "removed" | "modified"
}

export interface HarnessSnapshotDiff {
  changes: HarnessComponentChange[]
  /** Components with at least one change. */
  components: HarnessComponentName[]
  /** Always-on character delta (system prompt + guardrails + memory + tool guidance). */
  alwaysOnCharDelta: number
  /** True when the execution configuration differs (should never happen inside one run). */
  executionChanged: boolean
}
