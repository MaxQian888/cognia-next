"use client"

/**
 * A2UI Mini-Apps Page
 * Standalone hub for browsing, creating, and editing A2UI mini-apps
 * Two modes: Hub (discovery + creation) and Workspace (editing a specific app)
 */

import {
  Suspense,
  type ChangeEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { useSearchParams, useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import Link from "next/link"
import {
  ArrowLeft,
  Blocks,
  Calendar,
  Copy,
  Download,
  Edit,
  Eye,
  Grid3X3,
  List,
  Loader2,
  MoreVertical,
  Search,
  SortAsc,
  Sparkles,
  Trash2,
  Upload,
  X,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useA2UIAppBuilder } from "@/hooks/a2ui/use-app-builder"
import { type ViewMode } from "@/hooks/a2ui/use-app-gallery-filter"
import { generateAppFromDescription } from "@/lib/a2ui/app-generator"
import { appTemplates, getTemplatesByCategory, searchTemplates } from "@/lib/a2ui/templates"
import { CATEGORY_KEYS, CATEGORY_I18N_MAP } from "@/lib/a2ui/constants"
import { A2UIInlineSurface } from "@/components/a2ui/a2ui-surface"
import { AppDetailDialog } from "@/components/a2ui/app-detail-dialog"
import { DeleteConfirmDialog } from "@/components/a2ui/delete-confirm-dialog"
import { TemplateCard } from "@/components/a2ui/quick-app-builder/template-card"
import { A2UIWorkspace } from "@/components/a2ui/workspace/a2ui-workspace"
import { cn } from "@/lib/utils"
import { loggers } from "@/lib/logger"
import { toast } from "sonner"
import type { A2UIAppTemplate } from "@/lib/a2ui/templates"

type SortOption = "newest" | "oldest" | "name" | "mostUsed"

const QUICK_SUGGESTIONS = [
  "Pomodoro Timer",
  "Expense Tracker",
  "BMI Calculator",
  "Habit Tracker",
  "Todo List",
  "Unit Converter",
]

function downloadJson(filename: string, content: string) {
  const blob = new Blob([content], { type: "application/json" })
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}

function A2UIPageContent() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const t = useTranslations("a2ui")
  const promptRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const appIdFromUrl = searchParams.get("app")
  const actionFromUrl = searchParams.get("action")

  const [searchQuery, setSearchQuery] = useState("")
  const [sortBy, setSortBy] = useState<SortOption>("newest")
  const [viewMode, setViewMode] = useState<ViewMode>("grid")
  const [selectedCategory, setSelectedCategory] = useState<A2UIAppTemplate["category"] | null>(null)
  const [heroPrompt, setHeroPrompt] = useState("")
  const [isGenerating, setIsGenerating] = useState(false)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [appToDelete, setAppToDelete] = useState<string | null>(null)
  const [previewAppId, setPreviewAppId] = useState<string | null>(null)
  const [detailAppId, setDetailAppId] = useState<string | null>(null)
  const urlActionHandledRef = useRef(false)

  const appBuilder = useA2UIAppBuilder({
    onAppCreated: (appId) => {
      setPreviewAppId(appId)
      toast.success(t("appCreated") || "App created!")
    },
  })

  const allApps = useMemo(() => appBuilder.getAllApps(), [appBuilder])

  const filteredApps = useMemo(() => {
    let list = [...allApps]

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      list = list.filter(
        (app) =>
          app.name.toLowerCase().includes(q) ||
          app.description?.toLowerCase().includes(q) ||
          app.tags?.some((tag) => tag.toLowerCase().includes(q))
      )
    }

    if (selectedCategory) {
      list = list.filter((app) => app.category === selectedCategory)
    }

    switch (sortBy) {
      case "newest":
        list.sort((a, b) => b.lastModified - a.lastModified)
        break
      case "oldest":
        list.sort((a, b) => a.lastModified - b.lastModified)
        break
      case "name":
        list.sort((a, b) => a.name.localeCompare(b.name))
        break
      case "mostUsed":
        list.sort((a, b) => (b.stats?.uses || 0) - (a.stats?.uses || 0))
        break
    }

    return list
  }, [allApps, searchQuery, selectedCategory, sortBy])

  const filteredTemplates = useMemo(() => {
    if (searchQuery.trim()) {
      return searchTemplates(searchQuery)
    }
    if (selectedCategory) {
      return getTemplatesByCategory(selectedCategory)
    }
    return appTemplates
  }, [searchQuery, selectedCategory])

  const featuredTemplates = useMemo(() => filteredTemplates.slice(0, 3), [filteredTemplates])
  const recentApp = filteredApps[0] ?? null
  const libraryApps = recentApp ? filteredApps.slice(1) : filteredApps

  const detailApp = useMemo(
    () => (detailAppId ? (allApps.find((app) => app.id === detailAppId) ?? null) : null),
    [allApps, detailAppId]
  )
  const detailTemplate = useMemo(
    () => (detailApp ? appBuilder.getTemplate(detailApp.templateId) : undefined),
    [appBuilder, detailApp]
  )

  const focusCreatePrompt = useCallback(() => {
    promptRef.current?.focus()
    if (typeof promptRef.current?.scrollIntoView === "function") {
      promptRef.current.scrollIntoView({ block: "center" })
    }
  }, [])

  useEffect(() => {
    if (urlActionHandledRef.current || !actionFromUrl) return
    if (actionFromUrl === "create") {
      focusCreatePrompt()
      router.replace("/a2ui")
      urlActionHandledRef.current = true
    }
  }, [actionFromUrl, focusCreatePrompt, router])

  const handleFlashGenerate = useCallback(async () => {
    if (!heroPrompt.trim() || isGenerating) return
    setIsGenerating(true)
    try {
      const result = generateAppFromDescription({ description: heroPrompt })
      appBuilder.createCustomApp(result.name, result.components, result.dataModel)
      setHeroPrompt("")
    } catch (err) {
      loggers.a2ui?.error("Flash generation failed", err)
      toast.error(t("generationFailed") || "Failed to generate app")
    } finally {
      setIsGenerating(false)
    }
  }, [appBuilder, heroPrompt, isGenerating, t])

  const handleSuggestionClick = useCallback((suggestion: string) => {
    setHeroPrompt(suggestion)
    if (document.activeElement !== promptRef.current) {
      promptRef.current?.focus()
    }
  }, [])

  const handleTemplateSelect = useCallback(
    (template: A2UIAppTemplate) => {
      try {
        appBuilder.createFromTemplate(template.id)
      } catch (err) {
        loggers.a2ui?.error("Template creation failed", err)
        toast.error(t("generationFailed") || "Failed to create from template")
      }
    },
    [appBuilder, t]
  )

  const handleDeleteApp = useCallback((appId: string) => {
    setAppToDelete(appId)
    setDeleteDialogOpen(true)
  }, [])

  const handleConfirmDelete = useCallback(() => {
    if (!appToDelete) return
    appBuilder.deleteApp(appToDelete)
    setDeleteDialogOpen(false)
    setAppToDelete(null)
    if (previewAppId === appToDelete) setPreviewAppId(null)
    toast.success(t("appDeleted") || "App deleted")
  }, [appBuilder, appToDelete, previewAppId, t])

  const handleDuplicate = useCallback(
    (appId: string) => {
      try {
        const duplicatedAppId = appBuilder.duplicateApp(appId)
        if (duplicatedAppId) {
          setPreviewAppId(duplicatedAppId)
          toast.success(t("appDuplicated") || "App duplicated")
        }
      } catch (err) {
        loggers.a2ui?.error("Duplicate failed", err)
      }
    },
    [appBuilder, t]
  )

  const handleExport = useCallback(
    (appId: string) => {
      try {
        if (typeof appBuilder.downloadApp === "function") {
          const ok = appBuilder.downloadApp(appId)
          if (!ok) throw new Error(`Unable to export app: ${appId}`)
        } else {
          const payload = appBuilder.exportApp(appId)
          if (!payload) throw new Error(`Unable to export app: ${appId}`)
          downloadJson(`${appId}-${Date.now()}.json`, payload)
        }
        toast.success(t("appExported") || "App exported")
      } catch (err) {
        loggers.a2ui?.error("Export failed", err)
      }
    },
    [appBuilder, t]
  )

  const handleExportAll = useCallback(() => {
    if (typeof appBuilder.exportAllApps !== "function" || allApps.length === 0) return
    try {
      const payload = appBuilder.exportAllApps()
      downloadJson(`a2ui-apps-${Date.now()}.json`, payload)
      toast.success(t("appExported") || "App exported")
    } catch (err) {
      loggers.a2ui?.error("Export all failed", err)
    }
  }, [allApps.length, appBuilder, t])

  const handleImportClick = useCallback(() => {
    fileInputRef.current?.click()
  }, [])

  const handleImportFile = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0]
      if (!file || typeof appBuilder.importAppFromFile !== "function") return

      try {
        const appId = await appBuilder.importAppFromFile(file)
        if (!appId) {
          toast.error(t("generationFailed") || "Failed to import app")
        }
      } catch (err) {
        loggers.a2ui?.error("Import failed", err)
        toast.error(t("generationFailed") || "Failed to import app")
      } finally {
        event.target.value = ""
      }
    },
    [appBuilder, t]
  )

  const handleOpenWorkspace = useCallback(
    (appId: string) => {
      router.push(`/a2ui?app=${appId}`)
    },
    [router]
  )

  if (appIdFromUrl) {
    return <A2UIWorkspace surfaceId={appIdFromUrl} />
  }

  return (
    <div className="flex h-full flex-col" data-bg-target="chat">
      <header className="shrink-0 border-b bg-background/95 backdrop-blur">
        <div className="mx-auto flex w-full max-w-7xl flex-wrap items-start gap-3 px-4 py-4 sm:px-6">
          <Link href="/" className="shrink-0">
            <Button variant="ghost" size="icon" className="h-9 w-9">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <Blocks className="h-5 w-5 shrink-0 text-cyan-500" />
              <h1 className="truncate text-lg font-semibold sm:text-xl">
                {t("pageTitle") || "Mini Apps"}
              </h1>
              <Badge variant="secondary" className="shrink-0">
                {allApps.length}
              </Badge>
              <Badge variant="outline" className="shrink-0">
                {appTemplates.length} {t("templatesTab")}
              </Badge>
            </div>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{t("hubSummary")}</p>
          </div>

          <div className="flex w-full flex-wrap items-center justify-end gap-2 sm:w-auto">
            <Button variant="outline" className="gap-1.5" onClick={handleImportClick}>
              <Upload className="h-4 w-4" />
              {t("importApp")}
            </Button>
            <Button
              variant="outline"
              className="gap-1.5"
              onClick={handleExportAll}
              disabled={allApps.length === 0}
            >
              <Download className="h-4 w-4" />
              {t("exportAllApps")}
            </Button>
            <Button className="gap-1.5" onClick={focusCreatePrompt}>
              <Sparkles className="h-4 w-4" />
              {t("newApp")}
            </Button>
          </div>
        </div>
      </header>

      <main className="flex-1 overflow-hidden">
        <ScrollArea className="h-full">
          <div className="mx-auto grid w-full max-w-7xl gap-6 px-4 py-6 sm:px-6 lg:grid-cols-[minmax(0,1.35fr)_360px] lg:items-start">
            <section className="order-2 space-y-6 lg:order-1">
              <section
                aria-labelledby="continue-working-heading"
                className="space-y-4 rounded-3xl border bg-card/50 p-4 shadow-sm sm:p-5"
              >
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <h2
                      id="continue-working-heading"
                      className="text-base font-semibold sm:text-lg"
                    >
                      {t("continueWorking")}
                    </h2>
                    <p className="text-sm text-muted-foreground">
                      {t("manageApps") || "Manage your created apps"}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="secondary">
                      {allApps.length} {t("allApps")}
                    </Badge>
                    <Badge variant="outline">
                      {featuredTemplates.length} {t("featuredTemplates")}
                    </Badge>
                  </div>
                </div>

                {recentApp ? (
                  <Card
                    className="overflow-hidden border-border/60 bg-background/80"
                    onClick={() => handleOpenWorkspace(recentApp.id)}
                  >
                    <div className="grid gap-0 md:grid-cols-[minmax(0,1.2fr)_minmax(260px,0.8fr)]">
                      <div className="min-h-[220px] border-b bg-muted/30 p-4 md:border-b-0 md:border-r">
                        <A2UIInlineSurface
                          surfaceId={recentApp.id}
                          className="pointer-events-none min-h-[180px] scale-[0.8] origin-top-left"
                        />
                      </div>
                      <div className="flex flex-col justify-between gap-4 p-5">
                        <div className="space-y-2">
                          <Badge variant="secondary" className="w-fit">
                            {t("recentlyEdited")}
                          </Badge>
                          <div>
                            <CardTitle className="text-lg">{recentApp.name}</CardTitle>
                            <CardDescription className="mt-1">
                              {recentApp.description || t("manageApps")}
                            </CardDescription>
                          </div>
                          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                            <span className="inline-flex items-center gap-1">
                              <Calendar className="h-3.5 w-3.5" />
                              {new Date(recentApp.lastModified).toLocaleDateString()}
                            </span>
                            {recentApp.category && (
                              <Badge variant="outline">
                                {t(CATEGORY_I18N_MAP[recentApp.category]) || recentApp.category}
                              </Badge>
                            )}
                          </div>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <Button
                            size="sm"
                            className="gap-1.5"
                            onClick={(event) => {
                              event.stopPropagation()
                              handleOpenWorkspace(recentApp.id)
                            }}
                          >
                            <Edit className="h-3.5 w-3.5" />
                            {t("editApp")}
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="gap-1.5"
                            onClick={(event) => {
                              event.stopPropagation()
                              setPreviewAppId(recentApp.id)
                            }}
                          >
                            <Eye className="h-3.5 w-3.5" />
                            {t("appPreview")}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="gap-1.5"
                            onClick={(event) => {
                              event.stopPropagation()
                              setDetailAppId(recentApp.id)
                            }}
                          >
                            <Blocks className="h-3.5 w-3.5" />
                            {t("appDetail")}
                          </Button>
                        </div>
                      </div>
                    </div>
                  </Card>
                ) : (
                  <div className="rounded-2xl border border-dashed border-border/60 bg-muted/20 p-6">
                    <div className="flex flex-col items-start gap-2 text-left">
                      <div className="rounded-2xl bg-cyan-500/10 p-3 text-cyan-500">
                        <Blocks className="h-5 w-5" />
                      </div>
                      <div className="space-y-1">
                        <h3 className="font-medium">{t("noAppsYet")}</h3>
                        <p className="text-sm text-muted-foreground">{t("createFirstApp")}</p>
                      </div>
                      <Button size="sm" className="gap-1.5" onClick={focusCreatePrompt}>
                        <Sparkles className="h-4 w-4" />
                        {t("newApp")}
                      </Button>
                    </div>
                  </div>
                )}
              </section>

              <section className="space-y-4 rounded-3xl border bg-card/50 p-4 shadow-sm sm:p-5">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                  <div className="space-y-1">
                    <h3 className="text-base font-semibold">{t("allApps")}</h3>
                    <p className="text-sm text-muted-foreground">{t("searchAndManageApps")}</p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <div className="relative min-w-[220px] flex-1 lg:min-w-[260px]">
                      <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                      <Input
                        placeholder={t("searchPlaceholder")}
                        value={searchQuery}
                        onChange={(event) => setSearchQuery(event.target.value)}
                        className="pl-9"
                      />
                      {searchQuery && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="absolute right-1 top-1 h-7 w-7"
                          onClick={() => setSearchQuery("")}
                        >
                          <X className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </div>

                    <Select
                      value={sortBy}
                      onValueChange={(value) => setSortBy(value as SortOption)}
                    >
                      <SelectTrigger className="w-[140px]">
                        <SortAsc className="mr-1 h-4 w-4" />
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="newest">{t("sortByNewest")}</SelectItem>
                        <SelectItem value="oldest">{t("sortOldest")}</SelectItem>
                        <SelectItem value="name">{t("sortByName")}</SelectItem>
                        <SelectItem value="mostUsed">{t("sortByMostUsed")}</SelectItem>
                      </SelectContent>
                    </Select>

                    <div className="hidden items-center gap-1 rounded-full border border-border/60 p-1 sm:flex">
                      <Button
                        variant={viewMode === "grid" ? "secondary" : "ghost"}
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => setViewMode("grid")}
                      >
                        <Grid3X3 className="h-4 w-4" />
                      </Button>
                      <Button
                        variant={viewMode === "list" ? "secondary" : "ghost"}
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => setViewMode("list")}
                      >
                        <List className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                </div>

                <div className="flex flex-wrap gap-2">
                  <Button
                    variant={!selectedCategory ? "secondary" : "ghost"}
                    size="sm"
                    onClick={() => setSelectedCategory(null)}
                  >
                    {t("allCategories")}
                  </Button>
                  {CATEGORY_KEYS.map((category) => (
                    <Button
                      key={category}
                      variant={selectedCategory === category ? "secondary" : "ghost"}
                      size="sm"
                      onClick={() =>
                        setSelectedCategory(
                          selectedCategory === category
                            ? null
                            : (category as A2UIAppTemplate["category"])
                        )
                      }
                    >
                      {t(CATEGORY_I18N_MAP[category]) || category}
                    </Button>
                  ))}
                </div>

                {filteredApps.length === 0 ? (
                  <div className="rounded-2xl border border-dashed border-border/60 bg-muted/20 p-6 text-center">
                    <p className="font-medium">
                      {allApps.length === 0 ? t("noAppsYet") : t("noAppsFound")}
                    </p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {allApps.length === 0 ? t("createFirstApp") : t("tryCreating")}
                    </p>
                  </div>
                ) : libraryApps.length === 0 ? (
                  <div className="rounded-2xl border border-dashed border-border/60 bg-muted/20 p-6 text-sm text-muted-foreground">
                    {t("recentlyEdited")}
                  </div>
                ) : (
                  <div
                    className={cn(
                      viewMode === "grid"
                        ? "grid gap-3 sm:grid-cols-2 xl:grid-cols-3"
                        : "flex flex-col gap-3"
                    )}
                  >
                    {libraryApps.map((app) => (
                      <Card
                        key={app.id}
                        className={cn(
                          "group relative overflow-hidden border-border/60 bg-background/80 transition-all hover:-translate-y-0.5 hover:shadow-md",
                          viewMode === "list" && "flex-row"
                        )}
                        onClick={() => handleOpenWorkspace(app.id)}
                      >
                        <div className="absolute right-2 top-2 z-10">
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8"
                                onClick={(event) => event.stopPropagation()}
                              >
                                <MoreVertical className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem onClick={() => handleOpenWorkspace(app.id)}>
                                <Edit className="mr-2 h-4 w-4" />
                                {t("editApp")}
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => setPreviewAppId(app.id)}>
                                <Eye className="mr-2 h-4 w-4" />
                                {t("appPreview")}
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => setDetailAppId(app.id)}>
                                <Blocks className="mr-2 h-4 w-4" />
                                {t("appDetail")}
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem onClick={() => handleDuplicate(app.id)}>
                                <Copy className="mr-2 h-4 w-4" />
                                {t("duplicate")}
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => handleExport(app.id)}>
                                <Download className="mr-2 h-4 w-4" />
                                {t("export")}
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                className="text-destructive focus:text-destructive"
                                onClick={() => handleDeleteApp(app.id)}
                              >
                                <Trash2 className="mr-2 h-4 w-4" />
                                {t("delete")}
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>

                        {viewMode === "grid" && (
                          <div className="border-b bg-muted/30 p-3">
                            <A2UIInlineSurface
                              surfaceId={app.id}
                              className="pointer-events-none min-h-[120px] scale-[0.62] origin-top-left"
                            />
                          </div>
                        )}

                        <CardHeader className={cn(viewMode === "list" && "flex-1")}>
                          <CardTitle className="pr-8 text-base">{app.name}</CardTitle>
                          <CardDescription className="flex flex-wrap items-center gap-2 text-xs">
                            <span>{new Date(app.lastModified).toLocaleDateString()}</span>
                            {app.category && (
                              <span>{t(CATEGORY_I18N_MAP[app.category]) || app.category}</span>
                            )}
                          </CardDescription>
                        </CardHeader>

                        <CardContent className="pt-0">
                          {app.tags && app.tags.length > 0 && (
                            <div className="mb-3 flex flex-wrap gap-1">
                              {app.tags.slice(0, 3).map((tag) => (
                                <Badge key={tag} variant="outline" className="h-5 text-[10px]">
                                  {tag}
                                </Badge>
                              ))}
                            </div>
                          )}
                          <div className="flex flex-wrap gap-2">
                            <Button
                              size="sm"
                              variant="secondary"
                              className="gap-1.5"
                              onClick={(event) => {
                                event.stopPropagation()
                                handleOpenWorkspace(app.id)
                              }}
                            >
                              <Edit className="h-3.5 w-3.5" />
                              {t("editApp")}
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              className="gap-1.5"
                              onClick={(event) => {
                                event.stopPropagation()
                                setPreviewAppId(app.id)
                              }}
                            >
                              <Eye className="h-3.5 w-3.5" />
                              {t("appPreview")}
                            </Button>
                          </div>
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                )}
              </section>

              <section
                aria-labelledby="template-library-heading"
                className="space-y-4 rounded-3xl border bg-card/50 p-4 shadow-sm sm:p-5"
              >
                <div className="space-y-1">
                  <h2 id="template-library-heading" className="text-base font-semibold sm:text-lg">
                    {t("templateLibrary")}
                  </h2>
                  <p className="text-sm text-muted-foreground">
                    {t("browseTemplates") || "Browse pre-built templates"}
                  </p>
                </div>

                {filteredTemplates.length === 0 ? (
                  <div className="rounded-2xl border border-dashed border-border/60 bg-muted/20 p-6 text-center text-sm text-muted-foreground">
                    {t("noTemplatesFound")}
                  </div>
                ) : (
                  <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                    {filteredTemplates.map((template) => (
                      <TemplateCard
                        key={template.id}
                        template={template}
                        viewMode="grid"
                        onSelect={() => handleTemplateSelect(template)}
                      />
                    ))}
                  </div>
                )}
              </section>
            </section>

            <aside className="order-1 lg:order-2 lg:sticky lg:top-6">
              <section
                aria-labelledby="create-studio-heading"
                className="space-y-5 rounded-[28px] border bg-gradient-to-b from-cyan-500/[0.07] via-background to-background p-4 shadow-sm sm:p-5"
              >
                <div className="space-y-2">
                  <Badge variant="secondary" className="w-fit">
                    {t("flashTab")}
                  </Badge>
                  <h2 id="create-studio-heading" className="text-base font-semibold sm:text-lg">
                    {t("createStudio")}
                  </h2>
                  <p className="text-sm text-muted-foreground">
                    {t("flashDescription") || "Describe your app, generated in 30 seconds"}
                  </p>
                </div>

                <div className="space-y-3">
                  <div className="relative">
                    <Textarea
                      ref={promptRef}
                      placeholder={t("flashPlaceholder")}
                      value={heroPrompt}
                      onChange={(event) => setHeroPrompt(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && !event.shiftKey) {
                          event.preventDefault()
                          handleFlashGenerate()
                        }
                      }}
                      rows={3}
                      className="resize-none border-border/60 bg-background/80 pr-24 shadow-sm focus:shadow-md"
                    />
                    <Button
                      size="sm"
                      className="absolute bottom-2 right-2 gap-1.5"
                      onClick={handleFlashGenerate}
                      disabled={!heroPrompt.trim() || isGenerating}
                    >
                      {isGenerating ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Sparkles className="h-3.5 w-3.5" />
                      )}
                      {t("flashTab")}
                    </Button>
                  </div>

                  <div className="space-y-2">
                    <span className="text-xs font-medium text-muted-foreground">
                      {t("quickTry")}
                    </span>
                    <div className="flex flex-wrap gap-2">
                      {QUICK_SUGGESTIONS.map((suggestion) => (
                        <button
                          key={suggestion}
                          type="button"
                          className="rounded-full border border-border/60 px-3 py-1 text-xs transition-colors hover:bg-accent/60"
                          onClick={() => handleSuggestionClick(suggestion)}
                        >
                          {suggestion}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="space-y-3 border-t pt-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <h3 className="font-medium">{t("featuredTemplates")}</h3>
                      <p className="text-xs text-muted-foreground">
                        {t("featuredTemplatesDescription")}
                      </p>
                    </div>
                    <Badge variant="outline">{featuredTemplates.length}</Badge>
                  </div>

                  {featuredTemplates.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t("noTemplatesFound")}</p>
                  ) : (
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1">
                      {featuredTemplates.map((template) => (
                        <TemplateCard
                          key={template.id}
                          template={template}
                          viewMode="grid"
                          onSelect={() => handleTemplateSelect(template)}
                        />
                      ))}
                    </div>
                  )}
                </div>
              </section>
            </aside>
          </div>
        </ScrollArea>
      </main>

      <input
        ref={fileInputRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={handleImportFile}
      />

      <DeleteConfirmDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        onConfirm={handleConfirmDelete}
      />

      {previewAppId && (
        <Dialog open={!!previewAppId} onOpenChange={(open) => !open && setPreviewAppId(null)}>
          <DialogContent aria-describedby={undefined} className="max-h-[80vh] max-w-2xl">
            <DialogHeader className="sr-only">
              <DialogTitle>{t("appPreview")}</DialogTitle>
            </DialogHeader>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="font-semibold">{t("appPreview")}</h3>
            </div>
            <ScrollArea className="max-h-[60vh]">
              <A2UIInlineSurface surfaceId={previewAppId} />
            </ScrollArea>
          </DialogContent>
        </Dialog>
      )}

      {detailAppId && (
        <AppDetailDialog
          app={detailApp}
          template={detailTemplate}
          open={!!detailAppId}
          onOpenChange={(open) => !open && setDetailAppId(null)}
        />
      )}
    </div>
  )
}

export default function A2UIPage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-full items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      }
    >
      <A2UIPageContent />
    </Suspense>
  )
}
