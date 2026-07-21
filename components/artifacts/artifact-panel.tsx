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
import { ArtifactContextWorkbench } from "./artifact-dock"
import { useArtifactStore } from "@/stores/artifact/artifact-store"

export function ArtifactPanel() {
  const { t, panelOpen, panelView, panelMode, panelWidth, closePanel } = useArtifactPanelState()
  const activeArtifactId = useArtifactStore((state) => state.activeArtifactId)
  const open = panelOpen && panelView === "artifact"

  if (activeArtifactId) {
    return (
      <ArtifactContextWorkbench
        artifactId={activeArtifactId}
        mobile={{ open, onOpenChange: (next) => !next && closePanel(), panelMode }}
      />
    )
  }

  return (
    <Sheet open={open} onOpenChange={(open) => !open && closePanel()}>
      {/* Snappier than the shadcn default (500/300ms): decelerate-in / quicker-out,
          the standard motion convention for a tablet/mobile sheet. Overrides the
          base Sheet's slide via `animation-duration` (the property that actually
          drives it) and keeps the `--motion-duration-scale` multiplier so the
          panel still honors the user's motion-speed preference. */}
      <SheetContent
        side={panelMode === "mobile" ? "bottom" : "right"}
        className={`${panelWidth} p-0 data-[state=open]:[animation-duration:calc(300ms*var(--motion-duration-scale,1))] data-[state=closed]:[animation-duration:calc(200ms*var(--motion-duration-scale,1))] ${
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
