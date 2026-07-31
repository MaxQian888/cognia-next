"use client"

/**
 * Mobile node-config drawer — a Vaul bottom drawer with snap points
 * (~45% peek / ~90% expanded) that embeds the existing desktop
 * `InspectorPanel`. The panel's forms are already width-fluid
 * (`w-full`/`flex-1`) so they drop in unchanged; `embedded` strips the
 * side-rail border + the header close-X (the drawer owns dismiss).
 *
 * The only mobile-specific addition is the "Connect" action, which hands
 * control back to the editor's tap-to-connect state machine.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { Spline as ConnectIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer"
import { InspectorPanel } from "@/components/workflow/editor/inspector-panel"
import type { EditorStore } from "@/lib/workflow/editor/store"
import { useBackDismiss } from "@/hooks/ui/use-back-dismiss"

const SNAP_POINTS = [0.45, 0.9] as const

export interface MobileNodeInspectorDrawerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  store: EditorStore
  /** Show the Connect action — only meaningful in edit mode. */
  canConnect: boolean
  /** Enter tap-to-connect rooted at the currently-selected node. */
  onStartConnect: () => void
}

export function MobileNodeInspectorDrawer({
  open,
  onOpenChange,
  store,
  canConnect,
  onStartConnect,
}: MobileNodeInspectorDrawerProps) {
  const t = useTranslations("mobile.workflow.editor")
  // Android hardware / browser back closes the sheet instead of navigating.
  useBackDismiss(open, () => onOpenChange(false))
  const [snap, setSnap] = useState<number | string | null>(SNAP_POINTS[0])

  // Re-peek at the smaller snap each time the drawer reopens so a fresh node
  // selection doesn't inherit the previous node's expanded height. Done as a
  // render-time prop-change adjustment (not an effect) to avoid a cascading
  // re-render — the same pattern run-detail uses for its auto-pick.
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) setSnap(SNAP_POINTS[0])
  }

  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      snapPoints={[...SNAP_POINTS]}
      activeSnapPoint={snap}
      setActiveSnapPoint={setSnap}
    >
      <DrawerContent
        className="h-[92vh]"
        data-testid="mobile-node-inspector-drawer"
        aria-describedby={undefined}
      >
        <DrawerHeader className="flex flex-row items-center justify-between gap-2 py-2 text-left">
          <DrawerTitle className="text-sm">{t("inspectorTitle")}</DrawerTitle>
          {canConnect ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="min-h-9"
              onClick={onStartConnect}
              data-testid="mobile-inspector-connect"
            >
              <ConnectIcon className="mr-1.5 size-4" aria-hidden="true" />
              {t("connect")}
            </Button>
          ) : null}
        </DrawerHeader>
        <div className="min-h-0 flex-1 overflow-hidden">
          <InspectorPanel useStore={store} embedded />
        </div>
      </DrawerContent>
    </Drawer>
  )
}
