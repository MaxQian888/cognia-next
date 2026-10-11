"use client"

/**
 * Live preview of the tray panel for the settings editor (ADR-0225 §12).
 *
 * It renders the real module kit over a snapshot built from the same sources
 * the publisher uses, in this window, at the configured width and max height,
 * so an edit in the editor beside it shows up here at once. Built passively:
 * opening Settings must not refresh quota or probe for logins.
 *
 * It is a picture, not a second panel: the whole card is `inert`, so nothing
 * in it can be clicked, focused or run. The real panel opens from the tray or
 * the "Open panel" button above.
 */

import { useMemo } from "react"
import { useTranslations } from "next-intl"

import { GlanceProvider, type GlanceContextValue } from "@/components/glance/glance-context"
import { GlanceStack } from "@/components/glance/glance-stack"
import { TrayPanelDelegateBar } from "@/components/tray-panel/tray-panel-delegate-bar"
import {
  TrayPanelQuickActions,
  TrayPanelQuickActionsProvider,
} from "@/components/tray-panel/tray-panel-quick-actions"
import {
  TrayPanelRunnerProvider,
  useTrayPanelRunnerState,
} from "@/components/tray-panel/tray-panel-runner"
import { useGlanceSources } from "@/hooks/glance/use-glance-sources"
import { GLANCE_SNAPSHOT_VERSION, type GlanceSnapshotV1 } from "@/lib/glance/snapshot"
import { splitPanelActions } from "@/lib/tray-panel/resolve"
import { GLANCE_WIDTH_PX } from "@/types/glance/layout"

const inertSend = async () => null
const inertRoute = () => {}

export function TrayPanelPreview() {
  const t = useTranslations("settings.trayPanel.modules")
  const { body } = useGlanceSources(true, { passive: true })
  const snapshot = useMemo<GlanceSnapshotV1>(
    () => ({ version: GLANCE_SNAPSHOT_VERSION, epoch: 0, revision: 0, ...body }),
    [body]
  )
  const config = snapshot.config
  const { delegate, quick } = useMemo(
    () => splitPanelActions(snapshot.actions, snapshot.when, config.showDelegate),
    [snapshot.actions, snapshot.when, config.showDelegate]
  )
  const runner = useTrayPanelRunnerState(snapshot.actions)

  const glance: GlanceContextValue = {
    snapshot,
    platform: "desktop",
    width: config.width,
    now: snapshot.generatedAt,
    send: inertSend,
    route: inertRoute,
  }

  return (
    <figure className="space-y-1.5" data-testid="tray-panel-preview">
      <figcaption className="text-xs text-muted-foreground">{t("previewCaption")}</figcaption>
      <div
        // Inert content leaves the accessibility tree too; the caption says
        // what it shows.
        inert
        data-width={config.width}
        style={{ width: GLANCE_WIDTH_PX[config.width], maxHeight: config.maxHeight }}
        className="flex max-w-full select-none flex-col overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-sm"
      >
        <GlanceProvider value={glance}>
          <TrayPanelRunnerProvider runner={runner}>
            <div className="min-h-0 flex-1 overflow-hidden">
              <TrayPanelQuickActionsProvider actions={quick}>
                <GlanceStack
                  entries={config.entries}
                  renderers={{ quick: TrayPanelQuickActions }}
                />
              </TrayPanelQuickActionsProvider>
            </div>
            {delegate ? (
              <TrayPanelDelegateBar action={delegate} autoFocus={false} revealNonce={0} />
            ) : null}
          </TrayPanelRunnerProvider>
        </GlanceProvider>
      </div>
    </figure>
  )
}
