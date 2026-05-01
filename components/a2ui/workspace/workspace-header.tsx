"use client"

/**
 * A2UI Workspace Header
 * Navigation bar with back button, title, mode tabs, and status
 */

import React from "react"
import Link from "next/link"
import { useTranslations } from "next-intl"
import { ArrowLeft, Pencil, Eye, Database, Blocks } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useA2UIStore } from "@/stores/a2ui"
import { useWorkspaceContext, type WorkspaceMode } from "./a2ui-workspace-context"

export function WorkspaceHeader() {
  const t = useTranslations("a2ui")
  const { surfaceId, workspaceMode, setWorkspaceMode } = useWorkspaceContext()
  const surface = useA2UIStore((state) => state.surfaces[surfaceId])

  const title = surface?.title || surfaceId.slice(0, 12)
  const isReady = surface?.ready

  return (
    <header className="flex items-center gap-2 border-b px-3 py-2 shrink-0 min-h-[48px]">
      <Link href="/a2ui" className="shrink-0">
        <Button variant="ghost" size="icon" className="h-8 w-8">
          <ArrowLeft className="h-4 w-4" />
        </Button>
      </Link>

      <div className="flex items-center gap-2 min-w-0 flex-1">
        <Blocks className="h-4 w-4 text-cyan-500 shrink-0" />
        <span className="font-medium text-sm truncate">{title}</span>
        <Badge variant={isReady ? "default" : "secondary"} className="shrink-0 text-[10px] h-5">
          {isReady ? t("previewMode") : "Loading"}
        </Badge>
      </div>

      <Tabs
        value={workspaceMode}
        onValueChange={(v) => setWorkspaceMode(v as WorkspaceMode)}
        className="shrink-0"
      >
        <TabsList className="h-8">
          <TabsTrigger value="edit" className="h-7 text-xs gap-1 px-2">
            <Pencil className="h-3 w-3" />
            <span className="hidden sm:inline">{t("editMode")}</span>
          </TabsTrigger>
          <TabsTrigger value="preview" className="h-7 text-xs gap-1 px-2">
            <Eye className="h-3 w-3" />
            <span className="hidden sm:inline">{t("previewMode")}</span>
          </TabsTrigger>
          <TabsTrigger value="data" className="h-7 text-xs gap-1 px-2">
            <Database className="h-3 w-3" />
            <span className="hidden sm:inline">{t("dataMode")}</span>
          </TabsTrigger>
        </TabsList>
      </Tabs>
    </header>
  )
}
