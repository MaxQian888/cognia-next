"use client"

/**
 * A2UI App Gallery Component
 * Displays and manages created A2UI mini-apps in a gallery view
 * Enhanced with thumbnail support, metadata display, and app store preparation
 */

import React, { useState, useCallback, useMemo } from "react"
import { useTranslations } from "next-intl"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { DeleteConfirmDialog } from "./delete-confirm-dialog"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import {
  Search,
  ExternalLink,
  Sparkles,
  LayoutGrid,
  LayoutList,
  Filter,
  SortAsc,
  SortDesc,
} from "lucide-react"
import { loggers } from "@cognia/logging"
import { useA2UIAppBuilder, type A2UIAppInstance } from "@/hooks/a2ui/use-app-builder"
import { useAppGalleryFilter } from "@/hooks/a2ui/use-app-gallery-filter"
import { CATEGORY_KEYS, CATEGORY_I18N_MAP } from "@/lib/a2ui/constants"
import type { SortField } from "@/hooks/a2ui/use-app-gallery-filter"
import { A2UIInlineSurface } from "./a2ui-surface"
import { AppCard } from "./a2ui-app-card"
import { AppDetailDialog } from "./app-detail-dialog"
import { captureSurfaceThumbnail } from "@/lib/a2ui/thumbnail"
import type { AppGalleryProps } from "@/types/a2ui/app"

