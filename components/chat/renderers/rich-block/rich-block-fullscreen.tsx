"use client"

/**
 * The full-size view every rich block opens (ADR-0218): a wide dialog on the
 * desktop, a bottom sheet with a real drag handle on mobile.
 *
 * Lifted out of the code block's fullscreen, which got the details right first:
 * one header row (glyph, title, muted subtitle, compact actions, explicit
 * close), a body that scrolls on its own, a `handleOnly` sheet so a horizontal
 * pan through wide content scrolls it instead of dragging the sheet, and the
 * Android back gesture closing the sheet before it navigates. Tables, mermaid,
 * math and charts used three other dialogs before this.
 */

import type { ReactNode } from "react"
import { useTranslations } from "next-intl"
import { XIcon } from "lucide-react"

import { TooltipIconButton } from "@/components/chat/ui/tooltip-icon-button"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Drawer, DrawerContent, DrawerHandle, DrawerTitle } from "@/components/ui/drawer"
import { TooltipProvider } from "@/components/ui/tooltip"
import { useBackDismiss } from "@/hooks/ui/use-back-dismiss"
import { useIsMobile } from "@/hooks/ui/use-mobile"
import { cn } from "@/lib/utils"

export interface RichBlockFullscreenProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: ReactNode
  /** Muted line under the title (counts, language badge). */
  subtitle?: ReactNode
  /** Leading glyph. */
  icon?: ReactNode
  /** Header actions; `RICH_BLOCK_FULLSCREEN_ACTION_CLASS` sizes them. */
  actions?: ReactNode
  /** `data-testid` root; header, body and close get `-header`, `-body`, `-close`. */
  testId?: string
  bodyClassName?: string
  children: ReactNode
}

/** Size for fullscreen header buttons: 32px targets, 16px glyphs. */
export const RICH_BLOCK_FULLSCREEN_ACTION_CLASS =
  "size-8 text-muted-foreground hover:text-foreground [&_svg]:size-4"

export function RichBlockFullscreen({
  open,
  onOpenChange,
  title,
  subtitle,
  icon,
  actions,
  testId = "rich-block-fullscreen",
  bodyClassName,
  children,
}: RichBlockFullscreenProps) {
  const t = useTranslations("chat.renderers.richBlock")
  const isMobile = useIsMobile()
  useBackDismiss(open && isMobile, () => onOpenChange(false))

  const header = (Title: typeof DialogTitle | typeof DrawerTitle) => (
    <TooltipProvider>
      <div
        className="flex shrink-0 items-center gap-2 border-b px-3 py-2"
        data-testid={`${testId}-header`}
      >
        {icon ? (
          <span
            className="flex shrink-0 items-center text-muted-foreground [&_svg]:size-4"
            aria-hidden
          >
            {icon}
          </span>
        ) : null}
        <div className="min-w-0 flex-1">
          <Title className="truncate text-sm leading-5 font-medium text-foreground">{title}</Title>
          {subtitle ? (
            <div className="flex min-w-0 items-center gap-1.5 text-[11px] leading-4 text-muted-foreground">
              {subtitle}
            </div>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {actions}
          {actions ? <span className="mx-0.5 h-4 w-px bg-border" aria-hidden /> : null}
          <TooltipIconButton
            variant="ghost"
            size="icon"
            className={RICH_BLOCK_FULLSCREEN_ACTION_CLASS}
            onClick={() => onOpenChange(false)}
            aria-label={t("closeAria")}
            tooltip={t("close")}
            data-testid={`${testId}-close`}
          >
            <XIcon />
          </TooltipIconButton>
        </div>
      </div>
    </TooltipProvider>
  )

  const body = (
    <div
      className={cn("min-h-0 flex-1 overflow-auto pb-[env(safe-area-inset-bottom)]", bodyClassName)}
      data-testid={`${testId}-body`}
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
          data-testid={testId}
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
        data-testid={testId}
        data-variant="dialog"
      >
        {header(DialogTitle)}
        {body}
      </DialogContent>
    </Dialog>
  )
}
