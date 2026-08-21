"use client"

/**
 * A2UI Mini-Apps Page
 * Standalone hub for browsing, creating, and editing A2UI mini-apps
 * Two modes: Hub (discovery + creation) and Workspace (editing a specific app)
 *
 * Hub layout is deliberately single-column and generation-first: the composer
 * is the only element on the page carrying primary weight, and every section
 * below it is a bare heading + content rather than another bordered container.
 * Nesting `rounded-3xl` shells around `rounded-xl` cards around `rounded-md`
 * controls was what made this page read as a pile of mismatched boxes, so the
 * only radii used here come from the `--radius-*` scale: `xl` for cards and the
 * composer, `lg` for tiles, `md` for controls.
 *
 * Scrolling is owned by one native `overflow-y-auto` region (the house pattern
 * — see `sites-console` / `memory-console`; Radix ScrollArea's `display:table`
 * content wrapper does not host `position: sticky` reliably). Inside it the
 * library toolbar pins to the top so search/sort/filters survive a long list,
 * and a back-to-top control fades in once the composer is well out of view.
 */

import {
  Suspense,
  type ChangeEvent,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react"
import { useSearchParams, useRouter } from "next/navigation"
import { useLocale, useTranslations } from "next-intl"
import Link from "next/link"
import {
  ArrowLeft,
  ArrowUp,
  Blocks,
  ChevronDown,
  Copy,
  Download,
  Edit,
  Eye,
  FilePlus2,
  Grid3X3,
  Link2,
  List,
  Loader2,
  MoreVertical,
  Search,
  Sparkles,
  Star,
  Trash2,
  Upload,
  X,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Card } from "@/components/ui/card"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
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
import { FeaturePageHeader } from "@/components/feature-shell/feature-page-header"
import { useA2UIAppBuilder } from "@/hooks/a2ui/use-app-builder"
import { filterAndSortApps, type ViewMode } from "@/hooks/a2ui/use-app-gallery-filter"
import { generateA2UIApp } from "@/lib/a2ui/ai-generate"
import { CATEGORY_KEYS, CATEGORY_I18N_MAP } from "@/lib/a2ui/constants"
import {
  loadGenerationPreferences,
  saveGenerationPreferences,
  type A2UIGenerationPreferences,
} from "@/lib/a2ui/generation-preferences"
import { A2UIInlineSurface } from "@/components/a2ui/a2ui-surface"
import { PageLoading } from "@/components/ui/loading-states"
import { AppDetailDialog } from "@/components/a2ui/app-detail-dialog"
import { DeleteConfirmDialog } from "@/components/a2ui/delete-confirm-dialog"
import { TemplateCard } from "@/components/a2ui/quick-app-builder/template-card"
import { A2UIGenerationOptions } from "@/components/a2ui/generation-options"
import { A2UIWorkspace } from "@/components/a2ui/workspace/a2ui-workspace"
import { cn } from "@/lib/utils"
import { loggers } from "@cognia/logging"
import { toast } from "sonner"
import type { A2UIAppInstance } from "@/hooks/a2ui/use-app-builder"
import type { A2UIAppTemplate } from "@/lib/a2ui/templates"
import type { A2UIComponent } from "@/types/a2ui/schema"

type SortOption = "newest" | "oldest" | "name" | "mostUsed"

const QUICK_SUGGESTION_KEYS = [
  "quickPromptPomodoro",
  "quickPromptExpense",
  "quickPromptBmi",
  "quickPromptHabit",
  "quickPromptTodo",
  "quickPromptConverter",
] as const

/** Templates shown before the "show all" expander — two rows on desktop. */
const TEMPLATE_PREVIEW_COUNT = 6

/** Scroll distance (px) after which the back-to-top control appears. */
const BACK_TO_TOP_THRESHOLD = 520

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

/** Section heading. Bare type on the page background — no wrapper box, so the
 *  cards below are the only rounded surface in the band. */
function SectionHeading({
  id,
  title,
  count,
  children,
}: {
  id: string
  title: string
  count?: number
  children?: React.ReactNode
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
      <div className="flex min-w-0 items-center gap-2">
        <h2 id={id} className="truncate text-sm font-semibold tracking-tight">
          {title}
        </h2>
        {typeof count === "number" && (
          <span className="rounded-md bg-muted px-1.5 py-0.5 text-xs tabular-nums text-muted-foreground">
            {count}
          </span>
        )}
      </div>
      {children ? <div className="flex flex-wrap items-center gap-2">{children}</div> : null}
    </div>
  )
}

function EmptyPanel({
  icon,
  title,
  description,
  action,
}: {
  icon: React.ReactNode
  title: string
  description: string
  action?: React.ReactNode
}) {
  return (
    <div className="rounded-xl border border-dashed bg-muted/20 px-6 py-10 text-center">
      <div className="mx-auto grid size-10 place-items-center rounded-lg border bg-background text-muted-foreground">
        {icon}
      </div>
      <p className="mt-3 text-sm font-medium">{title}</p>
      <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
    </div>
  )
}

function A2UIPageContent() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const t = useTranslations("a2ui")
  const locale = useLocale()
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
  const [shareCodeOpen, setShareCodeOpen] = useState(false)
  const [shareCodeInput, setShareCodeInput] = useState("")
  const [showFavoritesOnly, setShowFavoritesOnly] = useState(false)
  // Favoriting mutates the localStorage instance cache (not the A2UI store), so
  // it does not trigger a store-driven re-render — bump this to refresh.
  const [, forceRender] = useReducer((n: number) => n + 1, 0)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [appToDelete, setAppToDelete] = useState<string | null>(null)
  const [previewAppId, setPreviewAppId] = useState<string | null>(null)
  const [detailAppId, setDetailAppId] = useState<string | null>(null)
  const [templatesExpanded, setTemplatesExpanded] = useState(false)
  // Empty first, hydrated after mount — NOT a lazy initialiser. The app is a
  // static export, so this page is pre-rendered at build time with no `window`
  // and `loadGenerationPreferences()` returns `{}` there. Reading localStorage
  // during the first client render would then hand `A2UIGenerationOptions` a
  // character name and model label the pre-rendered HTML does not contain,
  // which is a hydration mismatch on every load for anyone who has ever set a
  // preference. Same shape as the repo's `persistLocalStorage` stores: the
  // markup matches, then the stored choice lands a tick later.
  const [generationPrefs, setGenerationPrefs] = useState<A2UIGenerationPreferences>({})
  const [toolbarPinned, setToolbarPinned] = useState(false)
  const [showBackToTop, setShowBackToTop] = useState(false)
  const urlActionHandledRef = useRef(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const toolbarSentinelRef = useRef<HTMLDivElement>(null)

  const appBuilder = useA2UIAppBuilder({
    // Built-in mini-app interactions (calculator/timer/todo/…) are handled
    // app-wide by <A2UIBuiltInActionsProvider> in the root layout, so this
    // builder does not opt in — it is used here only for app CRUD/hydration.
    onAppCreated: (appId) => {
      setPreviewAppId(appId)
      toast.success(t("appCreated"))
    },
  })

  // Rebuild renderable surfaces for saved apps that lost their component tree
  // across a reload (pre-persistence-fix data, or LRU-evicted surfaces). Runs
  // once after mount, after the store has rehydrated from localStorage.
  const hydratedRef = useRef(false)
  useEffect(() => {
    if (hydratedRef.current) return
    hydratedRef.current = true
    void appBuilder.hydratePersistedApps()
  }, [appBuilder])

  const allApps = useMemo(() => appBuilder.getAllApps(), [appBuilder])

  const filteredApps = useMemo(() => {
    const sorted = filterAndSortApps(allApps, {
      searchQuery,
      categoryFilter: selectedCategory ?? "all",
      sortField: sortBy === "name" ? "name" : sortBy === "mostUsed" ? "uses" : "lastModified",
      sortOrder: sortBy === "oldest" ? "asc" : "desc",
      getTemplate: appBuilder.getTemplate,
    })
    return showFavoritesOnly ? sorted.filter((app) => app.isFavorite) : sorted
  }, [allApps, appBuilder.getTemplate, searchQuery, selectedCategory, sortBy, showFavoritesOnly])

  const filteredTemplates = useMemo(() => {
    if (searchQuery.trim()) {
      return appBuilder.searchTemplates(searchQuery)
    }
    if (selectedCategory) {
      return appBuilder.getTemplatesByCategory(selectedCategory)
    }
    return appBuilder.templates
  }, [appBuilder, searchQuery, selectedCategory])

  const visibleTemplates = useMemo(
    () =>
      templatesExpanded ? filteredTemplates : filteredTemplates.slice(0, TEMPLATE_PREVIEW_COUNT),
    [filteredTemplates, templatesExpanded]
  )

  const hasActiveFilter = Boolean(searchQuery.trim() || selectedCategory || showFavoritesOnly)
  // "Recently edited" only means anything while the list is actually ordered by
  // recency — badging the first row of a name-sorted list would be a lie.
  const recentAppId = sortBy === "newest" && !hasActiveFilter ? (filteredApps[0]?.id ?? null) : null

  const detailApp = useMemo(
    () => (detailAppId ? (allApps.find((app) => app.id === detailAppId) ?? null) : null),
    [allApps, detailAppId]
  )
  const detailTemplate = useMemo(
    () => (detailApp ? appBuilder.getTemplate(detailApp.templateId) : undefined),
    [appBuilder, detailApp]
  )

  // Pick the stored generation preference up once the DOM the export produced
  // is already on screen, so hydration compares like with like.
  useEffect(() => {
    const stored = loadGenerationPreferences()
    if (Object.keys(stored).length === 0) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setGenerationPrefs(stored)
  }, [])

  // The library toolbar sticks to the top of the scroll region; this flips a
  // data attribute so it only grows its divider once it is actually pinned,
  // instead of drawing a line that floats mid-page. Guarded because jsdom has
  // no IntersectionObserver.
  useEffect(() => {
    const sentinel = toolbarSentinelRef.current
    if (!sentinel || typeof IntersectionObserver === "undefined") return
    const observer = new IntersectionObserver(
      ([entry]) => setToolbarPinned(!entry.isIntersecting),
      { root: scrollRef.current, threshold: 1 }
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [])

  const handleBodyScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    setShowBackToTop(event.currentTarget.scrollTop > BACK_TO_TOP_THRESHOLD)
  }, [])

  const scrollToTop = useCallback(() => {
    scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" })
  }, [])

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
      const result = await generateA2UIApp({
        instruction: heroPrompt,
        mode: "create",
        language: locale === "zh-CN" ? "zh" : "en",
        characterId: generationPrefs.characterId,
        model: generationPrefs.model,
        providerOverride: generationPrefs.provider,
      })
      appBuilder.createCustomApp(result.title, result.components, result.dataModel)
      setHeroPrompt("")
      if (result.usedFallback) toast.info(t("usedTemplateFallback"))
    } catch (err) {
      loggers.a2ui?.error("Flash generation failed", err)
      toast.error(t("generationFailed"))
    } finally {
      setIsGenerating(false)
    }
  }, [appBuilder, generationPrefs, heroPrompt, isGenerating, locale, t])

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
        toast.error(t("generationFailed"))
      }
    },
    [appBuilder, t]
  )

  const handleDeleteApp = useCallback((appId: string) => {
    setAppToDelete(appId)
    setDeleteDialogOpen(true)
  }, [])

  const handleConfirmDelete = useCallback(async () => {
    if (!appToDelete) return
    try {
      await appBuilder.deleteApp(appToDelete)
      setAppToDelete(null)
      if (previewAppId === appToDelete) setPreviewAppId(null)
      toast.success(t("appDeleted"))
    } catch (error) {
      loggers.a2ui?.error("App deletion failed", error)
      toast.error(t("deleteFailed"))
      throw error
    }
  }, [appBuilder, appToDelete, previewAppId, t])

  const handleDeleteDialogOpenChange = useCallback((open: boolean) => {
    setDeleteDialogOpen(open)
    if (!open) setAppToDelete(null)
  }, [])

  const handleDuplicate = useCallback(
    (appId: string) => {
      try {
        const duplicatedAppId = appBuilder.duplicateApp(appId)
        if (duplicatedAppId) {
          setPreviewAppId(duplicatedAppId)
          toast.success(t("appDuplicated"))
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
        toast.success(t("appExported"))
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
      toast.success(t("appExported"))
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
          toast.error(t("generationFailed"))
        }
      } catch (err) {
        loggers.a2ui?.error("Import failed", err)
        toast.error(t("generationFailed"))
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

  const handleCreateBlank = useCallback(() => {
    try {
      const components = [
        {
          id: "root",
          component: "Column",
          children: ["placeholder"],
          className: "min-h-40 items-center justify-center gap-3 p-6",
        },
        {
          id: "placeholder",
          component: "Text",
          text: t("blankAppPlaceholder"),
          align: "center",
          className: "text-sm text-muted-foreground",
        },
      ] as A2UIComponent[]
      const id = appBuilder.createCustomApp(t("blankAppName"), components, {})
      if (id) handleOpenWorkspace(id)
      else toast.error(t("generationFailed"))
    } catch (err) {
      loggers.a2ui?.error("Blank app creation failed", err)
      toast.error(t("generationFailed"))
    }
  }, [appBuilder, handleOpenWorkspace, t])

  const handleImportShareCode = useCallback(() => {
    const raw = shareCodeInput.trim()
    if (!raw) return
    // Accept a raw share code or a "…/share/app?code=…" URL.
    let code = raw
    if (raw.includes("code=")) {
      try {
        const url = new URL(
          raw,
          typeof window !== "undefined" ? window.location.origin : "http://localhost"
        )
        code = url.searchParams.get("code") ?? raw
      } catch {
        code = raw
      }
    }
    const id = appBuilder.importFromShareCode(code)
    if (id) {
      setShareCodeOpen(false)
      setShareCodeInput("")
      toast.success(t("appImported"))
      handleOpenWorkspace(id)
    } else {
      toast.error(t("importFailed"))
    }
  }, [appBuilder, handleOpenWorkspace, shareCodeInput, t])

  const handleToggleFavorite = useCallback(
    async (appId: string) => {
      try {
        await appBuilder.toggleFavorite(appId)
        forceRender()
      } catch (err) {
        loggers.a2ui?.error("Toggle favorite failed", err)
      }
    },
    [appBuilder]
  )

  const handleGenerationPrefsChange = useCallback((next: A2UIGenerationPreferences) => {
    setGenerationPrefs(next)
    saveGenerationPreferences(next)
  }, [])

  const handleClearFilters = useCallback(() => {
    setSearchQuery("")
    setSelectedCategory(null)
    setShowFavoritesOnly(false)
  }, [])

  const renderAppActions = useCallback(
    (app: A2UIAppInstance) => (
      <div className="flex shrink-0 items-center gap-0.5">
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground hover:text-foreground"
          aria-label={app.isFavorite ? t("unfavorite") : t("favorite")}
          onClick={(event) => {
            event.stopPropagation()
            void handleToggleFavorite(app.id)
          }}
        >
          <Star className={cn("size-4", app.isFavorite && "fill-warning text-warning")} />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground hover:text-foreground"
              aria-label={t("moreActions")}
              onClick={(event) => event.stopPropagation()}
            >
              <MoreVertical className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-44">
            <DropdownMenuItem onClick={() => handleOpenWorkspace(app.id)}>
              <Edit className="size-4" />
              {t("editApp")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setPreviewAppId(app.id)}>
              <Eye className="size-4" />
              {t("appPreview")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setDetailAppId(app.id)}>
              <Blocks className="size-4" />
              {t("appDetail")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => handleDuplicate(app.id)}>
              <Copy className="size-4" />
              {t("duplicate")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => handleExport(app.id)}>
              <Download className="size-4" />
              {t("export")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={() => handleDeleteApp(app.id)}>
              <Trash2 className="size-4" />
              {t("delete")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    ),
    [handleDeleteApp, handleDuplicate, handleExport, handleOpenWorkspace, handleToggleFavorite, t]
  )

  const renderRecentBadge = useCallback(
    (app: A2UIAppInstance, className?: string) =>
      app.id === recentAppId ? (
        <Badge
          variant="secondary"
          className={cn("h-5 shrink-0 px-1.5 text-[10px] font-medium", className)}
        >
          {t("recentlyEdited")}
        </Badge>
      ) : null,
    [recentAppId, t]
  )

  const renderAppMeta = useCallback(
    (app: A2UIAppInstance) => (
      <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
        <span className="tabular-nums">{new Date(app.lastModified).toLocaleDateString()}</span>
        {app.category && (
          <>
            <span aria-hidden="true">·</span>
            <span className="truncate">{t(CATEGORY_I18N_MAP[app.category]) || app.category}</span>
          </>
        )}
      </div>
    ),
    [t]
  )

  if (appIdFromUrl) {
    return <A2UIWorkspace surfaceId={appIdFromUrl} />
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-bg-target="chat">
      <FeaturePageHeader
        variant="management"
        testId="a2ui-hub-header"
        breadcrumb={
          <Button variant="ghost" size="icon-sm" asChild aria-label={t("back")}>
            <Link href="/">
              <ArrowLeft className="size-4" />
            </Link>
          </Button>
        }
        icon={<Blocks className="size-4" aria-hidden="true" />}
        title={t("pageTitle")}
        description={t("hubSummary")}
        summary={
          <>
            <span className="tabular-nums">{t("appCount", { count: allApps.length })}</span>
            <span aria-hidden="true">·</span>
            <span className="tabular-nums">
              {appBuilder.templates.length} {t("templatesTab")}
            </span>
          </>
        }
        secondaryActions={[
          {
            id: "blank",
            label: t("newBlankApp"),
            icon: FilePlus2,
            onSelect: handleCreateBlank,
          },
        ]}
        overflowActions={[
          { id: "import", label: t("importApp"), icon: Upload, onSelect: handleImportClick },
          {
            id: "share-code",
            label: t("importShareCode"),
            icon: Link2,
            onSelect: () => setShareCodeOpen(true),
          },
          {
            id: "export-all",
            label: t("exportAllApps"),
            icon: Download,
            onSelect: handleExportAll,
            disabled: allApps.length === 0,
          },
        ]}
        overflowLabel={t("moreActions")}
      />

      <Dialog open={shareCodeOpen} onOpenChange={setShareCodeOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("importShareCodeTitle")}</DialogTitle>
            <DialogDescription>{t("importShareCodeDescription")}</DialogDescription>
          </DialogHeader>
          <Textarea
            value={shareCodeInput}
            onChange={(event) => setShareCodeInput(event.target.value)}
            placeholder={t("importShareCodePlaceholder")}
            rows={4}
            className="font-mono text-xs"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setShareCodeOpen(false)}>
              {t("cancel")}
            </Button>
            <Button onClick={handleImportShareCode} disabled={!shareCodeInput.trim()}>
              <Upload className="size-4" />
              {t("importApp")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <main className="relative min-h-0 flex-1 overflow-hidden">
        <div
          ref={scrollRef}
          onScroll={handleBodyScroll}
          className="h-full overflow-y-auto overscroll-contain"
          data-testid="a2ui-hub-scroll"
        >
          <div className="mx-auto flex w-full max-w-5xl flex-col px-4 sm:px-6">
            {/* ── Composer: the single primary surface on the page ───────── */}
            <section
              aria-labelledby="a2ui-compose-heading"
              className="mx-auto w-full max-w-2xl pb-10 pt-8 sm:pb-12 sm:pt-14"
            >
              <div className="text-center">
                <h2
                  id="a2ui-compose-heading"
                  className="text-balance text-2xl font-semibold tracking-tight sm:text-3xl"
                >
                  {t("heroTitle")}
                </h2>
                <p className="mx-auto mt-2 max-w-md text-pretty text-sm text-muted-foreground">
                  {t("heroSubtitle")}
                </p>
              </div>

              <div
                className={cn(
                  "mt-6 overflow-hidden rounded-xl border bg-card shadow-sm",
                  "transition-[border-color,box-shadow] duration-200 motion-reduce:transition-none",
                  "focus-within:border-ring/70 focus-within:shadow-md"
                )}
              >
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
                  aria-label={t("flashTitle")}
                  className={cn(
                    "max-h-56 min-h-24 resize-none rounded-none border-0 bg-transparent px-4 py-3.5",
                    "text-base shadow-none focus-visible:border-0 focus-visible:ring-0 md:text-base",
                    "dark:bg-transparent"
                  )}
                />
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-t bg-muted/25 px-2 py-2">
                  <A2UIGenerationOptions
                    value={generationPrefs}
                    onChange={handleGenerationPrefsChange}
                    disabled={isGenerating}
                  />
                  <div className="ml-auto flex items-center gap-1.5">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={handleCreateBlank}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      <FilePlus2 className="size-4" />
                      <span className="hidden sm:inline">{t("newBlankApp")}</span>
                    </Button>
                    <Button
                      size="sm"
                      onClick={handleFlashGenerate}
                      disabled={!heroPrompt.trim() || isGenerating}
                      className="shadow-sm shadow-primary/20"
                    >
                      {isGenerating ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <Sparkles className="size-4" />
                      )}
                      {isGenerating ? t("generating") : t("aiGenerate")}
                    </Button>
                  </div>
                </div>
              </div>

              {/* No visible "Quick try:" label — it cost exactly the 7px that
                  pushed the sixth chip onto a second, ragged line, and chips
                  under a prompt box are self-explanatory. The label survives as
                  the group's accessible name. */}
              <div
                role="group"
                aria-label={t("quickTry")}
                className="mt-3 flex flex-wrap items-center justify-center gap-1.5"
              >
                {QUICK_SUGGESTION_KEYS.map((key) => {
                  const suggestion = t(key)
                  return (
                    <Button
                      key={key}
                      type="button"
                      variant="outline"
                      size="xs"
                      className="font-normal text-muted-foreground hover:text-foreground"
                      onClick={() => handleSuggestionClick(suggestion)}
                    >
                      {suggestion}
                    </Button>
                  )
                })}
              </div>
            </section>

            {/* ── My apps ───────────────────────────────────────────────── */}
            <section aria-labelledby="a2ui-apps-heading" className="flex flex-col">
              {/* Pin sensor: sits one pixel above the sticky bar, so leaving the
                  viewport is exactly the moment the bar becomes pinned. */}
              <div ref={toolbarSentinelRef} aria-hidden="true" className="h-px w-full shrink-0" />

              <div
                data-testid="a2ui-library-toolbar"
                data-pinned={toolbarPinned}
                className={cn(
                  "sticky top-0 z-20 -mx-4 flex flex-col gap-2.5 px-4 pb-3 pt-2.5 sm:-mx-6 sm:px-6",
                  // Same glass recipe as FeaturePageHeader, so a pinned toolbar
                  // reads as an extension of the page chrome above it.
                  "border-b border-transparent bg-background/88 backdrop-blur-xl",
                  "supports-[backdrop-filter]:bg-background/76",
                  "transition-colors duration-200 motion-reduce:transition-none",
                  "data-[pinned=true]:border-border/70"
                )}
              >
                <SectionHeading
                  id="a2ui-apps-heading"
                  title={t("myAppsTab")}
                  count={allApps.length}
                >
                  <div className="relative w-full sm:w-56">
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      placeholder={t("searchPlaceholder")}
                      value={searchQuery}
                      onChange={(event) => setSearchQuery(event.target.value)}
                      className="h-8 pl-8 pr-8 text-sm"
                    />
                    {searchQuery && (
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        className="absolute right-1 top-1/2 -translate-y-1/2 text-muted-foreground"
                        aria-label={t("close")}
                        onClick={() => setSearchQuery("")}
                      >
                        <X className="size-3.5" />
                      </Button>
                    )}
                  </div>

                  <Select value={sortBy} onValueChange={(value) => setSortBy(value as SortOption)}>
                    <SelectTrigger size="sm" className="w-[132px]" aria-label={t("sortByLabel")}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="newest">{t("sortByNewest")}</SelectItem>
                      <SelectItem value="oldest">{t("sortOldest")}</SelectItem>
                      <SelectItem value="name">{t("sortByName")}</SelectItem>
                      <SelectItem value="mostUsed">{t("sortByMostUsed")}</SelectItem>
                    </SelectContent>
                  </Select>

                  <div className="hidden items-center gap-0.5 rounded-md border p-0.5 sm:flex">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant={viewMode === "grid" ? "secondary" : "ghost"}
                          size="icon-xs"
                          className="size-7"
                          aria-label={t("gridView")}
                          aria-pressed={viewMode === "grid"}
                          onClick={() => setViewMode("grid")}
                        >
                          <Grid3X3 className="size-3.5" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>{t("gridView")}</TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant={viewMode === "list" ? "secondary" : "ghost"}
                          size="icon-xs"
                          className="size-7"
                          aria-label={t("listView")}
                          aria-pressed={viewMode === "list"}
                          onClick={() => setViewMode("list")}
                        >
                          <List className="size-3.5" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>{t("listView")}</TooltipContent>
                    </Tooltip>
                  </div>
                </SectionHeading>

                {allApps.length > 0 && (
                  <div className="-mx-1 flex items-center gap-1 overflow-x-auto px-1 pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                    <Button
                      variant={!selectedCategory && !showFavoritesOnly ? "secondary" : "ghost"}
                      size="xs"
                      className="shrink-0 font-normal"
                      onClick={handleClearFilters}
                    >
                      {t("allCategories")}
                    </Button>
                    <Button
                      variant={showFavoritesOnly ? "secondary" : "ghost"}
                      size="xs"
                      className="shrink-0 font-normal"
                      onClick={() => setShowFavoritesOnly((value) => !value)}
                      aria-pressed={showFavoritesOnly}
                    >
                      <Star className={cn("size-3", showFavoritesOnly && "fill-current")} />
                      {t("favoritesFilter")}
                    </Button>
                    <span className="mx-1 h-4 w-px shrink-0 bg-border" aria-hidden="true" />
                    {CATEGORY_KEYS.map((category) => (
                      <Button
                        key={category}
                        variant={selectedCategory === category ? "secondary" : "ghost"}
                        size="xs"
                        className="shrink-0 font-normal"
                        aria-pressed={selectedCategory === category}
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
                )}
              </div>

              <div className="pt-4">
                {filteredApps.length === 0 ? (
                  <EmptyPanel
                    icon={<Blocks className="size-5" />}
                    title={allApps.length === 0 ? t("noAppsYet") : t("noAppsFound")}
                    description={allApps.length === 0 ? t("createFirstApp") : t("tryCreating")}
                    action={
                      allApps.length === 0 ? (
                        <Button size="sm" onClick={focusCreatePrompt}>
                          <Sparkles className="size-4" />
                          {t("newApp")}
                        </Button>
                      ) : (
                        <Button size="sm" variant="outline" onClick={handleClearFilters}>
                          {t("allCategories")}
                        </Button>
                      )
                    }
                  />
                ) : viewMode === "grid" ? (
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {filteredApps.map((app) => (
                      <Card
                        key={app.id}
                        data-testid="a2ui-app-card"
                        className={cn(
                          "group relative cursor-pointer gap-0 overflow-hidden py-0",
                          "transition-[border-color,box-shadow,transform] duration-200",
                          "hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md",
                          "motion-reduce:transition-none motion-reduce:hover:translate-y-0"
                        )}
                        onClick={() => handleOpenWorkspace(app.id)}
                      >
                        {/* Full-bleed preview: the frame owns the border, so the
                            inline surface drops its own radius/border/background
                            to avoid a rounded box inside a rounded box. */}
                        <div className="relative h-32 overflow-hidden border-b bg-muted/30">
                          <A2UIInlineSurface
                            surfaceId={app.id}
                            className="pointer-events-none absolute inset-0 w-[200%] origin-top-left scale-50 rounded-none border-0 bg-transparent p-3 shadow-none"
                          />
                          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-card via-card/70 to-transparent" />
                          {renderRecentBadge(app, "absolute left-2 top-2 shadow-sm")}

                          {/* Row actions live over the thumbnail so the title
                              gets the full card width. Pointer devices reveal
                              them on hover; a favourited card and any device
                              without hover keep them visible. */}
                          <div
                            className={cn(
                              "absolute right-1.5 top-1.5 z-10 flex items-center gap-0.5",
                              "rounded-md border bg-background/85 p-0.5 shadow-sm backdrop-blur",
                              "transition-opacity duration-150 motion-reduce:transition-none",
                              "focus-within:opacity-100 has-[[data-state=open]]:opacity-100",
                              app.isFavorite
                                ? "opacity-100"
                                : "opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
                            )}
                          >
                            {renderAppActions(app)}
                          </div>
                        </div>

                        <div className="flex flex-col gap-1 p-3">
                          <h3 className="truncate text-sm font-medium">{app.name}</h3>
                          {renderAppMeta(app)}
                          {app.tags && app.tags.length > 0 && (
                            <div className="mt-0.5 flex flex-wrap gap-1">
                              {app.tags.slice(0, 3).map((tag) => (
                                <Badge
                                  key={tag}
                                  variant="outline"
                                  className="h-4 px-1.5 text-[10px] font-normal"
                                >
                                  {tag}
                                </Badge>
                              ))}
                            </div>
                          )}
                        </div>
                      </Card>
                    ))}
                  </div>
                ) : (
                  /* List mode is one surface with divided rows, not a stack of
                     floating cards — rows read as a list and the eye follows a
                     single left edge down the page. */
                  <div className="overflow-hidden rounded-xl border bg-card">
                    {filteredApps.map((app, index) => (
                      <div
                        key={app.id}
                        data-testid="a2ui-app-card"
                        className={cn(
                          "group flex cursor-pointer items-center gap-3 px-3 py-2.5",
                          "transition-colors duration-150 hover:bg-accent/50",
                          "motion-reduce:transition-none",
                          index > 0 && "border-t"
                        )}
                        onClick={() => handleOpenWorkspace(app.id)}
                      >
                        <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
                          <Blocks className="size-4" />
                        </div>
                        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                          <div className="flex min-w-0 items-center gap-1.5">
                            <h3 className="truncate text-sm font-medium">{app.name}</h3>
                            {renderRecentBadge(app)}
                          </div>
                          {renderAppMeta(app)}
                        </div>
                        {app.tags && app.tags.length > 0 && (
                          <div className="hidden shrink-0 items-center gap-1 md:flex">
                            {app.tags.slice(0, 2).map((tag) => (
                              <Badge
                                key={tag}
                                variant="outline"
                                className="h-4 px-1.5 text-[10px] font-normal"
                              >
                                {tag}
                              </Badge>
                            ))}
                          </div>
                        )}
                        {renderAppActions(app)}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </section>

            {/* ── Templates ─────────────────────────────────────────────── */}
            <section
              aria-labelledby="a2ui-templates-heading"
              className="flex flex-col gap-4 pb-20 pt-12"
            >
              <SectionHeading
                id="a2ui-templates-heading"
                title={t("templateLibrary")}
                count={filteredTemplates.length}
              >
                <span className="text-xs text-muted-foreground">{t("browseTemplates")}</span>
              </SectionHeading>

              {filteredTemplates.length === 0 ? (
                <EmptyPanel
                  icon={<Sparkles className="size-5" />}
                  title={t("noTemplatesFound")}
                  description={t("tryDifferentSearch")}
                />
              ) : (
                <>
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {visibleTemplates.map((template) => (
                      <TemplateCard
                        key={template.id}
                        template={template}
                        viewMode="grid"
                        onSelect={() => handleTemplateSelect(template)}
                      />
                    ))}
                  </div>

                  {/* Keeps the full catalogue two rows tall by default so the
                      library above stays reachable without a long scroll. */}
                  {filteredTemplates.length > TEMPLATE_PREVIEW_COUNT && (
                    <div className="flex justify-center">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setTemplatesExpanded((value) => !value)}
                        aria-expanded={templatesExpanded}
                      >
                        {templatesExpanded ? t("showLess") : t("showAll")}
                        <ChevronDown
                          className={cn(
                            "size-4 transition-transform duration-200 motion-reduce:transition-none",
                            templatesExpanded && "rotate-180"
                          )}
                        />
                      </Button>
                    </div>
                  )}
                </>
              )}
            </section>
          </div>
        </div>

        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label={t("scrollToTop")}
          data-testid="a2ui-back-to-top"
          onClick={scrollToTop}
          className={cn(
            "absolute bottom-5 right-5 z-30 rounded-full bg-background/90 shadow-md backdrop-blur",
            "transition-[opacity,transform] duration-200 motion-reduce:transition-none",
            showBackToTop
              ? "translate-y-0 opacity-100"
              : "pointer-events-none translate-y-2 opacity-0"
          )}
        >
          <ArrowUp className="size-4" />
        </Button>
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
        onOpenChange={handleDeleteDialogOpenChange}
        onConfirm={handleConfirmDelete}
      />

      {previewAppId && (
        <Dialog open={!!previewAppId} onOpenChange={(open) => !open && setPreviewAppId(null)}>
          <DialogContent aria-describedby={undefined} className="max-h-[80vh] max-w-2xl">
            <DialogHeader>
              <DialogTitle>{t("appPreview")}</DialogTitle>
            </DialogHeader>
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
          onPreparePublish={appBuilder.prepareForPublish}
          onPublish={appBuilder.publishApp}
          onUnpublish={appBuilder.unpublishApp}
        />
      )}
    </div>
  )
}

export default function A2UIPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <A2UIPageContent />
    </Suspense>
  )
}
