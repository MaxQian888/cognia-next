"use client"

// AI follow-up suggestion chips, rendered just above the composer after an
// assistant reply. Clicking a chip drops the suggested message into the
// composer (via the existing `onUseSample` path) so the user can edit or send
// it. Renders nothing while streaming, when disabled, or when the model /
// PII gate produced no suggestions. Driven entirely by
// `useFollowUpSuggestions`.

import { useTranslations } from "next-intl"
import { SparklesIcon, XIcon } from "lucide-react"
import { useFollowUpSuggestions } from "@/hooks/chat/use-follow-up-suggestions"
import type { ChatSession } from "@cognia/agent-config-types"
import { cn } from "@/lib/utils"

interface FollowUpSuggestionsProps {
  session: ChatSession | null | undefined
  /** Insert the chosen suggestion into the composer. */
  onUseSample: (text: string) => void
}

export function FollowUpSuggestions({ session, onUseSample }: FollowUpSuggestionsProps) {
  const t = useTranslations("chat.composer.followUps")
  const { suggestions, dismiss } = useFollowUpSuggestions(session)

  if (suggestions.length === 0) return null

  return (
    <div
      className="flex flex-wrap items-center gap-1.5 px-1 pb-1"
      data-testid="follow-up-suggestions"
      aria-label={t("label")}
    >
      <SparklesIcon className="size-3 shrink-0 text-muted-foreground" aria-hidden />
      {suggestions.map((text, i) => (
        <button
          key={i}
          type="button"
          onClick={() => {
            onUseSample(text)
            dismiss()
          }}
          className={cn(
            "max-w-full truncate rounded-full border bg-background px-2.5 py-1 text-xs text-muted-foreground",
            "transition-colors hover:border-primary/30 hover:bg-accent hover:text-foreground",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          )}
        >
          {text}
        </button>
      ))}
      <button
        type="button"
        onClick={dismiss}
        aria-label={t("dismiss")}
        className="rounded p-0.5 text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <XIcon className="size-3" aria-hidden />
      </button>
    </div>
  )
}
