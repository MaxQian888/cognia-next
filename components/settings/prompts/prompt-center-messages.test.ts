/**
 * The Prompt Center builds many message keys from enum values
 * (`kind.${def.kind}`, `profile.status.${status}`, …). The test mock answers a
 * missing key with the key itself, so a new enum member would render as a raw
 * key without failing any component test. Each vocabulary below is a
 * `Record<Union, true>`, so adding a member to a union fails typecheck here
 * until its message exists in both locales.
 */

import en from "@/i18n/messages/en/settings/promptCenter.json"
import zh from "@/i18n/messages/zh-CN/settings/promptCenter.json"
import type { InstructionSource } from "@/lib/claude/instructions/types"
import type { PromptRevisionKind, PromptRevisionOrigin } from "@/lib/db/prompt-overrides"
import type { BaseSystemPromptSource } from "@/lib/prompts/base-selection"
import {
  SEND_TIME_SECTIONS,
  type EffectiveOmissionReason,
  type EffectiveSegmentKind,
} from "@/lib/prompts/effective-preview"
import type { PromptImportStatus } from "@/lib/prompts/profile"
import type { OwnerPromptDocument, PromptResourceSource } from "@/lib/prompts/resources"
import {
  PROMPT_SCOPE_SPECIFICITY,
  type PromptActivation,
  type PromptFallbackReason,
  type PromptGroup,
  type PromptHost,
  type PromptOperation,
  type PromptResourceKind,
  type PromptRisk,
} from "@/lib/prompts/types"

const keysOf = <T extends string>(record: Record<T, true>) => Object.keys(record) as T[]

const KINDS = keysOf<PromptResourceKind>({
  "feature-template": true,
  role: true,
  procedure: true,
  "project-rule": true,
  "runtime-baseline": true,
  protocol: true,
  "composer-template": true,
})
const OPERATIONS = keysOf<PromptOperation>({
  "replace-template": true,
  "append-rules": true,
  "legacy-replace": true,
  "activate-procedure": true,
  "narrow-only": true,
  "inspect-only": true,
})
const RISKS = keysOf<PromptRisk>({ ordinary: true, protocol: true, "approval-sensitive": true })
const ACTIVATIONS = keysOf<PromptActivation>({
  "next-operation": true,
  "new-session-required": true,
  "reload-required": true,
  unsupported: true,
})
const HOSTS = keysOf<PromptHost>({ app: true, cli: true, bootstrap: true })
const GROUPS = keysOf<PromptGroup>({
  chat: true,
  generation: true,
  completion: true,
  agents: true,
  goals: true,
  team: true,
  knowledge: true,
  developer: true,
  twin: true,
  permissions: true,
  routing: true,
})
const FALLBACKS = keysOf<PromptFallbackReason>({
  "contract-incompatible": true,
  "pii-blocked": true,
  "invalid-body": true,
  "snapshot-unavailable": true,
})
const SOURCES = keysOf<PromptResourceSource>({
  code: true,
  character: true,
  preset: true,
  skill: true,
  "custom-mode": true,
  "instruction-file": true,
  "workspace-instructions": true,
  "app-setting": true,
  "composer-template": true,
  "subagent-template": true,
  "team-template": true,
})
const READ_ONLY = keysOf<NonNullable<OwnerPromptDocument["readOnlyReason"]>>({
  "built-in": true,
  plugin: true,
  immutable: true,
  "host-unsupported": true,
})
const INSTRUCTION_SOURCES = keysOf<InstructionSource>({
  global: true,
  project: true,
  "instructions-dir": true,
  extra: true,
  import: true,
})
const SEGMENTS = keysOf<EffectiveSegmentKind>({
  base: true,
  persona: true,
  harness: true,
  instructions: true,
  workspace: true,
  mode: true,
  skills: true,
})
const OMISSIONS = keysOf<EffectiveOmissionReason>({
  "bare-mode": true,
  "no-filesystem": true,
  "load-failed": true,
  empty: true,
})
const BASE_SOURCES = keysOf<BaseSystemPromptSource>({
  session: true,
  "team-member": true,
  character: true,
  "app-default": true,
  none: true,
})
const REVISION_KINDS = keysOf<PromptRevisionKind>({ draft: true, published: true, reset: true })
const REVISION_ORIGINS = keysOf<PromptRevisionOrigin>({
  editor: true,
  import: true,
  restore: true,
  cli: true,
  plugin: true,
})
const IMPORT_STATUSES = keysOf<PromptImportStatus>({
  new: true,
  replace: true,
  unchanged: true,
  "unknown-prompt": true,
  "contract-mismatch": true,
  "scope-unsupported": true,
  "needs-target": true,
  invalid: true,
})
/** `ownerSection` values the adapters set. */
const OWNER_SECTIONS = [
  "agent-modes",
  "agent-runtime",
  "characters",
  "chatTemplates",
  "presets",
  "skills",
  "squads",
  "subagents",
]
/** Owners whose shipped resources are edited through a custom copy or variant. */
const CUSTOM_COPY_SOURCES = [
  "character",
  "preset",
  "skill",
  "custom-mode",
  "subagent-template",
  "team-template",
]

