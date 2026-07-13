"use client"

/**
 * Quick App Builder Component
 * AI-driven interface for quickly building and managing A2UI mini-apps
 *
 * Split into sub-components for maintainability:
 * - quick-app-builder/template-card.tsx — Template card rendering
 * - quick-app-builder/app-card.tsx — App instance card with share menu
 * - quick-app-builder/flash-app-tab.tsx — AI generation tab
 */

import React, { useState, useCallback, useMemo, useRef } from "react"
import { useTranslations } from "next-intl"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Search,
  Sparkles,
  Grid3X3,
  List,
  Zap,
  Download,
  Upload,
  MoreVertical,
  FileJson,
  RefreshCw,
  X,
} from "lucide-react"
import { resolveIcon } from "@/lib/a2ui/resolve-icon"
import { loggers } from "@cognia/logging"
import { useA2UIAppBuilder } from "@/hooks/a2ui/use-app-builder"
import { A2UIInlineSurface } from "./a2ui-surface"
import { templateCategories, type A2UIAppTemplate } from "@/lib/a2ui/templates"
import { generateAppFromDescription } from "@/lib/a2ui/app-generator"
import { useA2UI } from "@/hooks/a2ui"
import { useA2UIDataModel } from "@/hooks/a2ui/use-a2ui-data-model"
import type { ViewMode } from "@/hooks/a2ui/use-app-gallery-filter"
import type { QuickAppBuilderProps, TabValue } from "@/types/a2ui/app"

import { TemplateCard } from "./quick-app-builder/template-card"
import { QuickAppCard } from "./quick-app-builder/quick-app-card"
import { FlashAppTab } from "./quick-app-builder/flash-app-tab"
import { DeleteConfirmDialog } from "./delete-confirm-dialog"

