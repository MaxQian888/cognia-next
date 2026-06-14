/**
 * `agent.turn` — a synchronous, tool-enabled, cwd-scoped Claude turn as a
 * custom workflow node (ADR-0017 plugin node API).
 *
 * This is the crux of the suite: it is the ONLY workflow path that actually
 * EDITS code. Agent-Team teammate dispatch (`executeAgent` → AI SDK
 * `streamText`) is text-only, and `action.character.send` merely enqueues a
 * message. This node instead drives the chat/character path headlessly via
 * `runAndCaptureAssistantReply` (the same runner connectors use to answer
 * inbound IM messages), so the resolved role persona runs with full
 * Bash/Read/Edit/Glob/Grep scoped to the target repo and the workflow waits
 * for the turn's result.
 *
 * The host auto-prefixes the kind to `cognia-backend-refactor.agent.turn`
 * (see `lib/plugin/core/context.ts:prefixKind`) when registered through
 * `ctx.workflow.registerNode`. Desktop-only: it requires the Tauri sidecar.
 */

import { defineWorkflowNode } from "@/lib/plugin/sdk"
import type { StepExecutionContext, StepExecutionResult } from "@/types/workflow/visual"
import { isTauri } from "@/lib/tauri"
import { REFACTOR_ROLES, roleCharacterId, type RefactorRole } from "../characters/pack"

/** Unprefixed kind — the host prefixes the pluginId. */
export const AGENT_TURN_KIND = "agent.turn"
export const AGENT_TURN_DEFAULT_TIMEOUT_SEC = 600

interface AgentTurnParams {
  role?: string
  characterId?: string
  prompt?: string
  cwd?: string
  sessionId?: string
  timeoutSec?: number
}

function isKnownRole(role: string): role is RefactorRole {
  return (REFACTOR_ROLES as readonly string[]).includes(role)
}

/**
 * Resolve-or-create the chat session for `characterId`, pinned to `cwd` as its
 * working directory (which `resolveSendOptions` reads into `SendOptions.cwd`).
 * Reuses the character's most recent session for in-run continuity rather than
 * spawning one per turn.
 */
async function ensureSession(
  db: typeof import("@/lib/db/sessions"),
  characterId: string,
  cwd: string,
  sessionId?: string
): Promise<{ id: string }> {
  if (sessionId) {
    const existing = await db.getSession(sessionId)
    if (existing) {
      if (existing.workingDir !== cwd) await db.updateSession(existing.id, { workingDir: cwd })
      return { id: existing.id }
    }
  }
  const all = await db.listSessions()
  const match = all.find((s) => s.characterId === characterId)
  if (match) {
    if (match.workingDir !== cwd) await db.updateSession(match.id, { workingDir: cwd })
    return { id: match.id }
  }
  const created = await db.createSession({
    title: `Backend Refactor — ${characterId}`,
    characterId,
    workingDir: cwd,
  })
  return { id: created.id }
}

export async function executeAgentTurn(ctx: StepExecutionContext): Promise<StepExecutionResult> {
  const params = (ctx.params ?? {}) as AgentTurnParams
  const prompt = (params.prompt ?? "").trim()
  const cwd = params.cwd?.trim()
  if (!prompt) throw new Error("agent.turn requires a non-empty 'prompt'")
  if (!cwd) throw new Error("agent.turn requires 'cwd' (the absolute path to the target repo)")

  let characterId = params.characterId?.trim()
  if (!characterId) {
    const role = params.role?.trim() ?? ""
    if (!isKnownRole(role)) {
      throw new Error(
        `agent.turn requires 'characterId' or a known 'role' — one of: ${REFACTOR_ROLES.join(", ")}`
      )
    }
    characterId = roleCharacterId(role)
  }

  // Tool-enabled turns need the sidecar; fail loudly in the browser shell.
  // Direct `isTauri()` is intentional here: node executors receive a
  // StepExecutionContext, which carries no `ctx.capabilities` API
  // (the node is declared `desktopOnly`).
  if (!isTauri()) {
    throw new Error(
      "agent.turn requires the desktop runtime: the tool-enabled Claude turn is driven through the Tauri sidecar."
    )
  }

  const [{ resolveCharacterById }, sessionsDb, { getSettings }, { resolveSendOptions }, runner] =
    await Promise.all([
      import("@/lib/db/characters"),
      import("@/lib/db/sessions"),
      import("@/lib/db/settings"),
      import("@/lib/claude/build-options"),
      import("@/lib/claude/run-and-capture"),
    ])

  const character = await resolveCharacterById(characterId)
  if (!character) {
    throw new Error(
      `agent.turn: character "${characterId}" not found — is the Backend Refactor plugin enabled?`
    )
  }

  const session = await ensureSession(sessionsDb, characterId, cwd, params.sessionId?.trim())
  const appSettings = await getSettings().catch(() => undefined)
  const sendOptions = await resolveSendOptions({
    session: (await sessionsDb.getSession(session.id)) ?? null,
    character,
    appSettings: appSettings ?? null,
  })

  const timeoutSec =
    typeof params.timeoutSec === "number" && params.timeoutSec > 0
      ? params.timeoutSec
      : AGENT_TURN_DEFAULT_TIMEOUT_SEC
  ctx.log?.("info", `agent.turn: running ${characterId} in ${cwd}`)

  const result = await runner.runAndCaptureAssistantReply(session.id, prompt, sendOptions, {
    signal: ctx.signal,
    timeoutMs: timeoutSec * 1000,
  })

  return {
    output: {
      text: result.text,
      messageId: result.messageId,
      characterId,
      role: params.role ?? null,
      sessionId: session.id,
    },
  }
}

export const AGENT_TURN_NODE = defineWorkflowNode({
  kind: AGENT_TURN_KIND,
  typeVersion: 1,
  category: "plugin",
  label: "Refactor Agent Turn",
  description:
    "Run a role persona as a synchronous, tool-enabled Claude turn scoped to the target repo. This is the node that actually edits code.",
  iconName: "bot",
  keywords: ["refactor", "agent", "claude", "code", "edit", "go"],
  desktopOnly: true,
  retryable: false,
  paramsSchema: {
    type: "object",
    properties: {
      role: {
        type: "string",
        enum: [...REFACTOR_ROLES],
        description: "Role persona to run (ignored when characterId is set).",
      },
      characterId: {
        type: "string",
        description: "Explicit character id; overrides role.",
      },
      prompt: { type: "string", description: "The instruction for this turn." },
      cwd: {
        type: "string",
        description: "Absolute path to the target repo (becomes the agent's working directory).",
      },
      sessionId: {
        type: "string",
        description: "Reuse a specific chat session; otherwise reused/created per role.",
      },
      timeoutSec: {
        type: "number",
        description: "Turn timeout in seconds (default 600).",
      },
    },
    required: ["prompt", "cwd"],
    additionalProperties: false,
  },
  defaultParams: {
    role: "refactorer",
    prompt: "",
    cwd: "{{ $vars.repoPath }}",
  },
  execute: executeAgentTurn,
})