const REQUIRED_KEYS = [
  ...KINDS.map((value) => `kind.${value}`),
  ...OPERATIONS.map((value) => `operation.${value}`),
  ...RISKS.flatMap((value) => [`risk.${value}`, `riskNote.${value}`]),
  ...ACTIVATIONS.map((value) => `activation.${value}`),
  ...HOSTS.map((value) => `host.${value}`),
  ...GROUPS.map((value) => `group.${value}`),
  ...FALLBACKS.map((value) => `fallback.${value}`),
  ...PROMPT_SCOPE_SPECIFICITY.map((value) => `scope.${value}`),
  ...PROMPT_SCOPE_SPECIFICITY.filter((value) => value !== "account").flatMap((value) => [
    `target.choose.${value}`,
    `target.none.${value}`,
  ]),
  ...SOURCES.flatMap((value) => [`source.${value}`, `sourceGroup.${value}`]),
  ...SOURCES.filter((value) => value !== "code").map((value) => `ownerActivation.${value}`),
  ...READ_ONLY.map((value) => `owner.readOnly.${value}`),
  ...OWNER_SECTIONS.map((value) => `owner.openIn.${value}`),
  ...CUSTOM_COPY_SOURCES.map((value) => `owner.customHint.${value}`),
  "owner.ownerOnly.composer-template",
  ...INSTRUCTION_SOURCES.map((value) => `instructionSource.${value}`),
  ...SEGMENTS.map((value) => `segment.${value}`),
  ...OMISSIONS.map((value) => `omission.${value}`),
  ...SEND_TIME_SECTIONS.map((value) => `sendTime.${value}`),
  ...BASE_SOURCES.map((value) => `baseSource.${value}`),
  ...REVISION_KINDS.map((value) => `history.kind.${value}`),
  ...REVISION_ORIGINS.map((value) => `history.origin.${value}`),
  ...IMPORT_STATUSES.map((value) => `profile.status.${value}`),
]

function lookup(messages: unknown, key: string): unknown {
  return key
    .split(".")
    .reduce<unknown>(
      (node, part) => (node as Record<string, unknown> | undefined)?.[part],
      messages
    )
}

function leafKeys(node: unknown, prefix = ""): string[] {
  if (typeof node !== "object" || node === null) return [prefix]
  return Object.entries(node).flatMap(([key, value]) =>
    leafKeys(value, prefix ? `${prefix}.${key}` : key)
  )
}

describe.each([
  ["en", en],
  ["zh-CN", zh],
])("settings.promptCenter (%s)", (_locale, messages) => {
  it.each(REQUIRED_KEYS)("has %s", (key) => {
    expect(typeof lookup(messages, key)).toBe("string")
  })
})

it("has the same keys in both locales", () => {
  expect(leafKeys(zh).sort()).toEqual(leafKeys(en).sort())
})
