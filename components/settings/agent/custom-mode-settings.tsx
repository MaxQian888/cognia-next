"use client"

/**
 * CustomModeSettings — Settings → Agent modes.
 *
 * Master/detail, the same shape Providers uses: a filterable rail of modes on
 * the left, the selected mode's full configuration on the right. It used to be
 * one `<Card>` holding a filter row and a 60vh scroller of rows whose entire
 * detail was a truncated one-liner — everything else about a mode (system
 * prompt, tool list, overrides, tags, timestamps) was invisible until you
 * opened the editor dialog. The rail keeps search / category / sort / bulk
 * select; the pane surfaces the rest read-only, with edit, duplicate, export
 * and delete on the mode you are looking at.
 *
 * Editing still happens in `CustomModeEditor` — the dialog is the single owner
 * of the write path; this surface never mutates a mode field directly.
 */

import { useState, useCallback, useMemo, useRef } from "react"
import { useTranslations } from "next-intl"
import { loggers } from "@cognia/logging"
import {
  Plus,
  Download,
  Upload,
  Trash2,
  Edit,
  Copy,
  MoreHorizontal,
  Search,
  Filter,
  Bot,
  Menu,
} from "lucide-react"
import * as Icons from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Empty,
  EmptyMedia,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
  EmptyContent,
} from "@/components/ui/empty"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { toast } from "@/components/ui/sonner"
import { cn } from "@/lib/utils"
import { PanelTransition } from "@/components/settings/common/panel-transition"
import {
  useCustomModeStore,
  type CustomModeConfig,
  type CustomModeCategory,
} from "@/stores/agent/custom-mode-store"
import { CustomModeEditor } from "@/components/agent/mode/custom-mode-editor"

// =============================================================================
// Types
// =============================================================================

type SortOption = "name" | "created" | "updated" | "usage"
type FilterCategory = CustomModeCategory | "all"

// =============================================================================
// Helper Components
// =============================================================================

function ModeIcon({ name, className }: { name: string; className?: string }) {
  const IconComponent =
    (Icons[name as keyof typeof Icons] as React.ComponentType<{ className?: string }>) || Bot
  return <IconComponent className={className} />
}

const CATEGORY_TRANSLATION_KEYS: Record<CustomModeCategory, string> = {
  productivity: "categoryProductivity",
  creative: "categoryCreative",
  technical: "categoryTechnical",
  research: "categoryResearch",
  education: "categoryEducation",
  business: "categoryBusiness",
  personal: "categoryPersonal",
  other: "categoryOther",
}

/** One read-only label/value line in the detail pane's spec sheet. */
function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 border-b border-border/50 py-2 last:border-b-0 @sm/mode-pane:flex-row @sm/mode-pane:items-baseline @sm/mode-pane:justify-between @sm/mode-pane:gap-4">
      <span className="shrink-0 text-xs text-muted-foreground">{label}</span>
      <span className="min-w-0 text-sm @sm/mode-pane:text-right">{children}</span>
    </div>
  )
}

// =============================================================================
// Main Component
// =============================================================================

