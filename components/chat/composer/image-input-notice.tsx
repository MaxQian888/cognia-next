"use client"

/**
 * The attachment row's word on images the recipient will not see.
 *
 * A pill beside the tiles names the problem in a few words; opening it says
 * why and what to do. The one thing the user can do from here is send the
 * images' text instead (OCR on this device, included with the message), and
 * the pill says once that is done. The other remedies live elsewhere and are
 * named: switching the agent's model, updating the paired Host, or picking an
 * agent that reads images.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { CheckIcon, EyeOffIcon, Loader2Icon, ScanTextIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import type { ComposerImageInput } from "./hooks/use-composer-image-input"

export interface ImageInputNoticeProps {
  verdict: Exclude<ComposerImageInput, { accepted: true }>
  /** Images and videos the verdict covers. */
  count: number
  /** Image attachments whose text is not yet included with the message. */
  imagesWithoutText: readonly string[]
  /** Image attachments in the row (the OCR action applies to these). */
  imageCount: number
  /** Includes the text of these images with the message. */
  onExtractImageText?: (attachmentIds: readonly string[]) => Promise<void>
}

export function ImageInputNotice({
  verdict,
  count,
  imagesWithoutText,
  imageCount,
  onExtractImageText,
}: ImageInputNoticeProps) {
  const t = useTranslations("chat.composer.attachments.visualNotice")
  const [extracting, setExtracting] = useState(false)
  const agent = verdict.agentName ?? t("agentFallback")
  // Whether the covered items are all images, so the copy does not speak of
  // videos the user never attached.
  const media = count === imageCount ? "images" : "mixed"
  const copy =
    verdict.reason === "agent-no-images"
      ? {
          short: t("agentNoImagesShort", { agent }),
          full: t("agentNoImages", { agent, count, media }),
        }
      : verdict.reason === "host-outdated"
        ? { short: t("hostOutdatedShort"), full: t("hostOutdated", { agent, count, media }) }
        : verdict.agentName
          ? {
              short: t("noVisionShort", { model: verdict.modelName }),
              full: t("agentNoVision", { model: verdict.modelName, agent, count, media }),
            }
          : {
              short: t("noVisionShort", { model: verdict.modelName }),
              full: t("noVision", { model: verdict.modelName, count }),
            }
  const textIncluded = imageCount > 0 && imagesWithoutText.length === 0

  const extract = async () => {
    if (!onExtractImageText || imagesWithoutText.length === 0) return
    setExtracting(true)
    try {
      await onExtractImageText(imagesWithoutText)
    } finally {
      setExtracting(false)
    }
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={copy.full}
          title={copy.full}
          data-testid="attachment-visual-notice"
          data-text-included={textIncluded || undefined}
          className={cn(
            "inline-flex h-7 max-w-[18rem] items-center gap-1.5 rounded-md border px-2 text-[11px] transition-colors",
            "focus-visible:ring-ring/50 outline-none focus-visible:ring-[3px]",
            "border-amber-500/30 bg-amber-500/10 text-amber-700 hover:bg-amber-500/15 dark:text-amber-300"
          )}
        >
          <EyeOffIcon aria-hidden className="size-3.5 shrink-0" />
          <span className="truncate">{copy.short}</span>
          {textIncluded ? (
            <CheckIcon
              aria-hidden
              className="size-3 shrink-0 text-emerald-600 dark:text-emerald-400"
            />
          ) : null}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-80 space-y-3 p-3 text-xs"
        data-testid="attachment-visual-notice-detail"
      >
        <p className="text-foreground leading-relaxed">{copy.full}</p>
        {imageCount > 0 ? (
          textIncluded ? (
            <p
              className="flex items-center gap-1.5 text-emerald-700 dark:text-emerald-400"
              data-testid="attachment-visual-notice-text-included"
            >
              <CheckIcon aria-hidden className="size-3.5 shrink-0" />
              {t("textIncluded", { count: imageCount })}
            </p>
          ) : onExtractImageText ? (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              className="h-7 gap-1.5 text-xs"
              disabled={extracting}
              onClick={() => void extract()}
              data-testid="attachment-visual-notice-extract"
            >
              {extracting ? (
                <Loader2Icon aria-hidden className="size-3.5 animate-spin" />
              ) : (
                <ScanTextIcon aria-hidden className="size-3.5" />
              )}
              {extracting ? t("extracting") : t("extractText", { count: imagesWithoutText.length })}
            </Button>
          ) : null
        ) : null}
      </PopoverContent>
    </Popover>
  )
}
