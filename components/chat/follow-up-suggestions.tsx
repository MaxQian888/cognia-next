"use client"

// Predictions are presented by the composer that owns their draft and send path.
import { useTranslations } from "next-intl"
import { SparklesIcon, XIcon } from "lucide-react"
import { Suggestion, Suggestions } from "@/components/ai-elements/suggestion"
import { Button } from "@/components/ui/button"
import type { FollowUpSuggestionStatus } from "@/hooks/chat/use-follow-up-suggestions"

interface FollowUpSuggestionsProps {
  suggestions: readonly string[]
  onAccept: (text: string) => void
  onDismiss: () => void
  directSend?: boolean
  status?: FollowUpSuggestionStatus
  onRetry?: () => void
  onConfigure?: () => void
}

export function FollowUpSuggestions({
  suggestions,
  onAccept,
  onDismiss,
  directSend = false,
  status,
  onRetry,
  onConfigure,
}: FollowUpSuggestionsProps) {
  const t = useTranslations("chat.composer.followUps")
  if (suggestions.length === 0) {
    if (status !== "unavailable" && status !== "error") return null
    return (
      <div
        className="flex flex-wrap items-center gap-2 pb-1 text-xs text-muted-foreground"
        role="status"
      >
        <span>{t(status)}</span>
        {status === "unavailable" && onConfigure && (
          <Button type="button" variant="ghost" size="xs" onClick={onConfigure}>
            {t("configure")}
          </Button>
        )}
        {onRetry && (
          <Button type="button" variant="ghost" size="xs" onClick={onRetry}>
            {t("retry")}
          </Button>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-1 pb-1" data-testid="follow-up-suggestions" aria-label={t("label")}>
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <SparklesIcon className="size-3 shrink-0" aria-hidden />
        <span>{t(directSend ? "sendHint" : "acceptHint")}</span>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={onDismiss}
          aria-label={t("dismiss")}
          className="ml-auto text-muted-foreground/70 hover:text-foreground"
        >
          <XIcon className="size-3" aria-hidden />
        </Button>
      </div>
      <Suggestions className="w-full flex-wrap gap-1.5 whitespace-normal">
        {suggestions.map((text, i) => (
          <Suggestion
            key={text}
            suggestion={text}
            onClick={onAccept}
            size="xs"
            aria-label={t(directSend ? "send" : "accept", { text })}
            className={
              i === 0
                ? "max-w-full truncate border-primary/30 px-2.5 font-normal text-foreground"
                : "max-w-full truncate px-2.5 font-normal text-muted-foreground hover:border-primary/30 hover:text-foreground"
            }
          />
        ))}
      </Suggestions>
    </div>
  )
}
