"use client"

/**
 * Customizable quick-action grid on the mobile home (chat welcome). Renders the
 * user's chosen actions (`useMobileHomeLayout`) and dispatches taps by kind:
 * `newChat` / `search` fire the supplied callbacks, `route` navigates. The
 * "Edit" affordance opens `MobileQuickActionsEditor` in a bottom sheet.
 *
 * Returns `null` when the `quickActions` section is hidden or empty, keeping the
 * welcome screen minimal by default.
 */

import { useState } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { SlidersHorizontalIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { MobileSpotIcon } from "@/components/mobile/mobile-spot-icon"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { selectionFeedback } from "@/lib/capacitor/haptics"
import type { MobileQuickActionItem } from "@/lib/shell/mobile-home-nav"
import { useMobileHomeLayout } from "./use-mobile-home-layout"
import { useBackDismiss } from "@/hooks/ui/use-back-dismiss"

import { MobileQuickActionsEditor } from "./mobile-quick-actions-editor"

export interface MobileQuickActionsProps {
  /** Start a new chat (opens the character picker in the shell). */
  onNewChat: () => void
  /** Open the global search / command palette. */
  onSearch: () => void
  className?: string
}

export function MobileQuickActions({ onNewChat, onSearch, className }: MobileQuickActionsProps) {
  const t = useTranslations("mobile.home")
  const tActions = useTranslations("mobile.home.actions")
  const router = useRouter()
  const { resolved, isSectionHidden } = useMobileHomeLayout()
  const [editorOpen, setEditorOpen] = useState(false)
  // Android hardware / browser back closes the editor sheet instead of
  // navigating. (Must run before the section-hidden early return below.)
  useBackDismiss(editorOpen, () => setEditorOpen(false))

  const dispatch = (item: MobileQuickActionItem) => {
    void selectionFeedback()
    if (item.kind === "newChat") onNewChat()
    else if (item.kind === "search") onSearch()
    else if (item.kind === "route" && item.route) router.push(item.route)
  }

  // Section hidden → render nothing (but keep the editor reachable elsewhere via
  // the explicit edit entry rendered only when there are actions to show).
  if (isSectionHidden("quickActions") || resolved.active.length === 0) return null

  return (
    <div className={className} data-testid="mobile-quick-actions">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t("quickActions")}
        </h3>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 gap-1 px-2 text-xs"
          onClick={() => setEditorOpen(true)}
          data-testid="mobile-quick-actions-edit"
        >
          <SlidersHorizontalIcon className="size-3.5" />
          {t("edit")}
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {resolved.active.map((item) => (
          <Card
            key={item.id}
            role="button"
            tabIndex={0}
            onClick={() => dispatch(item)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault()
                dispatch(item)
              }
            }}
            data-testid={`mobile-quick-action-${item.id}`}
            className="flex min-h-28 cursor-pointer flex-col items-center justify-center gap-1 rounded-xl p-2 text-center shadow-none transition-colors active:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <MobileSpotIcon name={item.spotIcon} size={64} className="-my-1" />
            <span className="line-clamp-1 text-xs font-medium">{tActions(item.i18nKey)}</span>
          </Card>
        ))}
      </div>

      <Sheet open={editorOpen} onOpenChange={setEditorOpen}>
        <SheetContent
          side="bottom"
          className="max-h-[85vh] overflow-y-auto"
          data-testid="mobile-quick-actions-editor-sheet"
        >
          <SheetHeader>
            <SheetTitle>{t("customize.title")}</SheetTitle>
            <SheetDescription>{t("customize.description")}</SheetDescription>
          </SheetHeader>
          <div className="px-4 pb-6">
            <MobileQuickActionsEditor />
          </div>
        </SheetContent>
      </Sheet>
    </div>
  )
}
