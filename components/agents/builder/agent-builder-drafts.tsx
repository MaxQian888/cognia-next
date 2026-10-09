"use client"

/**
 * Unfinished "Build with AI" drafts (ADR-0220): each draft one row that
 * resumes it, with a discard button beside it. Shown wherever a person starts
 * creating an agent, so a draft is never silently abandoned.
 */

import { useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { useFormatter, useNow, useTranslations } from "next-intl"
import { toast } from "sonner"
import { MessageSquareDashedIcon, Trash2Icon } from "lucide-react"
import type { ChatSession } from "@cognia/agent-config-types"
import { Button } from "@/components/ui/button"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { listBuilderDrafts } from "@/lib/agents/builder/builder-session"
import { deleteSessionsRouted } from "@/lib/chat/session-archive-writes"
import { AGENT_AVATAR_COLORS } from "@/lib/agents/editor-state"
import { AgentAvatar } from "../agent-visuals"

export function AgentBuilderDrafts({
  onResume,
  className,
}: {
  onResume: (sessionId: string) => void
  className?: string
}) {
  const t = useTranslations("agentsConsole.drafts")
  const format = useFormatter()
  const now = useNow({ updateInterval: 60_000 })
  const drafts = useLiveQuery(() => listBuilderDrafts(), []) ?? []
  const [discarding, setDiscarding] = useState<ChatSession | null>(null)

  if (drafts.length === 0) return null

  return (
    <section
      className={className}
      data-testid="agent-builder-drafts"
      aria-labelledby="agent-drafts-heading"
    >
      <h3
        id="agent-drafts-heading"
        className="mb-1.5 flex items-center gap-1.5 px-1 text-xs font-medium text-muted-foreground"
      >
        <MessageSquareDashedIcon className="size-3.5" aria-hidden />
        {t("title", { count: drafts.length })}
      </h3>
      <ul className="divide-y divide-border/60 overflow-hidden rounded-lg border">
        {drafts.map((session) => {
          const draft = session.agentBuilder?.draft ?? {}
          const name = draft.name?.trim() || t("untitled")
          return (
            <li
              key={session.id}
              className="flex items-center gap-1 pr-1.5"
              data-testid="agent-builder-draft"
            >
              <button
                type="button"
                onClick={() => onResume(session.id)}
                className="flex min-w-0 flex-1 items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-accent/60"
                aria-label={t("resumeAria", { name })}
              >
                <AgentAvatar
                  agent={{
                    name,
                    avatarColor: draft.avatarColor ?? AGENT_AVATAR_COLORS[0],
                    avatarEmoji: draft.avatarEmoji,
                    avatarImage: draft.avatarImage,
                  }}
                  size={28}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{name}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {t("edited", {
                      when: format.relativeTime(
                        new Date(session.agentBuilder?.updatedAt ?? session.updatedAt),
                        now
                      ),
                    })}
                  </span>
                </span>
                <span className="shrink-0 text-xs font-medium">{t("resume")}</span>
              </button>
              <Button
                size="icon"
                variant="ghost"
                className="size-7 shrink-0 text-muted-foreground hover:text-destructive"
                onClick={() => setDiscarding(session)}
                aria-label={t("discardAria", { name })}
              >
                <Trash2Icon className="size-3.5" />
              </Button>
            </li>
          )
        })}
      </ul>

      <AlertDialog
        open={discarding !== null}
        onOpenChange={(value) => !value && setDiscarding(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("discardTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("discardBody")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (discarding) {
                  deleteSessionsRouted([discarding.id]).catch((err: unknown) =>
                    toast.error(
                      t("discardFailed", {
                        message: err instanceof Error ? err.message : String(err),
                      })
                    )
                  )
                }
                setDiscarding(null)
              }}
            >
              {t("discard")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}
