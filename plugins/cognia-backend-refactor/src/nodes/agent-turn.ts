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
  type PluginContext,
  type StepExecutionContext,
  type StepExecutionResult,
} from "@cognia/plugin-sdk"
import { REFACTOR_ROLES, roleCharacterId, type RefactorRole } from "../characters/pack"

/** Unprefixed kind — the host prefixes the pluginId. */
export const AGENT_TURN_KIND = "agent.turn"
export const AGENT_TURN_DEFAULT_TIMEOUT_SEC = 600

/**
 * Permission mode for the headless turn: `dontAsk`, the least-privileged mode
 * that still lets an unattended run work.
 *
 * - A headless run has no UI to answer a permission prompt, so `default` /
 *   `acceptEdits` would turn every Bash call (`go build`, `go test`,
 *   `git diff`) into a denial and the role could not verify its own work.
 * - `dontAsk` never prompts: it runs exactly the tools the role's character
 *   pre-approves (`allowedTools` — read/search tools, plus Edit/Write/Bash for
 *   the editing roles that run `go`) and DENIES everything else (web fetches,
 *   MCP servers, other plugins' tools, …). A read-only role holds no Bash, so
 *   it cannot edit or commit even if its prompt is subverted by repo content.
 * - `bypassPermissions`, used before, approved every tool the session could
 *   reach — strictly more than any role needs.
 *
 * Scoped to THIS call site rather than to the character definitions: a
 * character's `permissionMode` is consulted for every interactive chat with
 * that character too.
 *
 * On a provider that does not pre-approve by `allowedTools` (the AI-SDK path
 * for non-Claude models), `dontAsk` allows only read-only tools, so the
 * editing roles cannot edit there; the pipeline is built for the Claude
 * Agent SDK path.
 */
export const AGENT_TURN_PERMISSION_MODE = "dontAsk" as const

interface AgentTurnParams {
  role?: string
  characterId?: string
  prompt?: string
  cwd?: string
  sessionId?: string
  timeoutSec?: number
}

export interface AgentTurnRuntime {
  tauri: boolean
  runCharacterTurn: PluginContext["agent"]["runCharacterTurn"]
}

function isKnownRole(role: string): role is RefactorRole {
  return (REFACTOR_ROLES as readonly string[]).includes(role)
}

export async function executeAgentTurn(
  ctx: StepExecutionContext,
  runtime: AgentTurnRuntime
): Promise<StepExecutionResult> {
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
  if (!runtime.tauri) {
    throw new Error(
      "agent.turn requires the desktop runtime: the tool-enabled Claude turn is driven through the Tauri sidecar."
    )
  }

  const timeoutSec =
    typeof params.timeoutSec === "number" && params.timeoutSec > 0
      ? params.timeoutSec
      : AGENT_TURN_DEFAULT_TIMEOUT_SEC
  ctx.log("info", `agent.turn: running ${characterId} in ${cwd}`)

  const result = await runtime.runCharacterTurn({
    characterId,
    prompt,
    cwd,
    ...(params.sessionId?.trim() ? { sessionId: params.sessionId.trim() } : {}),
    timeoutMs: timeoutSec * 1000,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
    permissionMode: AGENT_TURN_PERMISSION_MODE,
  })

  // A tool the role needed was turned away (nobody is there to approve it).
  // Carrying on would hand the next step a half-done turn as if it were done.
  if (result.status === "needs_approval") {
    const denied = [...new Set((result.needsApproval ?? []).map((denial) => denial.toolName))]
    throw new Error(
      `agent.turn: ${characterId} needed tools this unattended run cannot approve (${denied.join(", ") || "unknown"}). Grant them to the role, or run the step interactively.`
    )
  }

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

export function createAgentTurnNode(runtime: AgentTurnRuntime) {
  return defineWorkflowNode({
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
    execute: (ctx) => executeAgentTurn(ctx, runtime),
  })
}
