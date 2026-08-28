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

import {
  defineWorkflowNode,
  type StepExecutionContext,
  type StepExecutionResult,
} from "@cognia/plugin-sdk"
import { runPluginAgentTurn } from "@cognia/plugin-sdk/api/agent-turn"
import { readHostCapabilities } from "@cognia/plugin-sdk/api/host-environment"
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
  // The SDK's host-shell probe rather than `ctx.capabilities`: a node executor
  // receives a StepExecutionContext, which carries no capabilities API (the
  // node is declared `desktopOnly`).
  if (!readHostCapabilities().tauri) {
    throw new Error(
      "agent.turn requires the desktop runtime: the tool-enabled Claude turn is driven through the Tauri sidecar."
    )
  }

  const timeoutSec =
    typeof params.timeoutSec === "number" && params.timeoutSec > 0
      ? params.timeoutSec
      : AGENT_TURN_DEFAULT_TIMEOUT_SEC
  ctx.log?.("info", `agent.turn: running ${characterId} in ${cwd}`)

  const result = await runPluginAgentTurn({
    characterId,
    prompt,
    cwd,
    ...(params.sessionId?.trim() ? { sessionId: params.sessionId.trim() } : {}),
    timeoutMs: timeoutSec * 1000,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
    // Scoped to THIS call site rather than to the character definitions: a
    // character's `permissionMode` is consulted for every interactive chat
    // with that character too, which would silently hand un-prompted
    // Edit/Write/Bash to anyone picking a refactor role from the character
    // list. A headless run has no UI to answer a prompt, so it would otherwise
    // hang forever waiting on one.
    permissionMode: "bypassPermissions",
  })

  return {
    output: {
      text: result.text,
      messageId: result.messageId,
      characterId,
      role: params.role ?? null,
      sessionId: result.sessionId,
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
  iconName: "Bot",
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