export function CustomModeSettings() {
  const t = useTranslations("customMode")
  const tCommon = useTranslations("common")
  const tSettings = useTranslations("settings")
  const tCustomMode = useTranslations("customModeSettings")

  // Store
  const {
    customModes,
    deleteMode,
    duplicateMode,
    exportMode,
    exportAllModes,
    importMode,
    importModes,
  } = useCustomModeStore()

  // Local state
  const [searchQuery, setSearchQuery] = useState("")
  const [sortBy, setSortBy] = useState<SortOption>("name")
  const [filterCategory, setFilterCategory] = useState<FilterCategory>("all")
  const [showEditor, setShowEditor] = useState(false)
  const [editingMode, setEditingMode] = useState<CustomModeConfig | undefined>()
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null)
  const [selectedModes, setSelectedModes] = useState<Set<string>>(new Set())
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [mobileSheetOpen, setMobileSheetOpen] = useState(false)

  // File input ref for import
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Get modes as array. The custom-mode store hydrates `customModes`
  // asynchronously, so guard against the initial null/undefined snapshot
  // that some test fixtures hand back without a fully-populated record.
  const modesArray = useMemo(() => Object.values(customModes ?? {}), [customModes])

  // Filter and sort modes
  const filteredModes = useMemo(
    () =>
      modesArray
        .filter((mode) => {
          // Search filter
          if (searchQuery) {
            const query = searchQuery.toLowerCase()
            if (
              !mode.name.toLowerCase().includes(query) &&
              !mode.description.toLowerCase().includes(query) &&
              !mode.tags?.some((tag) => tag.toLowerCase().includes(query))
            ) {
              return false
            }
          }
          // Category filter
          if (filterCategory !== "all" && mode.category !== filterCategory) {
            return false
          }
          return true
        })
        .sort((a, b) => {
          switch (sortBy) {
            case "name":
              return a.name.localeCompare(b.name)
            case "created":
              return b.createdAt.getTime() - a.createdAt.getTime()
            case "updated":
              return b.updatedAt.getTime() - a.updatedAt.getTime()
            case "usage":
              return (b.usageCount || 0) - (a.usageCount || 0)
          }
        }),
    [modesArray, searchQuery, filterCategory, sortBy]
  )

  // The pane follows the rail: an explicit pick wins, but a selection filtered
  // out (or deleted) falls back to the first visible row rather than blanking.
  const activeMode =
    filteredModes.find((mode) => mode.id === selectedId) ?? filteredModes[0] ?? null

  // Handle create new
  const handleCreateNew = useCallback(() => {
    setEditingMode(undefined)
    setShowEditor(true)
  }, [])

  // Handle edit
  const handleEdit = useCallback((mode: CustomModeConfig) => {
    setEditingMode(mode)
    setShowEditor(true)
  }, [])

  // Handle duplicate
  const handleDuplicate = useCallback(
    (id: string) => {
      const duplicated = duplicateMode(id)
      if (duplicated) {
        loggers.agent.info("settings.modeDuplicated", { sourceId: id, newId: duplicated.id })
        toast.success(tCustomMode("modeDuplicated"))
      } else {
        loggers.agent.warn("settings.modeDuplicateMissing", { id })
      }
    },
    [duplicateMode, tCustomMode]
  )

  // Handle delete
  const handleDelete = useCallback(() => {
    if (deleteConfirmId) {
      deleteMode(deleteConfirmId)
      loggers.agent.info("settings.modeDeleted", { id: deleteConfirmId })
      setDeleteConfirmId(null)
      setSelectedModes((prev) => {
        const next = new Set(prev)
        next.delete(deleteConfirmId)
        return next
      })
      // Drop the pane's pin so it falls back to the first remaining row
      // instead of pointing at a mode that no longer exists.
      setSelectedId((prev) => (prev === deleteConfirmId ? null : prev))
      toast.success(tCustomMode("modeDeleted"))
    }
  }, [deleteConfirmId, deleteMode, tCustomMode])

  // Handle export single
  const handleExportSingle = useCallback(
    (id: string) => {
      const json = exportMode(id)
      if (json) {
        const blob = new Blob([json], { type: "application/json" })
        const url = URL.createObjectURL(blob)
        const a = document.createElement("a")
        a.href = url
        a.download = `custom-mode-${id}.json`
        a.click()
        URL.revokeObjectURL(url)
        loggers.agent.info("settings.modeExported", { id })
        toast.success(tCustomMode("modeExported"))
      }
    },
    [exportMode, tCustomMode]
  )

  // Handle export all
  const handleExportAll = useCallback(() => {
    const json = exportAllModes()
    const blob = new Blob([json], { type: "application/json" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `custom-modes-${new Date().toISOString().split("T")[0]}.json`
    a.click()
    URL.revokeObjectURL(url)
    loggers.agent.info("settings.allModesExported", { count: modesArray.length })
    toast.success(tCustomMode("exportedModes", { count: modesArray.length }))
  }, [exportAllModes, modesArray.length, tCustomMode])

  // Handle import
  const handleImport = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0]
      if (!file) return

      const reader = new FileReader()
      reader.onload = (e) => {
        const content = e.target?.result as string
        try {
          const data = JSON.parse(content)
          if (data.type === "custom-modes-collection") {
            const count = importModes(content)
            loggers.agent.info("settings.modesImported", { count })
            toast.success(tCustomMode("importedModes", { count }))
          } else if (data.type === "custom-mode") {
            const imported = importMode(content)
            if (imported) {
              loggers.agent.info("settings.modeImported", { name: imported.name })
              toast.success(tCustomMode("importedMode", { name: imported.name }))
            } else {
              loggers.agent.warn("settings.modeImportRejected")
              toast.error(tCustomMode("failedToImportMode"))
            }
          } else {
            loggers.agent.warn("settings.modeImportInvalidFormat", { type: data?.type })
            toast.error(tCustomMode("invalidFileFormat"))
          }
        } catch (err) {
          loggers.agent.error("settings.modeImportParseFailed", err)
          toast.error(tCustomMode("failedToParseFile"))
        }
      }
      reader.readAsText(file)

      // Reset file input
      if (fileInputRef.current) {
        fileInputRef.current.value = ""
      }
    },
    [importMode, importModes, tCustomMode]
  )

  // Handle bulk delete
  const handleBulkDelete = useCallback(() => {
    const ids = Array.from(selectedModes)
    selectedModes.forEach((id) => deleteMode(id))
    loggers.agent.info("settings.bulkDelete", { count: ids.length })
    toast.success(tCustomMode("deletedModes", { count: selectedModes.size }))
    setSelectedModes(new Set())
    setSelectedId((prev) => (prev !== null && ids.includes(prev) ? null : prev))
  }, [selectedModes, deleteMode, tCustomMode])

  // Toggle mode selection
  const toggleModeSelection = useCallback((id: string) => {
    setSelectedModes((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }, [])

  // Select all
  const selectAll = useCallback(() => {
    setSelectedModes(new Set(filteredModes.map((m) => m.id)))
  }, [filteredModes])

  // Clear selection
  const clearSelection = useCallback(() => {
    setSelectedModes(new Set())
  }, [])

  /* ── Rail ───────────────────────────────────────────────────────────────── */

  const rail = (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="custom-mode-rail">
      <div className="flex flex-col gap-2 border-b p-2">
        <div className="relative">
          <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder={tCustomMode("searchModes")}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="h-8 pl-8"
          />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Select
            value={filterCategory}
            onValueChange={(v) => setFilterCategory(v as FilterCategory)}
          >
            <SelectTrigger
              className="h-8 min-w-0 text-xs"
              aria-label={tCustomMode("categoryLabel")}
            >
              <Filter className="size-3.5 shrink-0" />
              <SelectValue placeholder={tCustomMode("categoryLabel")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{tCustomMode("allCategories")}</SelectItem>
              <SelectItem value="productivity">{t("categoryProductivity")}</SelectItem>
              <SelectItem value="creative">{t("categoryCreative")}</SelectItem>
              <SelectItem value="technical">{t("categoryTechnical")}</SelectItem>
              <SelectItem value="research">{t("categoryResearch")}</SelectItem>
              <SelectItem value="education">{t("categoryEducation")}</SelectItem>
              <SelectItem value="business">{t("categoryBusiness")}</SelectItem>
              <SelectItem value="personal">{t("categoryPersonal")}</SelectItem>
              <SelectItem value="other">{t("categoryOther")}</SelectItem>
            </SelectContent>
          </Select>
          <Select value={sortBy} onValueChange={(v) => setSortBy(v as SortOption)}>
            <SelectTrigger className="h-8 min-w-0 text-xs" aria-label={tCustomMode("sortByLabel")}>
              <SelectValue placeholder={tCustomMode("sortByLabel")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="name">{tCustomMode("sortByName")}</SelectItem>
              <SelectItem value="created">{tCustomMode("sortByCreated")}</SelectItem>
              <SelectItem value="updated">{tCustomMode("sortByUpdated")}</SelectItem>
              <SelectItem value="usage">{tCustomMode("sortByMostUsed")}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Bulk actions */}
        {selectedModes.size > 0 && (
          <div
            className="flex flex-wrap items-center gap-1.5 rounded-md bg-muted/60 p-1.5"
            role="status"
          >
            <span className="text-xs text-muted-foreground" aria-live="polite">
              {tCustomMode("selected", { count: selectedModes.size })}
            </span>
            <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={clearSelection}>
              {tCustomMode("clear")}
            </Button>
            <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={selectAll}>
              {tCustomMode("selectAll")}
            </Button>
            <div className="flex-1" />
            <Button
              variant="destructive"
              size="sm"
              className="h-6 px-2 text-xs"
              onClick={handleBulkDelete}
            >
              <Trash2 className="mr-1 size-3" />
              {tCustomMode("deleteSelected")}
            </Button>
          </div>
        )}

        {/* Results count — visible only when filters narrow the list */}
        {(searchQuery || filterCategory !== "all") && modesArray.length > 0 && (
          <p
            className="text-xs text-muted-foreground"
            aria-live="polite"
            data-testid="custom-mode-results-count"
          >
            {tCustomMode("resultsCount", {
              shown: filteredModes.length,
              total: modesArray.length,
            })}
          </p>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-1" role="list">
        {filteredModes.length === 0 ? (
          <Empty className="border-0 py-8">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Bot className="size-6" />
              </EmptyMedia>
              <EmptyTitle>
                {modesArray.length === 0
                  ? tCustomMode("noCustomModesYet")
                  : tCustomMode("noModesMatchFilters")}
              </EmptyTitle>
              <EmptyDescription>
                {modesArray.length === 0 && tCustomMode("createFirstModeDesc")}
              </EmptyDescription>
            </EmptyHeader>
            {modesArray.length === 0 && (
              <EmptyContent>
                <Button variant="outline" size="sm" onClick={handleCreateNew}>
                  <Plus className="mr-2 size-4" />
                  {tCustomMode("createFirstMode")}
                </Button>
              </EmptyContent>
            )}
          </Empty>
        ) : (
          filteredModes.map((mode) => (
            <div key={mode.id} role="listitem" className="flex items-start gap-1.5 px-1">
              <Checkbox
                className="mt-3 shrink-0"
                checked={selectedModes.has(mode.id)}
                onCheckedChange={() => toggleModeSelection(mode.id)}
                aria-label={tCustomMode("selectMode", { name: mode.name })}
              />
              <button
                type="button"
                data-testid={`custom-mode-row-${mode.id}`}
                data-active={mode.id === activeMode?.id}
                aria-current={mode.id === activeMode?.id ? "true" : undefined}
                onClick={() => {
                  setSelectedId(mode.id)
                  setMobileSheetOpen(false)
                }}
                className={cn(
                  "flex min-w-0 flex-1 items-start gap-2 rounded-md px-2 py-2 text-left transition-colors",
                  "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                  mode.id === activeMode?.id
                    ? "bg-accent text-accent-foreground"
                    : "hover:bg-accent/50"
                )}
              >
                <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-muted">
                  <ModeIcon name={mode.icon} className="size-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="min-w-0 truncate text-sm font-medium">{mode.name}</span>
                    {mode.category && (
                      <Badge variant="outline" className="shrink-0 text-[10px]">
                        {t(CATEGORY_TRANSLATION_KEYS[mode.category as CustomModeCategory])}
                      </Badge>
                    )}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {mode.description || tCustomMode("noDescription")}
                  </span>
                </span>
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  )

  /* ── Detail ─────────────────────────────────────────────────────────────── */

  const detail = activeMode ? (
    <div className="@container/mode-pane flex min-h-0 flex-1 flex-col" key={activeMode.id}>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b p-4">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted">
            <ModeIcon name={activeMode.icon} className="size-5" />
          </span>
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold tracking-tight">{activeMode.name}</h3>
              {activeMode.category && (
                <Badge variant="outline" className="text-[10px]">
                  {t(CATEGORY_TRANSLATION_KEYS[activeMode.category as CustomModeCategory])}
                </Badge>
              )}
            </div>
            <p className="text-xs text-pretty text-muted-foreground">
              {activeMode.description || tCustomMode("noDescription")}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            size="sm"
            variant="outline"
            onClick={() => handleEdit(activeMode)}
            data-testid={`mode-edit-${activeMode.id}`}
            aria-label={tCustomMode("editMode", { name: activeMode.name })}
          >
            <Edit className="mr-1.5 size-3.5" />
            {tCommon("edit")}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-8"
                aria-label={tCustomMode("moreActions", { name: activeMode.name })}
              >
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => handleDuplicate(activeMode.id)}>
                <Copy className="mr-2 size-4" />
                {tCustomMode("duplicate")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => handleExportSingle(activeMode.id)}>
                <Download className="mr-2 size-4" />
                {tCommon("export")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => setDeleteConfirmId(activeMode.id)}
                className="text-destructive focus:text-destructive"
              >
                <Trash2 className="mr-2 size-4" />
                {tCommon("delete")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
        <div data-testid="custom-mode-detail-meta">
          <DetailRow label={tCustomMode("detail.tools")}>
            {activeMode.tools && activeMode.tools.length > 0 ? (
              <span className="flex flex-wrap justify-end gap-1">
                {activeMode.tools.map((tool) => (
                  <Badge key={tool} variant="secondary" className="font-mono text-[10px]">
                    {tool}
                  </Badge>
                ))}
              </span>
            ) : (
              <span className="text-muted-foreground">{tCustomMode("detail.none")}</span>
            )}
          </DetailRow>
          <DetailRow label={tCustomMode("detail.tags")}>
            {activeMode.tags && activeMode.tags.length > 0 ? (
              <span className="flex flex-wrap justify-end gap-1">
                {activeMode.tags.map((tag) => (
                  <Badge key={tag} variant="outline" className="text-[10px]">
                    {tag}
                  </Badge>
                ))}
              </span>
            ) : (
              <span className="text-muted-foreground">{tCustomMode("detail.none")}</span>
            )}
          </DetailRow>
          {activeMode.outputFormat ? (
            <DetailRow label={tCustomMode("detail.outputFormat")}>
              <span className="font-mono text-xs">{activeMode.outputFormat}</span>
            </DetailRow>
          ) : null}
          {activeMode.permissionMode ? (
            <DetailRow label={tCustomMode("detail.permissionMode")}>
              <span className="font-mono text-xs">{activeMode.permissionMode}</span>
            </DetailRow>
          ) : null}
          {activeMode.modelOverride ? (
            <DetailRow label={tCustomMode("detail.modelOverride")}>
              <span className="font-mono text-xs">{activeMode.modelOverride}</span>
            </DetailRow>
          ) : null}
          <DetailRow label={tCustomMode("detail.usage")}>
            <span className="tabular-nums">
              {tCustomMode("usedTimes", { count: activeMode.usageCount || 0 })}
            </span>
          </DetailRow>
          <DetailRow label={tCustomMode("detail.updated")}>
            <span className="text-xs text-muted-foreground">
              {activeMode.updatedAt.toLocaleString()}
            </span>
          </DetailRow>
        </div>

        <div className="space-y-2">
          <p className="text-xs font-medium">{tCustomMode("detail.systemPrompt")}</p>
          {activeMode.systemPrompt ? (
            <pre
              className="max-h-64 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs whitespace-pre-wrap"
              data-testid="custom-mode-system-prompt"
            >
              {activeMode.systemPrompt}
            </pre>
          ) : (
            <p className="text-xs text-muted-foreground">{tCustomMode("detail.noSystemPrompt")}</p>
          )}
        </div>
      </div>
    </div>
  ) : (
    <div className="flex h-full items-center justify-center p-6">
      <Empty className="border-0">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Bot className="size-6" />
          </EmptyMedia>
          <EmptyTitle>{tCustomMode("detailEmptyTitle")}</EmptyTitle>
          <EmptyDescription>{tCustomMode("detailEmptyDescription")}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button variant="outline" size="sm" onClick={handleCreateNew}>
            <Plus className="mr-2 size-4" />
            {t("createMode")}
          </Button>
        </EmptyContent>
      </Empty>
    </div>
  )

  return (
    <div className="flex h-full min-h-0 flex-col gap-4" data-testid="custom-mode-settings">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 items-start gap-2.5">
          <Bot aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 space-y-0.5">
            <h2 className="text-base font-semibold tracking-tight">{tSettings("customModes")}</h2>
            <p className="text-xs text-pretty text-muted-foreground">
              {tSettings("customModesDesc")}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()}>
            <Upload className="mr-2 size-4" />
            {tCommon("import")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleExportAll}
            disabled={modesArray.length === 0}
          >
            <Download className="mr-2 size-4" />
            {tCommon("export")}
          </Button>
          <Button size="sm" onClick={handleCreateNew}>
            <Plus className="mr-2 size-4" />
            {t("createMode")}
          </Button>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 md:grid-cols-[300px_minmax(0,1fr)]">
        {/* Desktop rail */}
        <div className="hidden min-h-0 md:flex md:flex-col md:overflow-hidden md:rounded-lg md:border">
          {rail}
        </div>

        {/* Below md the rail lives in a Sheet; the bar shows where you are. */}
        <div className="flex items-center gap-2 md:hidden">
          <Sheet open={mobileSheetOpen} onOpenChange={setMobileSheetOpen}>
            <SheetTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="shrink-0 gap-1.5"
                data-testid="custom-mode-mobile-nav-trigger"
              >
                <Menu className="size-4" />
                {tCustomMode("mobileTrigger")}
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="flex w-[300px] flex-col p-0">
              <SheetHeader className="px-3 pt-3">
                <SheetTitle className="text-sm">{tSettings("customModes")}</SheetTitle>
              </SheetHeader>
              {rail}
            </SheetContent>
          </Sheet>
          {activeMode ? (
            <p className="min-w-0 flex-1 truncate text-sm font-medium">{activeMode.name}</p>
          ) : null}
        </div>

        {/* Detail pane */}
        <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border">
          <PanelTransition
            activeKey={activeMode?.id ?? "__empty__"}
            className="flex min-h-0 flex-1 flex-col"
          >
            {detail}
          </PanelTransition>
        </div>
      </div>

      {/* Hidden file input for import */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".json"
        onChange={handleImport}
        className="hidden"
      />

      {/* Mode Editor Dialog */}
      <CustomModeEditor
        open={showEditor}
        onOpenChange={setShowEditor}
        mode={editingMode}
        onSave={() => setShowEditor(false)}
      />

      {/* Delete Confirmation Dialog */}
      <AlertDialog
        open={!!deleteConfirmId}
        onOpenChange={(open) => !open && setDeleteConfirmId(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{tCommon("delete")}</AlertDialogTitle>
            <AlertDialogDescription>{tCustomMode("deleteConfirmDesc")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tCommon("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {tCommon("delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

export default CustomModeSettings
