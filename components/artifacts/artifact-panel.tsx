"use client"

/**
 * ArtifactPanel — the Sheet (modal/offcanvas) host for the artifacts surface.
 *
 * Used as the mobile/tablet fallback and anywhere a docked panel isn't
 * mounted. The body is the shared `<ArtifactPanelContent />`, so the Sheet and
 * the desktop dock render identically. The docked variant lives in
 * `artifact-dock.tsx` / `artifact-workspace-dock.tsx`.
 */

import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet"
import { useArtifactPanelState } from "@/hooks/artifacts/use-artifact-panel"
import { ArtifactPanelContent } from "./artifact-panel-content"

export function ArtifactPanel() {
  const { t, panelOpen, panelView, panelMode, panelWidth, closePanel } = useArtifactPanelState()

  return (
    <Sheet
      open={panelOpen && panelView === "artifact"}
      onOpenChange={(open) => !open && closePanel()}
    >
      <SheetContent
        side={panelMode === "mobile" ? "bottom" : "right"}
        className={`${panelWidth} p-0 transition-all duration-200 ${
          panelMode === "mobile" ? "pb-[env(safe-area-inset-bottom)]" : ""
        }`}
        data-testid="artifact-panel"
      >
        <SheetTitle className="sr-only">{t("sheetTitle")}</SheetTitle>
        <ArtifactPanelContent panelMode={panelMode} />
      </SheetContent>
    </Sheet>
  )
}
