import type { Character } from "@cognia/agent-config-types"
import Dexie from "dexie"

import { COMPUTER_USE_PLUGIN_TOOL_NAMES } from "@/lib/claude/computer-use-tools"
import { getPlatformCapabilities } from "@/lib/connectors/platform-capabilities"
import { resolveImHostCapabilities } from "@/lib/connectors/permission-resolve"
import type { AdapterInstanceRow, ConversationOverrideRow } from "@/lib/db/connector-types"
import type { BuiltInSkill } from "@/lib/skills/built-in/types"
import type { AgentPermissionCeiling } from "@/types/agent/permission-ceiling"
import type { PlatformKind } from "@/types/connectors/platform-kind"

/** Canonical scheduler tool names; kept outside build-options to avoid runtime cycles. */
export const IM_SCHEDULER_TOOL_NAMES = [
  "mcp__cognia__schedule_task",
  "mcp__cognia__list_scheduled_tasks",
  "mcp__cognia__cancel_scheduled_task",
] as const

export const IM_OCR_TOOL_NAMES = ["ocr.extract", "mcp__cognia-plugin-tools__ocr.extract"] as const

function builtInToolAliases(toolName: string): string[] {
  return [toolName, `mcp__cognia-builtin-skills__${toolName}`]
}

export function deriveImPermissionCeiling(input: {
  adapter: AdapterInstanceRow
  override: ConversationOverrideRow | null
  character?: Pick<Character, "enableComputerUse"> | null
  allBuiltInSkills: readonly Pick<BuiltInSkill, "mcpToolName">[]
  allowedBuiltInToolNames: ReadonlySet<string>
  /** Team/Workflow targets own their Computer Use ability; Character does not modify it. */
  target: "direct" | "team" | "workflow"
}): AgentPermissionCeiling {
  const host = resolveImHostCapabilities({
    adapter: input.adapter,
    override: input.override,
    characterComputerUseEnabled:
      input.target === "direct" ? input.character?.enableComputerUse === true : true,
  })
  const denied = new Set<string>()

  for (const skill of input.allBuiltInSkills) {
    if (!input.allowedBuiltInToolNames.has(skill.mcpToolName)) {
      for (const name of builtInToolAliases(skill.mcpToolName)) denied.add(name)
    }
  }
  if (!host.computer_use) {
    for (const name of COMPUTER_USE_PLUGIN_TOOL_NAMES) denied.add(name)
  }
  if (!host.ocr) {
    for (const name of IM_OCR_TOOL_NAMES) denied.add(name)
  }
  if (!host.schedule_tools) {
    for (const name of IM_SCHEDULER_TOOL_NAMES) denied.add(name)
  }

  return denied.size > 0 ? { disallowedTools: Array.from(denied) } : {}
}

/**
 * Build the parent ceiling once per IM turn. Nested targets combine this with
 * their own policy through `deriveExternalSessionPermission`.
 */
export async function buildImPermissionCeiling(input: {
  adapter: AdapterInstanceRow
  override: ConversationOverrideRow | null
  character?: Pick<Character, "enableComputerUse"> | null
  platform: PlatformKind
  target: "direct" | "team" | "workflow"
}): Promise<AgentPermissionCeiling> {
  const [{ buildBuiltInSkillManifest }, { getSharedBuiltInSkillRegistry }] =
    await Dexie.ignoreTransaction(async () => {
      await import("@/lib/skills/built-in")
      return Promise.all([
        import("@/lib/skills/built-in/manifest"),
        import("@/lib/skills/built-in/registry"),
      ])
    })
  const manifest = buildBuiltInSkillManifest({
    imBinding: {
      platform: input.platform,
      adapterId: input.adapter.id,
      conversationKey: input.override?.conversationKey ?? "",
    },
    imOverrideRow: input.override ?? undefined,
    imAdapterRow: input.adapter,
    channelCapabilities: getPlatformCapabilities(input.platform),
  })
  return deriveImPermissionCeiling({
    ...input,
    allBuiltInSkills: getSharedBuiltInSkillRegistry().list(),
    allowedBuiltInToolNames: new Set(manifest.map((entry) => entry.name)),
  })
}
