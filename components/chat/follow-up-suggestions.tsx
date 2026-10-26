"use client"

// Predictions are presented by the composer that owns their draft and send path.
import { useTranslations } from "next-intl"
import {
  AlertCircleIcon,
  EyeOffIcon,
  InfoIcon,
  RotateCcwIcon,
  Settings2Icon,
  SparklesIcon,
  XIcon,
} from "lucide-react"
import { Suggestion, Suggestions } from "@/components/ai-elements/suggestion"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useUIStore } from "@/stores/ui/ui-store"
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

const NOTICE_ACTION =
  "size-7 rounded-[var(--composer-notice-radius,0.5rem)] pointer-coarse:min-h-11 pointer-coarse:min-w-11"

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
  const setupHintHidden = useUIStore((s) => s.predictionSetupHintHidden)
  const hideSetupHint = useUIStore((s) => s.hidePredictionSetupHint)
  if (suggestions.length === 0) {
    if (status !== "unavailable" && status !== "error") return null
    if (status === "unavailable" && setupHintHidden) return null
    const actions = [
      {
        key: "configure",
        label: t("configure"),
        Icon: Settings2Icon,
        onClick: status === "unavailable" ? onConfigure : undefined,
      },
      { key: "retry", label: t("retry"), Icon: RotateCcwIcon, onClick: onRetry },
      {
        key: "dontShowAgain",
        label: t("dontShowAgain"),
        Icon: EyeOffIcon,
        onClick: status === "unavailable" ? hideSetupHint : undefined,
      },
    ].filter((action) => action.onClick)
    return (
      <div
        className="@container/prediction px-[var(--composer-notice-inset,0.5rem)] pt-1 pb-2"
        data-slot="composer-prediction-notice"
      >
        <div
          role="status"
          className="grid grid-cols-1 items-start gap-x-2 gap-y-1 text-xs text-muted-foreground @2xl/prediction:grid-cols-[minmax(0,1fr)_auto]"
        >
          <div className="flex min-w-0 items-start gap-2 self-center">
            {status === "error" ? (
              <AlertCircleIcon className="mt-[3px] size-3.5 shrink-0 text-warning" aria-hidden />
            ) : (
              <InfoIcon className="mt-[3px] size-3.5 shrink-0 opacity-70" aria-hidden />
            )}
            <span className="min-w-0 leading-5 [overflow-wrap:anywhere]">{t(status)}</span>
          </div>
          <div className="ms-2 flex min-w-0 flex-wrap items-center gap-1 @2xl/prediction:col-start-2 @2xl/prediction:ms-0 @2xl/prediction:self-center">
            {actions.map(({ key, label, Icon, onClick }) => (
              <Tooltip key={key}>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    onClick={onClick}
                    aria-label={label}
                    className={NOTICE_ACTION}
                  >
                    <Icon className="size-3.5" aria-hidden />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{label}</TooltipContent>
              </Tooltip>
            ))}
          </div>
        </div>
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
