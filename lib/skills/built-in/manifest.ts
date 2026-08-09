/**
 * Built-in skill manifest builder (ADR-0026).
 *
 * Walks the shared `BuiltInSkillRegistry` and produces a flat manifest
 * the sidecar consumes — same shape as
 * `lib/plugin/bridge/sidecar-tools-bridge.ts:PluginToolManifestEntry`,
 * but namespaced with `cognia-builtin-skills` instead of an individual
 * plugin id. The sidecar treats both manifests identically: each entry
 * becomes one MCP tool def in a synthetic in-process MCP server, and
 * invocations IPC back to the renderer over `plugin_tool_exec` so the
 * skill body runs against renderer-held credentials and audit.
 *
 * Filter pipeline (top wins):
 *   1. `skill.platforms` — drop the entry if the current session's
 *      platform isn't covered.
 *   2. `skill.imAccess` — drop `"blocked"` in IM, drop `"readonly"` and
 *      `"opt-in"` in IM unless channel has an explicit allowlist.
 *   3. `ConversationOverrideRow.allowedBuiltInSkillIds` — exact match
 *      or `family.*` wildcard.
 *   4. `skill.requires` — in an IM session, drop the entry if the channel
 *      doesn't declare every required capability (e.g. a skill needing
 *      `rich-card.lark` to render its HITL confirm card is hidden on
 *      channels that can't show cards). Non-IM (desktop) sessions skip
 *      this gate — A2UI renders confirm surfaces natively.
 *
 * Mutation tier does NOT filter at the manifest level — write and
 * destructive skills are still exposed to the assistant; the dispatcher
 * decides whether to render a confirm card at invocation time.
 */

import { z } from "zod"

import type { Capability } from "@/types/connectors/capability"
import type { PlatformKind } from "@/types/connectors/platform-kind"
import type { PlatformSkillCapability } from "@/types/connectors/skill-capability"
import type { ConversationOverrideRow } from "@/lib/db/connector-types"
import { getSharedBuiltInSkillRegistry, platformAllows } from "./registry"
import type { BuiltInSkill } from "./types"
import {
  getCachedLarkCliCapabilityDiagnostics,
  isLarkSkillCapabilityAvailable,
  LARK_CLI_CAPABILITY_MANIFEST,
  probeLarkCliCapabilities,
} from "./lark/capabilities"

/**
 * Synthetic plugin id the sidecar uses to group built-in skill tools.
 * Distinct from any real plugin manifest id so settings UIs and the
 * plugin-tools filter (`cognia-computer-use` gating in build-options.ts)
 * never accidentally fold built-in skills into a real plugin.
 */
export const BUILTIN_SKILLS_PLUGIN_ID = "cognia-builtin-skills"

export interface BuiltInSkillManifestEntry {
  name: string
  description: string
  jsonSchema: object
  /** Always `BUILTIN_SKILLS_PLUGIN_ID` — mirrors the plugin-tools shape. */
  pluginId: string
  /** Source skill id (used by the IPC dispatcher to route back to runBuiltInSkill). */
  skillId: string
}

export interface BuildBuiltInSkillManifestInput {
  /** Session is connector-bound (IM) when these are set. */
  imBinding?: {
    platform: PlatformKind
    adapterId: string
    conversationKey: string
  }
  /** Per-conversation override row (drives allowlist & access tier). */
  imOverrideRow?: ConversationOverrideRow
  /**
   * Capabilities the bound channel declares (the adapter's static
   * `*_CAPS`). Drives the `requires` filter. Omit for non-IM sessions —
   * the filter only runs when `imBinding` is set.
   */
  channelCapabilities?: readonly Capability[]
}

export function buildBuiltInSkillManifest(
  input: BuildBuiltInSkillManifestInput
): BuiltInSkillManifestEntry[] {
  const registry = getSharedBuiltInSkillRegistry()
  const out: BuiltInSkillManifestEntry[] = []

  const isImSession = input.imBinding != null
  for (const skill of registry.list()) {
    if (skill.id in LARK_CLI_CAPABILITY_MANIFEST) {
      if (!getCachedLarkCliCapabilityDiagnostics()) void probeLarkCliCapabilities()
      if (!isLarkSkillCapabilityAvailable(skill.id)) continue
    }
    if (!passPlatformFilter(skill, input.imBinding?.platform, isImSession)) continue
    if (!passImAccessFilter(skill, isImSession, input.imOverrideRow)) continue
    if (!passAllowedListFilter(skill, input.imOverrideRow?.allowedBuiltInSkillIds)) continue
    if (!passRequiresFilter(skill, isImSession, input.channelCapabilities)) continue

    out.push({
      name: skill.mcpToolName,
      description: skill.description.en,
      jsonSchema: z.toJSONSchema(skill.inputSchema) as object,
      pluginId: BUILTIN_SKILLS_PLUGIN_ID,
      skillId: skill.id,
    })
  }

  return out
}

