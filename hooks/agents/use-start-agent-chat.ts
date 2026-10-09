"use client"

/**
 * "Chat with this agent" from the agents console (ADR-0220). Goes through the
 * single new-chat path, so the conversation lands in the active workspace and
 * starts on the agent's default runtime, then opens it in chat.
 */

import { useCallback, useState } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import type { Character } from "@cognia/agent-config-types"
import { startNewSession } from "@/lib/chat/start-session"
import { sessionHref } from "@/lib/issues/run/agent-task-adapter"

export function useStartAgentChat(): {
  start: (agent: Pick<Character, "id" | "name">) => Promise<void>
  starting: boolean
} {
  const router = useRouter()
  const t = useTranslations("agentsConsole.actions")
  const [starting, setStarting] = useState(false)
  const start = useCallback(
    async (agent: Pick<Character, "id" | "name">) => {
      setStarting(true)
      try {
        const session = await startNewSession({
          title: t("chatTitle", { name: agent.name }),
          kind: "direct",
          characterId: agent.id,
        })
        router.push(sessionHref(session.id))
      } catch (err) {
        toast.error(t("chatFailed"), {
          description: err instanceof Error ? err.message : String(err),
        })
      } finally {
        setStarting(false)
      }
    },
    [router, t]
  )
  return { start, starting }
}
