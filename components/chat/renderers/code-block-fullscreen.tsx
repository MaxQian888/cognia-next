"use client"

/**
 * The full-size view of a chat `CodeBlock`.
 *
 * One tidy header row — file glyph, the filename (truncated), the language as a
 * small muted badge with the line / character counts beside it, then compact
 * icon actions ending in an explicit close — over a code area that fills the
 * rest of the surface. The counts live in the header, so there is no footer.
 *
 * The dialog / sheet shell is `RichBlockFullscreen` (ADR-0218), which every
 * rich block shares; this component supplies the code-specific header.
 */

import type { ReactNode } from "react"
import { useTranslations } from "next-intl"
import { FileCode2, ListOrdered, WrapText } from "lucide-react"

import { AnimatedActionIcon, CopyFeedbackIcon } from "@/components/shared/animated-action-icon"
import { FileTypeIcon } from "@/components/shared/file-type-icon"
import {
  RICH_BLOCK_FULLSCREEN_ACTION_CLASS,
  RichBlockFullscreen,
} from "@/components/chat/renderers/rich-block/rich-block-fullscreen"
import { TooltipIconButton } from "@/components/chat/ui/tooltip-icon-button"
import { DownloadIcon as AnimatedDownloadIcon } from "@/components/ui/download"

export interface CodeBlockFullscreenProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Header label; falls back to the language label when absent. */
  filename?: string
  /** Display label for the language (already resolved to "Plain text" when unknown). */
  languageLabel: string
  lineCount: number
  charCount: number
  showLineNumbers: boolean
  onToggleLineNumbers: () => void
  wordWrap: boolean
  onToggleWordWrap: () => void
  copied: boolean
  onCopy: () => void
  onDownload: () => void
  /** The rendered code (and any truncation notice); scrolls inside the body. */
  children: ReactNode
}

export function CodeBlockFullscreen({
  open,
  onOpenChange,
  filename,
  languageLabel,
  lineCount,
  charCount,
  showLineNumbers,
  onToggleLineNumbers,
  wordWrap,
  onToggleWordWrap,
  copied,
  onCopy,
  onDownload,
  children,
}: CodeBlockFullscreenProps) {
  const t = useTranslations("chat.renderers.code")
  return (
    <RichBlockFullscreen
      open={open}
      onOpenChange={onOpenChange}
      testId="code-fullscreen"
      // Theme-token surface, the same one the inline block uses — no Shiki
      // theme background bleeding through in either colour scheme.
      bodyClassName="bg-muted/40"
      icon={
        filename ? (
          <FileTypeIcon path={filename} className="size-4 shrink-0" />
        ) : (
          <FileCode2 className="size-4 shrink-0" />
        )
      }
      title={<span className="font-mono">{filename || languageLabel}</span>}
      subtitle={
        <>
          {filename ? (
            <span
              className="shrink-0 rounded bg-muted px-1 font-mono text-[10px]"
              data-testid="code-fullscreen-language"
            >
              {languageLabel}
            </span>
          ) : null}
          <span className="truncate tabular-nums" data-testid="code-fullscreen-stats">
            {t("footer", { lineCount, charCount })}
          </span>
        </>
      }
      actions={
        <>
          <TooltipIconButton
            variant="ghost"
            size="icon"
            className={RICH_BLOCK_FULLSCREEN_ACTION_CLASS}
            onClick={onToggleLineNumbers}
            aria-label={showLineNumbers ? t("hideLinesAria") : t("showLinesAria")}
            aria-pressed={showLineNumbers}
            tooltip={showLineNumbers ? t("hideLines") : t("showLines")}
          >
            <ListOrdered />
          </TooltipIconButton>
          <TooltipIconButton
            variant="ghost"
            size="icon"
            className={RICH_BLOCK_FULLSCREEN_ACTION_CLASS}
            onClick={onToggleWordWrap}
            aria-label={wordWrap ? t("unwrapAria") : t("wrapAria")}
            aria-pressed={wordWrap}
            tooltip={wordWrap ? t("unwrap") : t("wrap")}
          >
            <WrapText />
          </TooltipIconButton>
          <TooltipIconButton
            variant="ghost"
            size="icon"
            className={RICH_BLOCK_FULLSCREEN_ACTION_CLASS}
            onClick={onCopy}
            aria-label={t("copyAria")}
            tooltip={t("copy")}
          >
            <CopyFeedbackIcon copied={copied} size={16} />
          </TooltipIconButton>
          <TooltipIconButton
            variant="ghost"
            size="icon"
            className={RICH_BLOCK_FULLSCREEN_ACTION_CLASS}
            onClick={onDownload}
            aria-label={t("downloadAria")}
            tooltip={t("download")}
          >
            <AnimatedActionIcon icon={AnimatedDownloadIcon} size={16} />
          </TooltipIconButton>
        </>
      }
    >
      {children}
    </RichBlockFullscreen>
  )
}
