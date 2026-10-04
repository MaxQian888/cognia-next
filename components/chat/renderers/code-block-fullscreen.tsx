"use client"

/**
 * The full-size view of a chat `CodeBlock`.
 *
 * One tidy header row — file glyph, the filename (truncated), the language as a
 * small muted badge with the line / character counts beside it, then compact
 * icon actions ending in an explicit close — over a code area that fills the
 * rest of the surface. The counts live in the header, so there is no footer.
 *
 * Desktop opens it as a wide dialog. Mobile opens it as a bottom sheet with a
 * real drag handle ABOVE the header: the old dialog dropped the shared close
 * button's 44px touch target on top of the toolbar's last icon and let the
 * title wrap under it. The sheet is `handleOnly`, so a horizontal pan through
 * long lines scrolls the code instead of dragging the sheet.
 */

import type { ReactNode } from "react"
import { useTranslations } from "next-intl"
import { FileCode2, ListOrdered, WrapText, XIcon } from "lucide-react"

import { AnimatedActionIcon, CopyFeedbackIcon } from "@/components/shared/animated-action-icon"
import { FileTypeIcon } from "@/components/shared/file-type-icon"
import { TooltipIconButton } from "@/components/chat/ui/tooltip-icon-button"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { DownloadIcon as AnimatedDownloadIcon } from "@/components/ui/download"
import { Drawer, DrawerContent, DrawerHandle, DrawerTitle } from "@/components/ui/drawer"
import { useBackDismiss } from "@/hooks/ui/use-back-dismiss"
import { useIsMobile } from "@/hooks/ui/use-mobile"
import { cn } from "@/lib/utils"

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
  const isMobile = useIsMobile()
  // Android's back gesture closes the sheet before it navigates the page.
  useBackDismiss(open && isMobile, () => onOpenChange(false))

  const header = (Title: typeof DialogTitle | typeof DrawerTitle) => (
    <div
      className="flex shrink-0 items-center gap-2 border-b px-3 py-2"
      data-testid="code-fullscreen-header"
    >
      {filename ? (
        <FileTypeIcon path={filename} className="size-4 shrink-0" />
      ) : (
        <FileCode2 className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      )}
      <div className="min-w-0 flex-1">
        <Title className="truncate font-mono text-sm leading-5 font-medium text-foreground">
          {filename || languageLabel}
        </Title>
        <div className="flex min-w-0 items-center gap-1.5 text-[11px] leading-4 text-muted-foreground">
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
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        <TooltipIconButton
          variant="ghost"
          size="icon"
          className="size-8 text-muted-foreground hover:text-foreground"
          onClick={onToggleLineNumbers}
          aria-label={showLineNumbers ? t("hideLinesAria") : t("showLinesAria")}
          aria-pressed={showLineNumbers}
          tooltip={showLineNumbers ? t("hideLines") : t("showLines")}
        >
          <ListOrdered className="size-4" />
        </TooltipIconButton>
        <TooltipIconButton
          variant="ghost"
          size="icon"
          className="size-8 text-muted-foreground hover:text-foreground"
          onClick={onToggleWordWrap}
          aria-label={wordWrap ? t("unwrapAria") : t("wrapAria")}
          aria-pressed={wordWrap}
          tooltip={wordWrap ? t("unwrap") : t("wrap")}
        >
          <WrapText className="size-4" />
        </TooltipIconButton>
        <TooltipIconButton
          variant="ghost"
          size="icon"
          className="size-8 text-muted-foreground hover:text-foreground"
          onClick={onCopy}
          aria-label={t("copyAria")}
          tooltip={t("copy")}
        >
          <CopyFeedbackIcon copied={copied} size={16} />
        </TooltipIconButton>
        <TooltipIconButton
          variant="ghost"
          size="icon"
          className="size-8 text-muted-foreground hover:text-foreground"
          onClick={onDownload}
          aria-label={t("downloadAria")}
          tooltip={t("download")}
        >
          <AnimatedActionIcon icon={AnimatedDownloadIcon} size={16} />
        </TooltipIconButton>
        <span className="mx-0.5 h-4 w-px bg-border" aria-hidden />
        <TooltipIconButton
          variant="ghost"
          size="icon"
          className="size-8 text-muted-foreground hover:text-foreground"
          onClick={() => onOpenChange(false)}
          aria-label={t("closeAria")}
          tooltip={t("close")}
          data-testid="code-fullscreen-close"
        >
          <XIcon className="size-4" />
        </TooltipIconButton>
      </div>
    </div>
  )

  // Theme-token surface, the same one the inline block uses — no Shiki theme
  // background bleeding through in either colour scheme.
  const body = (
    <div
      className="min-h-0 flex-1 overflow-auto bg-muted/40 pb-[env(safe-area-inset-bottom)]"
      data-testid="code-fullscreen-body"
    >
      {children}
    </div>
  )

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={onOpenChange} handleOnly>
        <DrawerContent
          showHandle={false}
          aria-describedby={undefined}
          className="data-[vaul-drawer-direction=bottom]:h-[92dvh] data-[vaul-drawer-direction=bottom]:max-h-[92dvh]"
          data-testid="code-fullscreen"
          data-variant="sheet"
        >
          <DrawerHandle className="mt-2 mb-1 shrink-0" />
          {header(DrawerTitle)}
          {body}
        </DrawerContent>
      </Drawer>
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        className={cn(
          "flex h-[85vh] max-h-[85vh] w-full flex-col gap-0 overflow-hidden p-0",
          "max-w-[calc(100%-2rem)] sm:max-w-[min(90vw,72rem)]"
        )}
        data-testid="code-fullscreen"
        data-variant="dialog"
      >
        {header(DialogTitle)}
        {body}
      </DialogContent>
    </Dialog>
  )
}
