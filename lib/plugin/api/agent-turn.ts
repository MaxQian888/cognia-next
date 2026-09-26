/**
 * A synchronous, tool-enabled agent turn, run headlessly on a plugin's behalf.
 *
 * `ctx.agent` dispatches subagents and invokes tools; it cannot run a full
 * CHARACTER turn — resolve a persona, pin it to a working directory, drive the
 * sidecar with that character's tools and wait for the reply. A plugin that
 * wants the one workflow path that actually edits code had to assemble that
 * from `@/lib/db/characters`, `@/lib/db/sessions`, `@/lib/db/settings`,
 * `@/lib/claude/build-options` and `@/lib/claude/run-and-capture` — five
 * host-private modules, one of which (`getSettings`) hands over the entire
 * settings row including every credential.
 *
 * This is that sequence as one call, published to authors as
 * `@cognia/plugin-sdk/api/agent-turn`. `AppSettings` never leaves the host.
 *
 * ## Permission posture
 *
 * `permissionMode` defaults to the character's own. A headless caller has no UI
 * to answer a permission prompt, so a tool-enabled turn would hang forever
 * waiting on one — but the fix must be a decision at THIS call site, not a
 * property of the character: a character's `permissionMode` is consulted for
 * every interactive chat with that character too, so widening it there hands
 * un-prompted Edit/Write/Bash to anyone who picks that persona from the
 * character list. Pass `"bypassPermissions"` explicitly, per call.
 */

import {
  PluginAgentTurnError,
  type PluginAgentTurnRequest,
  type PluginAgentTurnResult,
} from "@cognia/plugin-sdk/api/agent-turn"
import { createUnattendedPermissionResponder } from "@/lib/claude/unattended-permission-responder"
import type { AgentCapabilityGrantV1 } from "@cognia/agent-config-types/agent-capability-grant"

export {
  PluginAgentTurnError,
  type PluginAgentTurnDenial,
  type PluginAgentTurnRequest,
  type PluginAgentTurnResult,
} from "@cognia/plugin-sdk/api/agent-turn"

/**
 * Resolve-or-create the session for `characterId`, pinned to `cwd`.
 *
 * Reuses the character's most recent session rather than spawning one per
 * turn, so a multi-step run keeps its conversation.
 */
async function ensureSession(
  characterId: string,
  cwd: string,
  sessionId?: string
): Promise<string> {
  const db = await import("@/lib/db/sessions")
  if (sessionId) {
    const existing = await db.getSession(sessionId)
    if (existing) {
      if (existing.workingDir !== cwd) await db.updateSession(existing.id, { workingDir: cwd })
      return existing.id
    }
  }
  const match = (await db.listSessions()).find((s) => s.characterId === characterId)
  if (match) {
    if (match.workingDir !== cwd) await db.updateSession(match.id, { workingDir: cwd })
    return match.id
  }
  const created = await db.createSession({
    title: `Plugin turn — ${characterId}`,
    characterId,
    workingDir: cwd,
  })
  return created.id
}

/**
 * Validate the request's grants and attribute them to the caller. A malformed
 * grant fails the turn rather than being dropped: running without a denial the
 * caller asked for is the unsafe direction.
 */
async function acceptedGrants(
  request: PluginAgentTurnRequest,
  source: { kind: "plugin" | "bot"; id?: string } | undefined
): Promise<AgentCapabilityGrantV1[] | undefined> {
  if (!request.capabilityGrants?.length) return undefined
  const { validateAgentCapabilityGrant } =
    await import("@cognia/agent-config-types/agent-capability-grant")
  return request.capabilityGrants.map((grant, index) => {
    const checked = validateAgentCapabilityGrant(grant)
    if (!checked.ok) {
      throw new PluginAgentTurnError(
        `runPluginAgentTurn: capabilityGrants[${index}] is invalid: ${checked.errors.join("; ")}`
      )
    }
    return source ? { ...checked.value, source } : checked.value
  })
}

export interface RunPluginAgentTurnOptions {
  /**
   * Who is calling, stamped over every grant's self-declared source so the
   * audit trail names the real caller. Host-side callers (bots) pass their own.
   */
  grantSource?: { kind: "plugin" | "bot"; id?: string }
}

export async function runPluginAgentTurn(
  request: PluginAgentTurnRequest,
  options: RunPluginAgentTurnOptions = {}
): Promise<PluginAgentTurnResult> {
  const prompt = request.prompt.trim()
  const cwd = request.cwd.trim()
  if (!prompt) throw new PluginAgentTurnError("runPluginAgentTurn requires a non-empty prompt")
  if (!cwd) throw new PluginAgentTurnError("runPluginAgentTurn requires an absolute cwd")

  const [{ resolveCharacterById }, sessionsDb, { getSettings }, { resolveSendOptions }, runner] =
    await Promise.all([
      import("@/lib/db/characters"),
      import("@/lib/db/sessions"),
      import("@/lib/db/settings"),
      import("@/lib/claude/build-options"),
      import("@/lib/claude/run-and-capture"),
    ])

  const character = await resolveCharacterById(request.characterId)
  if (!character) {
    throw new PluginAgentTurnError(
      `runPluginAgentTurn: character "${request.characterId}" not found`
    )
  }

  const capabilityGrants = await acceptedGrants(request, options.grantSource)
  const sessionId = await ensureSession(request.characterId, cwd, request.sessionId?.trim())
  const appSettings = await getSettings().catch(() => undefined)
  const sendOptions = await resolveSendOptions({
    session: (await sessionsDb.getSession(sessionId)) ?? null,
    character,
    appSettings: appSettings ?? null,
    ...(request.composition ? { compositionSelection: request.composition } : {}),
    ...(capabilityGrants ? { capabilityGrants } : {}),
  })
  if (request.permissionMode) sendOptions.permissionMode = request.permissionMode

  // Nobody is watching this turn. A permission request is answered here,
  // now, with a recorded denial, rather than left to whichever shell-specific
  // listener happens to exist (desktop: silent auto-deny; headless: a
  // five-minute hang reported as a timeout).
  const permissions = createUnattendedPermissionResponder("plugin")
  const result = await runner.runAndCaptureAssistantReply(sessionId, prompt, sendOptions, {
    ...(request.signal ? { signal: request.signal } : {}),
    ...(request.timeoutMs ? { timeoutMs: request.timeoutMs } : {}),
    onPermissionRequest: permissions.onPermissionRequest,
  })

  return {
    sessionId,
    text: result.text,
    ...(result.messageId ? { messageId: result.messageId } : {}),
    status: permissions.needsApproval() ? "needs_approval" : "completed",
    ...(permissions.needsApproval() ? { needsApproval: [...permissions.denials] } : {}),
  }
}
