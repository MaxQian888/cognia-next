"use client"

/**
 * A2UI Workspace Header
 *
 * Built on the app-wide `FeaturePageHeader` (same chrome as /servers, /sites,
 * /plugins …) so the editor stops looking like its own product. It used to be
 * one hand-rolled bar stacked on top of `A2UIToolbar`, with the edit/preview/
 * data switch rendered *twice* — as tabs here and as three toggle buttons
 * there. The tabs are now the single mode control, and the toolbar is passed
 * in as `controls` so it renders as this header's secondary band instead of a
 * competing bar.
 *
 * `controls` is a prop rather than an import so the header stays renderable on
 * its own (the toolbar pulls in the A2UI store, the app builder and tooltips).
 */

import React from "react"
import Link from "next/link"
import { useTranslations } from "next-intl"
import { ArrowLeft, Pencil, Eye, Database, Blocks } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { FeaturePageHeader } from "@/components/feature-shell/feature-page-header"
import { useA2UIStore } from "@/stores/a2ui"
import { useWorkspaceContext, type WorkspaceMode } from "./a2ui-workspace-context"

export interface WorkspaceHeaderProps {
  /** Rendered as the header's secondary band. See the note above. */
  controls?: React.ReactNode
}

export function WorkspaceHeader({ controls }: WorkspaceHeaderProps) {
  const t = useTranslations("a2ui")
  const { surfaceId, workspaceMode, setWorkspaceMode } = useWorkspaceContext()
  const surface = useA2UIStore((state) => state.surfaces[surfaceId])

  const title = surface?.title || surfaceId.slice(0, 12)
  const isReady = surface?.ready

  return (
    <FeaturePageHeader
      variant="compact"
      testId="a2ui-workspace-header"
      breadcrumb={
        <Button variant="ghost" size="icon-sm" asChild aria-label={t("back")}>
          <Link href="/a2ui">
            <ArrowLeft className="size-4" />
          </Link>
        </Button>
      }
      icon={<Blocks className="size-3.5" aria-hidden="true" />}
      title={title}
      // Only surfaced while the surface is still hydrating. A permanent "all
      // good" badge is chrome that never tells the user anything.
      status={
        isReady ? undefined : (
          <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
            {t("workspace.headerLoading")}
          </Badge>
        )
      }
      // Mode tabs drive the desktop three-panel layout. On mobile the bottom
      // tab-bar is the single navigator, so these are hidden to avoid a no-op
      // control that would just confuse touch users.
      navigationPlacement="inline"
      navigation={
        <Tabs
          value={workspaceMode}
          onValueChange={(v) => setWorkspaceMode(v as WorkspaceMode)}
          className="hidden sm:block"
        >
          <TabsList className="h-7">
            <TabsTrigger value="edit" className="h-6 gap-1 px-2 text-xs">
              <Pencil className="size-3" />
              <span className="hidden sm:inline">{t("editMode")}</span>
            </TabsTrigger>
            <TabsTrigger value="preview" className="h-6 gap-1 px-2 text-xs">
              <Eye className="size-3" />
              <span className="hidden sm:inline">{t("previewMode")}</span>
            </TabsTrigger>
            <TabsTrigger value="data" className="h-6 gap-1 px-2 text-xs">
              <Database className="size-3" />
              <span className="hidden sm:inline">{t("dataMode")}</span>
            </TabsTrigger>
          </TabsList>
        </Tabs>
      }
      controls={controls}
    />
  )
}