export function AppGallery({
  className,
  onAction,
  onDataChange,
  onAppOpen,
  showPreview = true,
  showThumbnails = true,
  columns = 2,
  defaultViewMode = "grid",
}: AppGalleryProps) {
  const t = useTranslations("a2ui")
  const CATEGORY_OPTIONS = useMemo(
    () => [
      { value: "all", label: t("allCategoriesFilter") },
      ...CATEGORY_KEYS.map((key) => ({ value: key, label: t(CATEGORY_I18N_MAP[key]) })),
    ],
    [t]
  )
  const [selectedAppId, setSelectedAppId] = useState<string | null>(null)
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null)
  const [renameDialogId, setRenameDialogId] = useState<string | null>(null)
  const [newName, setNewName] = useState("")
  const [detailApp, setDetailApp] = useState<A2UIAppInstance | null>(null)

  const appBuilder = useA2UIAppBuilder({
    // Built-in actions are handled app-wide by <A2UIBuiltInActionsProvider>.
    onAction,
    onDataChange,
  })

  const {
    searchQuery,
    setSearchQuery,
    viewMode,
    setViewMode,
    categoryFilter,
    setCategoryFilter,
    sortField,
    setSortField,
    sortOrder,
    toggleSortOrder,
    filteredApps: apps,
  } = useAppGalleryFilter(appBuilder.getAllApps(), {
    defaultViewMode,
    getTemplate: appBuilder.getTemplate,
  })

  // Handle app selection
  const handleSelectApp = useCallback(
    (appId: string) => {
      setSelectedAppId(appId)
      onAppOpen?.(appId)
    },
    [onAppOpen]
  )

  // Handle delete
  const handleDelete = useCallback(
    (appId: string) => {
      appBuilder.deleteApp(appId)
      if (selectedAppId === appId) {
        setSelectedAppId(null)
      }
      setDeleteConfirmId(null)
    },
    [appBuilder, selectedAppId]
  )

  // Handle thumbnail generation
  const handleThumbnailGenerated = useCallback(
    (appId: string, thumbnail: string) => {
      appBuilder.setAppThumbnail(appId, thumbnail)
    },
    [appBuilder]
  )

  // Handle generate thumbnail for selected app
  const handleGenerateThumbnail = useCallback(
    async (appId: string) => {
      try {
        const result = await captureSurfaceThumbnail(appId)
        if (result) {
          appBuilder.setAppThumbnail(appId, result.dataUrl)
        }
      } catch (error) {
        loggers.ui.error("[AppGallery] Failed to generate thumbnail:", error)
      }
    },
    [appBuilder]
  )

  // Handle metadata save
  const handleMetadataSave = useCallback(
    (appId: string, metadata: Partial<A2UIAppInstance>) => {
      appBuilder.updateAppMetadata(appId, metadata)
    },
    [appBuilder]
  )

  // Handle view details
  const handleViewDetails = useCallback(
    (app: A2UIAppInstance) => {
      setDetailApp(app)
      appBuilder.incrementAppViews(app.id)
    },
    [appBuilder]
  )

  // Handle duplicate
  const handleDuplicate = useCallback(
    (appId: string) => {
      const newAppId = appBuilder.duplicateApp(appId)
      if (newAppId) {
        setSelectedAppId(newAppId)
      }
    },
    [appBuilder]
  )

  // Handle rename
  const handleRename = useCallback(() => {
    if (renameDialogId && newName.trim()) {
      appBuilder.renameApp(renameDialogId, newName.trim())
      setRenameDialogId(null)
      setNewName("")
    }
  }, [appBuilder, renameDialogId, newName])

  // Open rename dialog
  const openRenameDialog = useCallback((app: A2UIAppInstance) => {
    setRenameDialogId(app.id)
    setNewName(app.name)
  }, [])

  // Get column class
  const getGridClass = () => {
    if (viewMode === "list") return "grid-cols-1"
    switch (columns) {
      case 1:
        return "grid-cols-1"
      case 2:
        return "grid-cols-1 md:grid-cols-2"
      case 3:
        return "grid-cols-1 md:grid-cols-2 lg:grid-cols-3"
      case 4:
        return "grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
      default:
        return "grid-cols-1 md:grid-cols-2"
    }
  }

  // Render app card
  const renderAppCard = (app: A2UIAppInstance) => {
    const template = appBuilder.getTemplate(app.templateId)
    const isSelected = selectedAppId === app.id

    return (
      <AppCard
        key={app.id}
        app={app}
        template={template}
        isSelected={isSelected}
        showThumbnail={showThumbnails && viewMode === "grid"}
        showStats={true}
        showDescription={viewMode === "grid"}
        compact={viewMode === "list"}
        onSelect={handleSelectApp}
        onOpen={onAppOpen}
        onRename={openRenameDialog}
        onDuplicate={handleDuplicate}
        onDelete={(id) => setDeleteConfirmId(id)}
        onReset={(id) => appBuilder.resetAppData(id)}
        onViewDetails={handleViewDetails}
        onThumbnailGenerated={handleThumbnailGenerated}
      />
    )
  }

  return (
    <div className={cn("flex flex-col h-full", className)}>
      {/* Header - Mobile optimized */}
      <div className="flex items-center justify-between p-3 sm:p-4 border-b">
        <div className="flex items-center gap-2">
          <LayoutGrid className="h-5 w-5 text-primary" />
          <h2 className="font-semibold text-sm sm:text-base">{t("gallery")}</h2>
          <Badge variant="secondary" className="ml-1 sm:ml-2 text-xs">
            {apps.length}
          </Badge>
        </div>
        <div className="flex items-center gap-1">
          {/* View mode toggle */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon"
                variant={viewMode === "grid" ? "secondary" : "ghost"}
                className="h-8 w-8"
                onClick={() => setViewMode("grid")}
              >
                <LayoutGrid className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("gridView")}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon"
                variant={viewMode === "list" ? "secondary" : "ghost"}
                className="h-8 w-8"
                onClick={() => setViewMode("list")}
              >
                <LayoutList className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("listView")}</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* Search and Filters */}
      <div className="p-3 sm:p-4 border-b space-y-2">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t("searchPlaceholder")}
              className="pl-9 text-sm sm:text-base"
            />
          </div>
          {/* Category filter */}
          <Select value={categoryFilter} onValueChange={setCategoryFilter}>
            <SelectTrigger className="w-32 sm:w-36">
              <Filter className="h-4 w-4 mr-1" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CATEGORY_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {/* Sort options */}
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {/* i18n-exempt: pre-existing untranslated surface (repo i18n baseline); untouched by ADR-0068 import codemod */}
          <span>Sort:</span>
          <Select value={sortField} onValueChange={(v) => setSortField(v as SortField)}>
            <SelectTrigger className="h-7 w-24 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="lastModified">{t("lastModified")}</SelectItem>
              <SelectItem value="createdAt">{t("created")}</SelectItem>
              <SelectItem value="name">{t("sortByName")}</SelectItem>
            </SelectContent>
          </Select>
          <Button size="icon" variant="ghost" className="h-7 w-7" onClick={toggleSortOrder}>
            {sortOrder === "asc" ? (
              <SortAsc className="h-3 w-3" />
            ) : (
              <SortDesc className="h-3 w-3" />
            )}
          </Button>
        </div>
      </div>

      {/* Content - Mobile optimized with responsive preview */}
      <div className="flex-1 flex flex-col sm:flex-row overflow-hidden">
        {/* Apps list */}
        <ScrollArea className={cn("flex-1", showPreview && selectedAppId && "sm:w-1/2")}>
          <div className={cn("p-3 sm:p-4 grid gap-2 sm:gap-3", getGridClass())}>
            {apps.map(renderAppCard)}
            {apps.length === 0 && (
              <div className="col-span-full text-center py-8 sm:py-12 text-muted-foreground">
                <Sparkles className="h-10 w-10 sm:h-12 sm:w-12 mx-auto mb-3 sm:mb-4 opacity-50" />
                <p className="text-base sm:text-lg font-medium">{t("noAppsYet")}</p>
                <p className="text-xs sm:text-sm">{t("tryCreating")}</p>
              </div>
            )}
          </div>
        </ScrollArea>

        {/* Preview panel - Desktop: side panel, Mobile: bottom sheet */}
        {showPreview && selectedAppId && (
          <>
            {/* Desktop side panel */}
            <div className="hidden sm:flex sm:w-1/2 border-l flex-col">
              <div className="flex items-center justify-between p-2 bg-muted/50 border-b">
                <span className="text-sm font-medium px-2 truncate">
                  {appBuilder.getAppInstance(selectedAppId)?.name || t("appPreview")}
                </span>
                <div className="flex items-center gap-1 flex-shrink-0">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="touch-manipulation"
                    onClick={() => onAppOpen?.(selectedAppId)}
                  >
                    <ExternalLink className="h-4 w-4 mr-1" />
                    {t("run")}
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-8 w-8 touch-manipulation"
                    onClick={() => setSelectedAppId(null)}
                  >
                    ×
                  </Button>
                </div>
              </div>
              <ScrollArea className="flex-1">
                <A2UIInlineSurface
                  surfaceId={selectedAppId}
                  onAction={onAction}
                  onDataChange={onDataChange}
                />
              </ScrollArea>
            </div>
            {/* Mobile bottom sheet */}
            <div className="sm:hidden border-t max-h-[50vh] flex flex-col">
              <div className="flex items-center justify-between p-2 bg-muted/50 border-b">
                <span className="text-xs font-medium px-2 truncate flex-1">
                  {appBuilder.getAppInstance(selectedAppId)?.name || t("appPreview")}
                </span>
                <div className="flex items-center gap-1 flex-shrink-0">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-8 text-xs touch-manipulation"
                    onClick={() => onAppOpen?.(selectedAppId)}
                  >
                    <ExternalLink className="h-3 w-3 mr-1" />
                    {t("run")}
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-8 w-8 touch-manipulation"
                    onClick={() => setSelectedAppId(null)}
                  >
                    ×
                  </Button>
                </div>
              </div>
              {/* Surface rendered only in mobile container — desktop uses its own above */}
            </div>
          </>
        )}
      </div>

      <DeleteConfirmDialog
        open={!!deleteConfirmId}
        onOpenChange={() => setDeleteConfirmId(null)}
        onConfirm={() => deleteConfirmId && handleDelete(deleteConfirmId)}
      />

      {/* Rename dialog */}
      <Dialog open={!!renameDialogId} onOpenChange={() => setRenameDialogId(null)}>
        <DialogContent className="max-w-[90vw] sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("appName")}</DialogTitle>
            <DialogDescription>{t("appDescription")}</DialogDescription>
          </DialogHeader>
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder={t("appName")}
            className="text-sm sm:text-base"
            onKeyDown={(e) => e.key === "Enter" && handleRename()}
          />
          <DialogFooter className="flex-col sm:flex-row gap-2">
            <Button
              variant="outline"
              className="w-full sm:w-auto touch-manipulation"
              onClick={() => setRenameDialogId(null)}
            >
              {t("cancel")}
            </Button>
            <Button
              className="w-full sm:w-auto touch-manipulation"
              onClick={handleRename}
              disabled={!newName.trim()}
            >
              {t("save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* App detail dialog */}
      <AppDetailDialog
        app={detailApp}
        template={detailApp ? appBuilder.getTemplate(detailApp.templateId) : undefined}
        open={!!detailApp}
        onOpenChange={(open) => !open && setDetailApp(null)}
        onSave={handleMetadataSave}
        onGenerateThumbnail={handleGenerateThumbnail}
        onPreparePublish={appBuilder.prepareForPublish}
      />
    </div>
  )
}
