/**
 * Plugin Agent SDK — persistent multi-turn sessions (Package D).
 *
 * Wraps a durable `ChatSession` so a plugin can hold a conversation across
 * turns. Each `send` runs through `executeAgent` in persistent-session mode
 * (no create/delete; the SDK session id is persisted for resume) and records
 * the user + assistant turns to Dexie so `history()` survives reload. On the
 * text channel (no sidecar) prior turns are replayed into the model so the
 * conversation still has memory — degraded but functional.
 *
 * Permission-agnostic: gating (session:read / session:write) lives in
 * `context.ts`. Heavy deps are lazy-imported.
 */

import type { UIMessage } from "ai"
import { createPluginBudget, type PluginBudget } from "./budget"
import type {
  PluginAgentSession,
  PluginCreateSessionOptions,
  PluginSessionMessage,
  PluginSessionSendOptions,
  PluginSessionSendResult,
} from "@/types/plugin/plugin-agent-session"

function newMessageId(): string {
  return `pm_${crypto.randomUUID()}`
}

/** Flatten a UIMessage's text parts into a single string. */
function uiMessageText(message: UIMessage): string {
  const parts = (message.parts ?? []) as Array<{ type?: string; text?: string }>
  return parts
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("")
}

function toSessionMessage(message: UIMessage): PluginSessionMessage {
  const role = message.role === "assistant" || message.role === "system" ? message.role : "user"
  return { role, content: uiMessageText(message) }
}

function buildSession(
  id: string,
  base: { characterId?: string; cwd?: string },
  budget?: PluginBudget
): PluginAgentSession {
  const send = async (
    prompt: string,
    options: PluginSessionSendOptions = {}
  ): Promise<PluginSessionSendResult> => {
    if (typeof prompt !== "string" || !prompt) {
      throw new Error("session.send requires a non-empty prompt")
    }
    // Refuse the turn when the cumulative budget is already exhausted.
    budget?.assertWithin()
    // ADR-0090 Phase 6: unified authority (surface "plugin") behind the flag.
    const [{ executeAgentTurnFromRenderer }, messagesDb] = await Promise.all([
      import("@/lib/ai/agent/execution/agent-execution-service"),
      import("@/lib/db/messages"),
    ])

    const existing = await messagesDb.listMessages(id)
    // Prior turns for the text-channel fallback (ignored on the sidecar, where
    // native resume carries the conversation).
    const priorMessages = existing
      .map(toSessionMessage)
      .filter((m): m is { role: "user" | "assistant"; content: string } => m.role !== "system")

    const result = await executeAgentTurnFromRenderer(
      prompt,
      {
        sessionId: id,
        toolsEnabled: options.toolsEnabled ?? true,
        ...(base.characterId ? { characterId: base.characterId } : {}),
        ...(base.cwd ? { cwd: base.cwd } : {}),
        ...(options.model ? { model: options.model } : {}),
        ...(options.appendSystem ? { appendSystem: options.appendSystem } : {}),
        ...(options.allowedTools ? { allowedTools: options.allowedTools } : {}),
        ...(options.outputFormat ? { outputFormat: options.outputFormat } : {}),
        ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
        ...(priorMessages.length > 0 ? { priorMessages } : {}),
      },
      { surface: "plugin" }
    )

    // Record the turn so history() survives reload.
    const userMsg: UIMessage = {
      id: newMessageId(),
      role: "user",
      parts: [{ type: "text", text: prompt }],
    }
    const assistantMsg: UIMessage = {
      id: newMessageId(),
      role: "assistant",
      parts: [{ type: "text", text: result.text }],
    }
    await messagesDb
      .persistMessages(id, [...existing, userMsg, assistantMsg])
      .catch(() => undefined)

    // Track usage against the session budget (text channel surfaces usage;
    // the sidecar does not, so this is best-effort there).
    if (result.usage) budget?.record({ totalTokens: result.usage.totalTokens })

    return {
      text: result.text,
      channel: result.channel,
      toolsAvailable: result.toolsAvailable,
      ...(result.object !== undefined ? { object: result.object } : {}),
      ...(result.parseError ? { parseError: result.parseError } : {}),
      ...(result.usage ? { usage: result.usage } : {}),
      ...(result.runtime ? { runtime: result.runtime } : {}),
      ...(result.routeKind ? { routeKind: result.routeKind } : {}),
      ...(result.degradedReason ? { degradedReason: result.degradedReason } : {}),
    }
  }

  const history = async (): Promise<PluginSessionMessage[]> => {
    const messagesDb = await import("@/lib/db/messages")
    const rows = await messagesDb.listMessages(id)
    return rows.map(toSessionMessage)
  }

  const end = async (): Promise<void> => {
    const sessionsDb = await import("@/lib/db/sessions")
    await sessionsDb.deleteSession(id).catch(() => undefined)
  }

  return { id, send, history, end }
}

/** Create a new durable plugin agent session. */
export async function createPluginAgentSession(
  options: PluginCreateSessionOptions = {}
): Promise<PluginAgentSession> {
  const sessionsDb = await import("@/lib/db/sessions")
  const session = await sessionsDb.createSession({
    title: options.title ?? "Plugin Agent Session",
    ...(options.characterId ? { characterId: options.characterId } : {}),
    ...(options.cwd ? { workingDir: options.cwd } : {}),
  })
  const budget =
    options.maxTokens || options.maxBudgetUsd
      ? createPluginBudget({
          ...(options.maxTokens ? { maxTokens: options.maxTokens } : {}),
          ...(options.maxBudgetUsd ? { maxBudgetUsd: options.maxBudgetUsd } : {}),
        })
      : undefined
  return buildSession(
    session.id,
    {
      ...(options.characterId ? { characterId: options.characterId } : {}),
      ...(options.cwd ? { cwd: options.cwd } : {}),
    },
    budget
  )
}

/** Resume an existing plugin agent session by id. */
export async function resumePluginAgentSession(sessionId: string): Promise<PluginAgentSession> {
  const sessionsDb = await import("@/lib/db/sessions")
  const row = await sessionsDb.getSession(sessionId)
  if (!row) {
    throw new Error(`resumeSession: session "${sessionId}" not found`)
  }
  return buildSession(row.id, {
    ...(row.characterId ? { characterId: row.characterId } : {}),
    ...(row.workingDir ? { cwd: row.workingDir } : {}),
  })
}
