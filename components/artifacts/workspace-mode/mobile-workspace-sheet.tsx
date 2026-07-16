"use client"

import { useTranslations } from "next-intl"
import { XIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Sheet, SheetClose, SheetContent, SheetTitle } from "@/components/ui/sheet"
import { useArtifactDockLayoutStore } from "@/stores/artifact/artifact-dock-layout-store"
import { useChatStore } from "@/stores/chat"
import { DockWorkspace } from "./dock-workspace"

/** Mobile/tablet host for the same Workspace surface used by the desktop Dock. */
export function MobileWorkspaceSheet() {
  const t = useTranslations("artifacts.workspace")
  const dockMode = useArtifactDockLayoutStore((state) => state.dockMode)
  const mobileSheetOpen = useArtifactDockLayoutStore((state) => state.mobileSheetOpen)
  const setMobileSheetOpen = useArtifactDockLayoutStore((state) => state.setMobileSheetOpen)
  const activeSessionId = useChatStore((state) => state.activeSessionId)

  const handleOpenChange = (open: boolean) => {
    setMobileSheetOpen(open)
  }

  return (
    <Sheet open={dockMode === "workspace" && mobileSheetOpen} onOpenChange={handleOpenChange}>
      <SheetContent
        side="bottom"
        showCloseButton={false}
        className="h-[92dvh] max-h-[92dvh] gap-0 overflow-hidden rounded-t-2xl px-0 pt-0 pb-[env(safe-area-inset-bottom)]"
        data-testid="mobile-workspace-sheet"
      >
        <div className="relative shrink-0 px-4 pb-2 pt-3">
          <div className="mx-auto mb-2 h-1 w-10 rounded-full bg-muted-foreground/30" />
          <SheetTitle className="pr-12 text-sm">{t("mobileTitle")}</SheetTitle>
          <SheetClose asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="absolute right-2 top-2 size-11"
              aria-label={t("close")}
            >
              <XIcon className="size-5" />
            </Button>
          </SheetClose>
        </div>
        <div className="min-h-0 flex-1 border-t">
          <DockWorkspace activeSessionId={activeSessionId} layout="mobile" />
        </div>
      </SheetContent>
    </Sheet>
  )
}
