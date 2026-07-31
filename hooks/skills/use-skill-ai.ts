"use client"

import { useCallback, useRef } from "react"
import { closeSession, onClaudeMessage, sendPrompt } from "@/lib/claude/ipc"
import { isTauri } from "@/lib/tauri"
import { buildAiSystemPrompt, buildAiUserPrompt, type AiIntent } from "@/lib/skills/ai-prompts"
import type {
  ClaudeEvent,
  SDKAssistantMessage,
  SDKEventEnvelope,
  SDKMessage,
} from "@cognia/agent-config-types"

import type { SkillValidationError } from "@cognia/agent-config-types"

interface AiCurrent {
  name: string
  description?: string
  content: string
  validationErrors?: SkillValidationError[]
}

export interface UseSkillAi {
  /**
   * Run a single-shot rewrite. Returns the suggested markdown, or null if
   * cancelled / unsupported in this environment.
   */
  run: (intent: AiIntent, current: AiCurrent) => Promise<string | null>
  cancel: () => void
}

const TIMEOUT_MS = 60_000

export function useSkillAi(): UseSkillAi {
  const sessionIdRef = useRef<string | null>(null)

  const cancel = useCallback(() => {
    const id = sessionIdRef.current
    if (id && isTauri()) {
      void closeSession(id).catch(() => undefined)
    }
    sessionIdRef.current = null
  }, [])

  const run = useCallback(async (intent: AiIntent, current: AiCurrent): Promise<string | null> => {
    if (!isTauri()) {
      throw new Error("AI assistant requires desktop mode (Claude sidecar).")
    }
    const sessionId = `skill-ai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    sessionIdRef.current = sessionId
    const system = buildAiSystemPrompt()
    const userPrompt = buildAiUserPrompt(intent, {
      name: current.name,
      description: current.description,
      content: current.content,
      validationErrors: current.validationErrors,
    })

    let resolve!: (value: string | null) => void
    let reject!: (err: unknown) => void
    const promise = new Promise<string | null>((res, rej) => {
      resolve = res
      reject = rej
    })

    let buffer = ""
    let unlisten: (() => void) | null = null
    const cleanup = () => {
      if (unlisten) {
        try {
          unlisten()
        } catch {
          // ignore cleanup errors — listener will time out anyway
        }
        unlisten = null
      }
      if (sessionIdRef.current === sessionId) {
        sessionIdRef.current = null
      }
    }
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error("AI assistant timed out."))
    }, TIMEOUT_MS)

    unlisten = await onClaudeMessage((evt: ClaudeEvent) => {
      if (!("sessionId" in evt) || evt.sessionId !== sessionId) {
        // The "ready" / "log" / "sidecar_exited" envelopes don't carry
        // sessionId — ignore them here.
        if (evt.type === "sidecar_exited") {
          clearTimeout(timeout)
          cleanup()
          reject(new Error("Sidecar exited before responding."))
        }
        return
      }
      if (evt.type === "event") {
        handleEnvelope(evt as SDKEventEnvelope, (text) => {
          buffer = text
        })
      }
      if (evt.type === "session_ended") {
        clearTimeout(timeout)
        cleanup()
        if (evt.error) {
          reject(new Error(evt.error))
        } else {
          resolve(stripFences(buffer))
        }
      }
    })

    try {
      await sendPrompt(sessionId, userPrompt, {
        appendSystemPrompt: system,
        maxTurns: 1,
        allowedTools: [],
        disallowedTools: ["*"],
        permissionMode: "default",
      })
    } catch (err) {
      clearTimeout(timeout)
      cleanup()
      reject(err)
    }
    return promise
  }, [])

  return { run, cancel }
}

function handleEnvelope(envelope: SDKEventEnvelope, setBuffer: (text: string) => void) {
  const message = envelope.event as SDKMessage
  if (message.type !== "assistant") return
  const assistant = message as SDKAssistantMessage
  let text = ""
  for (const block of assistant.message.content ?? []) {
    if (block.type === "text" && typeof (block as { text?: string }).text === "string") {
      text += (block as { text: string }).text
    }
  }
  if (text) setBuffer(text)
}

function stripFences(s: string): string {
  const trimmed = s.trim()
  // The system prompt asks for raw markdown, but defenses are cheap. If the
  // model wraps the body in ```markdown ... ``` anyway, strip the fence.
  const fenceMatch = trimmed.match(/^```(?:markdown|md)?\n([\s\S]*?)\n```$/)
  if (fenceMatch) return fenceMatch[1].trim()
  return trimmed
}
