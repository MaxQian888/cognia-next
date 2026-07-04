"use client"

/**
 * A "Explain change" button + popover shared by the working-tree diff pane and
 * the commit detail view. Clicking it runs `useAiDiffExplain` over the supplied
 * diff and shows a plain-language summary, with copy + retry. Feature gating
 * (`gitSettings.explainAI.enabled`) is the parent's responsibility — this only
 * renders when mounted.
 */

import { useCallback, useState } from "react"
import { useTranslations } from "next-intl"
import { CopyIcon, RefreshCwIcon, SparklesIcon } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Spinner } from "@/components/ui/spinner"
import { useAiDiffExplain } from "@/hooks/git/use-ai-diff-explain"

interface Props {
  /** Human label for the diff subject (e.g. a file path or `commit abc123`). */
  subject: string
  /** Unified diff text to explain (built from a GitDiff's hunk patches). */
  diffText: string
  /** Optional test id override so multiple instances can be targeted. */
  testId?: string
}

export function AiExplainPopover({ subject, diffText, testId = "ai-explain" }: Props) {
  const t = useTranslations("sourceControl")
  const [open, setOpen] = useState(false)
  const { explaining, error, text, explain } = useAiDiffExplain(subject, diffText)

  const handleOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next)
      // Auto-run on first open when there's nothing to show yet.
      if (next && !text && !explaining) void explain()
    },
    [text, explaining, explain]
  )

  const handleCopy = useCallback(async () => {
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      toast.success(t("explain.copied"))
    } catch {
      toast.error(t("explain.copyFailed"))
    }
  }, [text, t])

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 gap-1 px-1.5 text-xs"
          aria-label={t("explain.button")}
          data-testid={`${testId}-trigger`}
        >
          <SparklesIcon className="size-3.5" />
          {t("explain.button")}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80" data-testid={`${testId}-content`}>
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-medium">{t("explain.title")}</p>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-6"
              disabled={explaining}
              aria-label={t("explain.retry")}
              onClick={() => void explain()}
              data-testid={`${testId}-retry`}
            >
              <RefreshCwIcon className="size-3.5" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-6"
              disabled={!text}
              aria-label={t("explain.copy")}
              onClick={() => void handleCopy()}
              data-testid={`${testId}-copy`}
            >
              <CopyIcon className="size-3.5" />
            </Button>
          </div>
        </div>

        <div className="mt-2 text-xs" data-testid={`${testId}-body`}>
          {explaining ? (
            <div className="flex items-center gap-2 text-muted-foreground">
              <Spinner className="size-3.5" />
              {t("explain.generating")}
            </div>
          ) : error ? (
            <p className="text-destructive">{t("explain.failed")}</p>
          ) : text ? (
            <ScrollArea className="max-h-64">
              <p className="whitespace-pre-wrap leading-relaxed">{text}</p>
            </ScrollArea>
          ) : (
            <p className="text-muted-foreground">{t("explain.empty")}</p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