/**
 * Distill the manifest into a per-family `PlatformSkillCapability[]`
 * that adapters cache on `AdapterInstanceRow.lastKnownSkillCapabilities`.
 * Called from adapter startup, NOT from the hot send path.
 */
export function summariseSkillCapabilities(
  platform: PlatformKind
): readonly PlatformSkillCapability[] {
  const byFamily = new Map<string, Set<BuiltInSkill["mutation"]>>()
  for (const skill of getSharedBuiltInSkillRegistry().listByPlatform(platform)) {
    if (skill.id in LARK_CLI_CAPABILITY_MANIFEST) {
      if (!getCachedLarkCliCapabilityDiagnostics()) void probeLarkCliCapabilities()
      if (!isLarkSkillCapabilityAvailable(skill.id)) continue
    }
    let bucket = byFamily.get(skill.family)
    if (!bucket) {
      bucket = new Set()
      byFamily.set(skill.family, bucket)
    }
    bucket.add(skill.mutation)
  }
  const out: PlatformSkillCapability[] = []
  for (const [family, mutations] of byFamily) {
    // Stable order — read, write, destructive — so equality checks at
    // adapter restart don't trigger unnecessary Dexie writes.
    const ordered: BuiltInSkill["mutation"][] = []
    if (mutations.has("read")) ordered.push("read")
    if (mutations.has("write")) ordered.push("write")
    if (mutations.has("destructive")) ordered.push("destructive")
    out.push({ family, mutations: ordered })
  }
  out.sort((a, b) => a.family.localeCompare(b.family))
  return out
}

// ---------------------------------------------------------------------------
// Filter primitives — kept as named helpers so tests can target each gate.
// ---------------------------------------------------------------------------

function passPlatformFilter(
  skill: BuiltInSkill,
  platform: PlatformKind | undefined,
  isImSession: boolean
): boolean {
  // Non-IM (desktop in-app) sessions: expose every registered skill so the
  // assistant can call `lark.calendar.list` from desktop chat.
  if (!isImSession) return true
  // IM session with no platform — strict: filter to nothing. The session
  // really is connector-bound (adapterId is set), but we don't know which
  // platform, so we can't safely route a skill to it.
  if (!platform) return false
  return platformAllows(skill, platform)
}

function passImAccessFilter(
  skill: BuiltInSkill,
  isImSession: boolean,
  override: ConversationOverrideRow | undefined
): boolean {
  if (!isImSession) return true
  switch (skill.imAccess) {
    case "always":
      return true
    case "blocked":
      return false
    case "readonly":
      return (
        Array.isArray(override?.allowedBuiltInSkillIds) ||
        override?.allowedBuiltInSkillIds === "all"
      )
    case "opt-in":
      // Must be explicitly allowlisted — `"all"` is too permissive here.
      return Array.isArray(override?.allowedBuiltInSkillIds)
  }
}

function passAllowedListFilter(
  skill: BuiltInSkill,
  allowed: string[] | "all" | undefined
): boolean {
  if (allowed === undefined || allowed === "all") return true
  if (Array.isArray(allowed) && allowed.length === 0) return false
  for (const entry of allowed) {
    if (entry === skill.id) return true
    if (entry.endsWith(".*")) {
      const prefix = entry.slice(0, -2)
      if (skill.family === prefix || skill.id.startsWith(prefix + ".")) return true
    }
  }
  return false
}

function passRequiresFilter(
  skill: BuiltInSkill,
  isImSession: boolean,
  channelCapabilities: readonly Capability[] | undefined
): boolean {
  // Skills declaring no required capabilities always pass.
  if (!skill.requires || skill.requires.length === 0) return true
  // Non-IM (desktop in-app) sessions render confirm surfaces via A2UI
  // natively — channel-capability gating doesn't apply.
  if (!isImSession) return true
  // IM session: every required capability must be declared by the channel.
  // An absent capability set (`undefined`) is treated as "declares none",
  // conservatively dropping a skill that requires anything.
  const declared = channelCapabilities ?? []
  return skill.requires.every((cap) => declared.includes(cap))
}
