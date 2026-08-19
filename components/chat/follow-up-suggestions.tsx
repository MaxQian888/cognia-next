"use client"

// AI follow-up suggestion chips, rendered just above the composer after an
// assistant reply. Clicking a chip sends the suggested message straight away
// (via the existing `onUseSample` path). Renders nothing while streaming, when
// disabled, or when the model / PII gate produced no suggestions. Driven
// entirely by `useFollowUpSuggestions`.

import { useTranslations } from "next-intl"
import { SparklesIcon, XIcon } from "lucide-react"
import { Suggestion, Suggestions } from "@/components/ai-elements/suggestion"
import { Button } from "@/components/ui/button"
import { useFollowUpSuggestions } from "@/hooks/chat/use-follow-up-suggestions"
import type { ChatSession } from "@cognia/agent-config-types"

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
      className="flex flex-wrap items-center gap-1.5 pb-1"
      data-testid="follow-up-suggestions"
      aria-label={t("label")}
    >
      <SparklesIcon className="size-3 shrink-0 text-muted-foreground" aria-hidden />
      <Suggestions className="w-full flex-wrap gap-1.5 whitespace-normal">
        {suggestions.map((text, i) => (
          <Suggestion
            key={i}
            suggestion={text}
            onClick={(suggestion) => {
              onUseSample(suggestion)
              dismiss()
            }}
            size="xs"
            className="max-w-full truncate px-2.5 font-normal text-muted-foreground hover:border-primary/30 hover:text-foreground"
          />
        ))}
      </Suggestions>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        onClick={dismiss}
        aria-label={t("dismiss")}
        className="text-muted-foreground/70 hover:text-foreground"
      >
        <XIcon className="size-3" aria-hidden />
      </Button>
    </div>
  )
}
