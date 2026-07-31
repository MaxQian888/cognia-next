"use client"

// Links have no composer button: a URL typed or pasted into the textarea is
// recognised by `extractHttpUrls`, chipped here, and dereferenced at send time
// by `buildLinkContextBlocks`. The chip's "×" removes the URL from the text.

import { Link2Icon, XIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { ExternalLink } from "@/components/shared/external-link"
import { TooltipIconButton } from "@/components/chat/ui/tooltip-icon-button"
import { extractHttpUrls, MAX_LINK_CONTEXTS } from "@/lib/chat/link-context"

export interface ComposerLinkChipsProps {
  text: string
  onRemove: (url: string) => void
}

export function ComposerLinkChips({ text, onRemove }: ComposerLinkChipsProps) {
  const t = useTranslations("chat.composer.links")
  const urls = extractHttpUrls(text)
  if (urls.length === 0) return null

  // Only the first MAX_LINK_CONTEXTS URLs are dereferenced. The rest still
  // reach the model verbatim inside the prompt, but nothing else on screen
  // would tell the user their page content wasn't read — so say it.
  const total = extractHttpUrls(text, Number.POSITIVE_INFINITY).length
  const chips = urls.map((url) => {
    const host = new URL(url).hostname
    return (
      <div
        key={url}
        className="group inline-flex h-7 max-w-56 items-center gap-1 rounded-md border bg-muted/40 px-1.5 text-xs"
      >
        <Link2Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <ExternalLink
          href={url}
          aria-label={t("openAria", { host })}
          className="truncate hover:text-primary hover:underline"
        >
          {host}
        </ExternalLink>
        <TooltipIconButton
          type="button"
          size="icon-xs"
          className="shrink-0 opacity-60 hover:opacity-100"
          onClick={() => onRemove(url)}
          aria-label={t("removeAria", { host })}
          tooltip={t("removeAria", { host })}
        >
          <XIcon />
        </TooltipIconButton>
      </div>
    )
  })

  if (total <= MAX_LINK_CONTEXTS) return chips

  return [
    ...chips,
    <span key="link-limit" className="text-[11px] text-muted-foreground">
      {t("limitNote", { max: MAX_LINK_CONTEXTS, total })}
    </span>,
  ]
}
