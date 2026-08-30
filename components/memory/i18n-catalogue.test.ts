/**
 * Catalogue coverage for every union the memory UI renders through a *dynamic*
 * translation key — `t(`governance.${status}`)`, `t(`activity.actions.${a}`)`,
 * and friends.
 *
 * `pnpm lint:i18n` only sees literal keys, so a union that grows a member ships
 * a `MISSING_MESSAGE` fallback into the UI and no gate notices. That is exactly
 * how the entire `memory.external.*` namespace stayed absent from both locales
 * while three components rendered it, and how `pending_instruction` — a real
 * `MemoryReviewStatus` since ADR-0115 §7 — never got a label.
 *
 * The `Record<Union, true>` maps below are deliberate: `tsc` fails here the
 * moment a union gains a member, and the same map is the runtime list this
 * suite checks both locales against. Adding a member is therefore a type error
 * until it has an English *and* a Chinese string.
 */

import en from "@/i18n/messages/en.json"
import zhCN from "@/i18n/messages/zh-CN.json"
import type {
  MemoryContaminationState,
  MemoryEvidenceState,
  MemoryProvenance,
  MemoryReviewStatus,
  MemoryScope,
  MemoryType,
} from "@/types/memory/memory"
import type { MemoryAuditAction, MemoryEvidenceKind } from "@/types/memory/governance"
import type { ManageMemoryResult } from "@/lib/memory/control-plane/manage"
import type { ExternalAgentId, ExternalMemoryScope } from "@/lib/memory/external/types"

type ManageMemoryDenial = Extract<ManageMemoryResult, { ok: false }>["reason"]

const TYPES: Record<MemoryType, true> = { semantic: true, episodic: true, procedural: true }

const SCOPES: Record<MemoryScope, true> = {
  global: true,
  workspace: true,
  character: true,
  agent: true,
}

const PROVENANCES: Record<MemoryProvenance, true> = {
  user: true,
  explicit: true,
  inbound: true,
  system: true,
  external: true,
}

const REVIEW_STATUSES: Record<MemoryReviewStatus, true> = {
  unreviewed: true,
  verified: true,
  conflict: true,
  pending_instruction: true,
}

const EVIDENCE_STATES: Record<MemoryEvidenceState, true> = { legacy: true, supported: true }

const CONTAMINATION_STATES: Record<MemoryContaminationState, true> = {
  clean: true,
  "external-context": true,
  unknown: true,
}

const DENIALS: Record<ManageMemoryDenial, true> = {
  not_found: true,
  disabled: true,
  temporary: true,
  pii_blocked: true,
  policy_denied: true,
  scope_denied: true,
}

const AUDIT_ACTIONS: Record<MemoryAuditAction, true> = {
  "recall-allowed": true,
  "recall-denied": true,
  "learn-allowed": true,
  "learn-denied": true,
  created: true,
  revised: true,
  promoted: true,
  invalidated: true,
  deleted: true,
  conflict: true,
  pinned: true,
  unpinned: true,
}

const EVIDENCE_KINDS: Record<MemoryEvidenceKind, true> = {
  message: true,
  file: true,
  external: true,
  manual: true,
  checkpoint: true,
  "agent-finding": true,
  "tool-result": true,
  "code-location": true,
}

const EXTERNAL_AGENTS: Record<ExternalAgentId, true> = {
  "claude-code": true,
  codex: true,
  opencode: true,
  pi: true,
}

const EXTERNAL_SCOPES: Record<ExternalMemoryScope, true> = {
  user: true,
  managed: true,
  project: true,
  auto: true,
  global: true,
  memories: true,
}

/** Every dynamic-key catalogue the memory UI renders, as `[namespace, members]`. */
const CATALOGUES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["memory.types", Object.keys(TYPES)],
  ["memory.scopes", Object.keys(SCOPES)],
  ["memory.provenance", Object.keys(PROVENANCES)],
  ["memory.governance", Object.keys(REVIEW_STATUSES)],
  ["memory.governance", Object.keys(EVIDENCE_STATES)],
  ["memory.governance", Object.keys(CONTAMINATION_STATES)],
  ["memory.errors", Object.keys(DENIALS)],
  ["memory.detail.activity.actions", Object.keys(AUDIT_ACTIONS)],
  ["memory.detail.activity.kinds", Object.keys(EVIDENCE_KINDS)],
  ["memory.external.agents", Object.keys(EXTERNAL_AGENTS)],
  ["memory.external.scopes", Object.keys(EXTERNAL_SCOPES)],
]

function lookup(messages: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (node, part) =>
        node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined,
      messages
    )
}

describe.each([
  ["en", en],
  ["zh-CN", zhCN],
])("%s memory catalogues", (_locale, messages) => {
  it.each(CATALOGUES)("%s covers every member", (namespace, members) => {
    const missing = members.filter(
      (member) => typeof lookup(messages, `${namespace}.${member}`) !== "string"
    )
    expect(missing).toEqual([])
  })
})

describe("memory.external", () => {
  // The whole namespace was absent from both locales while three components
  // rendered ~26 keys from it. A presence check on the namespace root is the
  // cheapest way to notice a repeat.
  it.each([
    ["en", en],
    ["zh-CN", zhCN],
  ])("%s defines the namespace the external tab renders", (_locale, messages) => {
    const external = lookup(messages, "memory.external")
    expect(external && typeof external === "object").toBe(true)
    for (const key of ["subtitle", "refresh", "readOnly", "notCreated", "editorLabel"]) {
      expect(typeof lookup(messages, `memory.external.${key}`)).toBe("string")
    }
  })
})
