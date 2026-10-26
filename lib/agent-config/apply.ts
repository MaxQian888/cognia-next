/**
 * Write a reviewed change back to the surface's own owner (ADR-0238 §6).
 *
 * There is no governance copy of any text. A change lands where the Prompt
 * Center would put it:
 *
 * - an owner that can save in place (a Skill, a character, an instruction
 *   file) saves through its adapter, against the version that was read, so a
 *   change made elsewhere since then is a conflict, never an overwrite;
 * - a shipped or plugin-owned owner gets its custom copy or variant (the
 *   built-in stays immutable);
 * - a code slot publishes an override at the scope the read resolved, with the
 *   revision it saw as the precondition and `plugin` as the revision origin;
 * - an agent file is a checked file write.
 *
 * Consent is the caller's job (`lib/plugin/api/agent-config-api.ts` asks the
 * user for each write); this module only performs a write already approved.
 */

import { clearInstructionCache } from "@/lib/claude/instructions/load"
import { writeWorkspaceFileChecked } from "@/lib/files/workspace-fs"
import { ownerAdapterFor } from "@/lib/prompts/adapters"
import { getPromptDefinition } from "@/lib/prompts/catalog"
import { parseResourceKey } from "@/lib/prompts/resources"
import { publishPromptBody } from "@/lib/prompts/service"
import { codeSlotVersion, parseAgentFileKey, parseCodeSlotVersion } from "./surfaces"
import type { AgentConfigApplyResult, AgentConfigEdit } from "./types"
import { resolveAgentConfigWorkspace } from "./workspace"

export class AgentConfigEditError extends Error {
  constructor(
    readonly code:
      | "agent_config_not_editable"
      | "agent_config_not_found"
      | "agent_config_stale"
      | "agent_config_version_required",
    message: string
  ) {
    super(message)
    this.name = "AgentConfigEditError"
  }
}

async function applyAgentFile(edit: AgentConfigEdit): Promise<AgentConfigApplyResult> {
  if (!edit.version) {
    throw new AgentConfigEditError(
      "agent_config_version_required",
      "an agent file is written against the version it was read at"
    )
  }
  const ref = parseAgentFileKey(edit.key)
  const written = await writeWorkspaceFileChecked(ref.dir, ref.name, edit.text, {
    expectedSha256: edit.version,
  })
  // The send path memoizes discovered agents with the instructions.
  clearInstructionCache()
  return { key: edit.key, version: written.sha256 }
}

async function applyCodeSlot(edit: AgentConfigEdit): Promise<AgentConfigApplyResult> {
  const def = getPromptDefinition(parseResourceKey(edit.key).id)
  if (!def) throw new AgentConfigEditError("agent_config_not_found", `unknown prompt: ${edit.key}`)
  if (!edit.version) {
    throw new AgentConfigEditError(
      "agent_config_version_required",
      "a prompt override is published against the revision it was read at"
    )
  }
  const { target, rev } = parseCodeSlotVersion(edit.version)
  const binding = await publishPromptBody({
    def,
    target,
    body: edit.text,
    expectedRev: rev,
    origin: "plugin",
  })
  return { key: edit.key, version: codeSlotVersion(target, binding.rev) }
}

export async function applyAgentConfigEdit(edit: AgentConfigEdit): Promise<AgentConfigApplyResult> {
  const { source } = parseResourceKey(edit.key)
  if (source === "agent-file") return applyAgentFile(edit)
  if (source === "code") return applyCodeSlot(edit)

  const adapter = ownerAdapterFor(edit.key)
  if (!adapter) {
    throw new AgentConfigEditError("agent_config_not_found", `unknown surface: ${edit.key}`)
  }
  const workspace = resolveAgentConfigWorkspace(edit.workspaceId)
  const current = await adapter.read(edit.key, workspace.promptContext)
  if (!current) {
    throw new AgentConfigEditError("agent_config_not_found", `surface is gone: ${edit.key}`)
  }
  if (
    edit.version !== undefined &&
    current.version !== undefined &&
    edit.version !== current.version
  ) {
    throw new AgentConfigEditError(
      "agent_config_stale",
      `surface changed since it was read: ${edit.key}`
    )
  }
  if (current.readOnlyReason) {
    if (!adapter.saveCustom) {
      throw new AgentConfigEditError(
        "agent_config_not_editable",
        `surface is ${current.readOnlyReason} and has no custom copy: ${edit.key}`
      )
    }
    const key = await adapter.saveCustom(edit.key, edit.text, workspace.promptContext)
    return { key }
  }
  if (!adapter.save) {
    throw new AgentConfigEditError(
      "agent_config_not_editable",
      `surface is edited on its owner's own screen: ${edit.key}`
    )
  }
  const saved = await adapter.save(
    edit.key,
    edit.text,
    edit.version ?? current.version,
    workspace.promptContext
  )
  return { key: saved.key, ...(saved.version ? { version: saved.version } : {}) }
}