export function QuickAppBuilder({
  className,
  onAction,
  onDataChange,
  onAppSelect,
}: QuickAppBuilderProps) {
  const [searchQuery, setSearchQuery] = useState("")
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null)
  const [viewMode, setViewMode] = useState<ViewMode>("grid")
  const [activeTab, setActiveTab] = useState<TabValue>("flash")
  const [previewAppId, setPreviewAppId] = useState<string | null>(null)
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null)

  const t = useTranslations("a2ui")
  const fileInputRef = useRef<HTMLInputElement>(null)

  const a2ui = useA2UI({ onAction, onDataChange })

  // Reactive data model for the currently previewed app
  const previewDataModel = useA2UIDataModel(previewAppId || "")

  const appBuilder = useA2UIAppBuilder({
    onAction: (action) => {
      appBuilder.handleAppAction(action)
      onAction?.(action)
    },
    onDataChange,
    onAppCreated: (appId) => {
      setPreviewAppId(appId)
      setActiveTab("my-apps")
    },
  })

  // Filter templates based on search and category
  const filteredTemplates = useMemo(() => {
    let templates = appBuilder.templates
    if (searchQuery) templates = appBuilder.searchTemplates(searchQuery)
    if (selectedCategory) templates = templates.filter((t) => t.category === selectedCategory)
    return templates
  }, [appBuilder, searchQuery, selectedCategory])

  const myApps = useMemo(() => appBuilder.getAllApps(), [appBuilder])

  // ========== Handlers ==========

  const handleFlashGenerate = useCallback(
    async (prompt: string) => {
      const generatedApp = generateAppFromDescription({ description: prompt })
      a2ui.processMessages(generatedApp.messages)
      setPreviewAppId(generatedApp.id)
      onAppSelect?.(generatedApp.id)
    },
    [a2ui, onAppSelect]
  )

  const handleCreateFromTemplate = useCallback(
    (template: A2UIAppTemplate) => {
      const appId = appBuilder.createFromTemplate(template.id)
      if (appId) {
        setPreviewAppId(appId)
        onAppSelect?.(appId)
      }
    },
    [appBuilder, onAppSelect]
  )

  const handleSelectApp = useCallback(
    (appId: string) => {
      setPreviewAppId(appId)
      onAppSelect?.(appId)
    },
    [onAppSelect]
  )

  const handleDeleteApp = useCallback((appId: string) => {
    setDeleteConfirmId(appId)
  }, [])

  const handleConfirmDelete = useCallback(() => {
    if (!deleteConfirmId) return
    appBuilder.deleteApp(deleteConfirmId)
    if (previewAppId === deleteConfirmId) setPreviewAppId(null)
    setDeleteConfirmId(null)
  }, [appBuilder, deleteConfirmId, previewAppId])

  const handleDuplicateApp = useCallback(
    (appId: string) => {
      const newAppId = appBuilder.duplicateApp(appId)
      if (newAppId) setPreviewAppId(newAppId)
    },
    [appBuilder]
  )

  const handleDownloadApp = useCallback(
    (appId: string) => {
      appBuilder.downloadApp(appId)
    },
    [appBuilder]
  )

  const handleCopyToClipboard = useCallback(
    async (appId: string, format: "json" | "code" | "url") => {
      return appBuilder.copyAppToClipboard(appId, format)
    },
    [appBuilder]
  )

  const handleNativeShare = useCallback(
    async (appId: string) => {
      await appBuilder.shareAppNative(appId)
    },
    [appBuilder]
  )

  const handleSocialShare = useCallback(
    (appId: string, platform: string) => {
      const urls = appBuilder.getSocialShareUrls(appId)
      if (urls && urls[platform]) {
        window.open(urls[platform], "_blank", "noopener,noreferrer")
      }
    },
    [appBuilder]
  )

  const handleImportClick = useCallback(() => {
    fileInputRef.current?.click()
  }, [])

  const handleFileImport = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (!file) return
      try {
        const appId = await appBuilder.importAppFromFile(file)
        if (appId) {
          setPreviewAppId(appId)
          setActiveTab("my-apps")
        }
      } catch (error) {
        loggers.ui.error("[QuickAppBuilder] Import failed:", error)
      }
      e.target.value = ""
    },
    [appBuilder]
  )

  const handleExportAllApps = useCallback(() => {
    const jsonData = appBuilder.exportAllApps()
    const blob = new Blob([jsonData], { type: "application/json" })
    const url = URL.createObjectURL(blob)
    const link = document.createElement("a")
    link.href = url
    link.download = `a2ui-apps-backup-${Date.now()}.json`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
  }, [appBuilder])

  return (
    <div className={cn("flex flex-col h-full", className)}>
      {/* Header */}
      <div className="flex items-center justify-between p-3 sm:p-4 border-b">
        <div className="flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-primary" />
          <h2 className="font-semibold text-sm sm:text-base">{t("quickApps")}</h2>
        </div>
        <div className="flex items-center gap-1 sm:gap-2">
          <Button
            size="icon"
            variant={viewMode === "grid" ? "secondary" : "ghost"}
            className="h-8 w-8 touch-manipulation"
            onClick={() => setViewMode("grid")}
          >
            <Grid3X3 className="h-4 w-4" />
          </Button>
          <Button
            size="icon"
            variant={viewMode === "list" ? "secondary" : "ghost"}
            className="h-8 w-8 touch-manipulation"
            onClick={() => setViewMode("list")}
          >
            <List className="h-4 w-4" />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon" variant="ghost" className="h-8 w-8 touch-manipulation">
                <MoreVertical className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={handleImportClick}>
                <Upload className="h-4 w-4 mr-2" />
                {t("importApp")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleExportAllApps}>
                <Download className="h-4 w-4 mr-2" />
                {t("exportAllApps")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => fileInputRef.current?.click()}>
                <FileJson className="h-4 w-4 mr-2" />
                {t("importFromFile")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json"
            className="hidden"
            onChange={handleFileImport}
          />
        </div>
      </div>

      {/* Search */}
      <div className="p-3 sm:p-4 border-b">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t("searchPlaceholder")}
            className="pl-9 text-sm sm:text-base"
          />
        </div>
      </div>

      {/* Tabs */}
      <Tabs
        value={activeTab}
        onValueChange={(v) => setActiveTab(v as TabValue)}
        className="flex-1 flex flex-col overflow-hidden"
      >
        <TabsList className="mx-3 sm:mx-4 mt-2 h-auto flex-wrap sm:flex-nowrap">
          <TabsTrigger value="flash" className="flex-1 text-xs sm:text-sm py-2 touch-manipulation">
            <Zap className="h-3 w-3 sm:h-4 sm:w-4 mr-1" />
            <span className="hidden xs:inline">{t("flashTabShort")}</span>
            {t("flashTab").replace(t("flashTabShort"), "")}
          </TabsTrigger>
          <TabsTrigger
            value="templates"
            className="flex-1 text-xs sm:text-sm py-2 touch-manipulation"
          >
            {t("templatesTab")}
          </TabsTrigger>
          <TabsTrigger
            value="my-apps"
            className="flex-1 text-xs sm:text-sm py-2 touch-manipulation"
          >
            {t("myAppsTab")} ({myApps.length})
          </TabsTrigger>
        </TabsList>

        {/* Flash App Tab */}
        <TabsContent value="flash" className="flex-1 overflow-hidden mt-0">
          <FlashAppTab onGenerate={handleFlashGenerate} />
        </TabsContent>

        {/* Templates Tab */}
        <TabsContent value="templates" className="flex-1 overflow-hidden mt-0">
          <div className="flex flex-col sm:flex-row h-full">
            {/* Category filter - horizontal scroll on mobile, sidebar on desktop */}
            <div className="sm:w-36 md:w-40 sm:border-r border-b sm:border-b-0">
              <div className="flex sm:hidden gap-1 p-2 overflow-x-auto">
                <Button
                  variant={selectedCategory === null ? "secondary" : "outline"}
                  size="sm"
                  className="flex-shrink-0 text-xs h-8 touch-manipulation"
                  onClick={() => setSelectedCategory(null)}
                >
                  {t("allCategories")}
                </Button>
                {templateCategories.map((cat) => {
                  const CatIcon = resolveIcon(cat.icon)
                  return (
                    <Button
                      key={cat.id}
                      variant={selectedCategory === cat.id ? "secondary" : "outline"}
                      size="sm"
                      className="flex-shrink-0 text-xs h-8 touch-manipulation"
                      onClick={() => setSelectedCategory(cat.id)}
                    >
                      {CatIcon && <CatIcon className="h-3 w-3 mr-1" />}
                      {cat.name}
                    </Button>
                  )
                })}
              </div>
              <div className="hidden sm:block p-2 space-y-1">
                <Button
                  variant={selectedCategory === null ? "secondary" : "ghost"}
                  className="w-full justify-start text-xs sm:text-sm touch-manipulation"
                  onClick={() => setSelectedCategory(null)}
                >
                  {t("allTemplates")}
                </Button>
                {templateCategories.map((cat) => {
                  const CatIcon = resolveIcon(cat.icon)
                  return (
                    <Button
                      key={cat.id}
                      variant={selectedCategory === cat.id ? "secondary" : "ghost"}
                      className="w-full justify-start text-xs sm:text-sm touch-manipulation"
                      onClick={() => setSelectedCategory(cat.id)}
                    >
                      {CatIcon && <CatIcon className="h-4 w-4 mr-2" />}
                      {cat.name}
                    </Button>
                  )
                })}
              </div>
            </div>

            <ScrollArea className="flex-1">
              <div
                className={cn(
                  "p-3 sm:p-4",
                  viewMode === "grid"
                    ? "grid grid-cols-1 sm:grid-cols-2 gap-2 sm:gap-3"
                    : "space-y-2"
                )}
              >
                {filteredTemplates.map((template) => (
                  <TemplateCard
                    key={template.id}
                    template={template}
                    viewMode={viewMode}
                    onSelect={handleCreateFromTemplate}
                  />
                ))}
                {filteredTemplates.length === 0 && (
                  <div className="col-span-full text-center py-8 text-muted-foreground text-sm">
                    {t("noTemplatesFound")}
                  </div>
                )}
              </div>
            </ScrollArea>
          </div>
        </TabsContent>

        {/* My Apps Tab */}
        <TabsContent value="my-apps" className="flex-1 overflow-hidden mt-0">
          <ScrollArea className="h-full">
            <div
              className={cn(
                "p-3 sm:p-4",
                viewMode === "grid" ? "grid grid-cols-1 sm:grid-cols-2 gap-2 sm:gap-3" : "space-y-2"
              )}
            >
              {myApps.map((app) => (
                <QuickAppCard
                  key={app.id}
                  app={app}
                  template={appBuilder.getTemplate(app.templateId)}
                  isActive={previewAppId === app.id}
                  viewMode={viewMode}
                  onSelect={handleSelectApp}
                  onDuplicate={handleDuplicateApp}
                  onDownload={handleDownloadApp}
                  onDelete={handleDeleteApp}
                  onCopyToClipboard={handleCopyToClipboard}
                  onNativeShare={handleNativeShare}
                  onSocialShare={handleSocialShare}
                />
              ))}
              {myApps.length === 0 && (
                <div className="col-span-full text-center py-8 text-muted-foreground">
                  <p className="mb-2 text-sm">{t("noAppsYet")}</p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="touch-manipulation"
                    onClick={() => setActiveTab("flash")}
                  >
                    {t("createFirstApp")}
                  </Button>
                </div>
              )}
            </div>
          </ScrollArea>
        </TabsContent>
      </Tabs>

      {/* Preview panel */}
      {previewAppId && (
        <div className="border-t">
          <div className="flex items-center justify-between p-2 bg-muted/50">
            <span className="text-xs sm:text-sm font-medium px-2 truncate flex-1">
              {appBuilder.getAppInstance(previewAppId)?.name || t("appPreview")}
              {Object.keys(previewDataModel.dataModel).length > 0 && (
                <span className="ml-1 text-[10px] text-muted-foreground">
                  {/* i18n-exempt: pre-existing untranslated surface (repo i18n baseline); untouched by ADR-0068 import codemod */}
                  ({Object.keys(previewDataModel.dataModel).length} fields)
                </span>
              )}
            </span>
            <div className="flex items-center gap-1 flex-shrink-0">
              <Button
                size="icon"
                variant="ghost"
                className="h-8 w-8 touch-manipulation"
                onClick={() => appBuilder.resetAppData(previewAppId)}
              >
                <RefreshCw className="h-4 w-4" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="h-8 w-8 touch-manipulation"
                onClick={() => setPreviewAppId(null)}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>
          <div className="max-h-80 overflow-auto">
            <A2UIInlineSurface
              surfaceId={previewAppId}
              onAction={onAction}
              onDataChange={onDataChange}
            />
          </div>
        </div>
      )}

      <DeleteConfirmDialog
        open={!!deleteConfirmId}
        onOpenChange={() => setDeleteConfirmId(null)}
        onConfirm={handleConfirmDelete}
      />
    </div>
  )
}
