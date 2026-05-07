"use client"

/**
 * CustomModeSettings - Settings page component for managing custom agent modes
 * Provides import/export, bulk actions, and mode list management
 */

import { useState, useCallback, useRef } from "react"
import { useTranslations } from "next-intl"
import { loggers } from "@/lib/logger"
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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ScrollArea } from "@/components/ui/scroll-area"
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
import {
  useCustomModeStore,
  type CustomModeConfig,
  type CustomModeCategory,
} from "@/stores/agent/custom-mode-store"
import { CustomModeEditor } from "@/components/agent/custom-mode-editor"

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

  // File input ref for import
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Get modes as array. The custom-mode store hydrates `customModes`
  // asynchronously, so guard against the initial null/undefined snapshot
  // that some test fixtures hand back without a fully-populated record.
  const modesArray = Object.values(customModes ?? {})

  // Filter and sort modes
  const filteredModes = modesArray
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
        default:
          return 0
      }
    })

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

  return (
    <div className="space-y-6">
      {/* Header */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Bot className="h-5 w-5" />
                {tSettings("customModes")}
              </CardTitle>
              <CardDescription>{tSettings("customModesDesc")}</CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()}>
                <Upload className="h-4 w-4 mr-2" />
                {tCommon("import")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={handleExportAll}
                disabled={modesArray.length === 0}
              >
                <Download className="h-4 w-4 mr-2" />
                {tCommon("export")}
              </Button>
              <Button size="sm" onClick={handleCreateNew}>
                <Plus className="h-4 w-4 mr-2" />
                {t("createMode")}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {/* Filters */}
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:gap-4 mb-4">
            <div className="flex-1">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder={tCustomMode("searchModes")}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-9"
                />
              </div>
            </div>
            <Select
              value={filterCategory}
              onValueChange={(v) => setFilterCategory(v as FilterCategory)}
            >
              <SelectTrigger className="w-full md:w-[150px]">
                <Filter className="h-4 w-4 mr-2" />
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
              <SelectTrigger className="w-full md:w-[150px]">
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
              className="flex flex-wrap items-center gap-2 mb-4 p-3 border bg-muted/50 rounded-md"
              role="status"
            >
              <span className="text-sm text-muted-foreground" aria-live="polite">
                {tCustomMode("selected", { count: selectedModes.size })}
              </span>
              <Button variant="ghost" size="sm" onClick={clearSelection}>
                {tCustomMode("clear")}
              </Button>
              <Button variant="ghost" size="sm" onClick={selectAll}>
                {tCustomMode("selectAll")}
              </Button>
              <div className="flex-1" />
              <Button variant="destructive" size="sm" onClick={handleBulkDelete}>
                <Trash2 className="h-4 w-4 mr-2" />
                {tCustomMode("deleteSelected")}
              </Button>
            </div>
          )}

          {/* Results count — visible only when filters narrow the list */}
          {(searchQuery || filterCategory !== "all") && modesArray.length > 0 && (
            <p
              className="text-xs text-muted-foreground mb-2"
              aria-live="polite"
              data-testid="custom-mode-results-count"
            >
              {tCustomMode("resultsCount", {
                shown: filteredModes.length,
                total: modesArray.length,
              })}
            </p>
          )}

          {/* Mode list */}
          <ScrollArea className="h-[min(60vh,calc(100dvh-280px))] min-h-[320px]">
            {filteredModes.length === 0 ? (
              <Empty className="h-[300px] border-0">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <Bot className="h-6 w-6" />
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
                      <Plus className="h-4 w-4 mr-2" />
                      {tCustomMode("createFirstMode")}
                    </Button>
                  </EmptyContent>
                )}
              </Empty>
            ) : (
              <div className="space-y-2">
                {filteredModes.map((mode) => (
                  <div
                    key={mode.id}
                    className={cn(
                      "flex items-center gap-3 p-3 rounded-lg border transition-colors focus-within:ring-2 focus-within:ring-ring",
                      selectedModes.has(mode.id) ? "bg-accent border-accent" : "hover:bg-muted/50"
                    )}
                  >
                    {/* Selection checkbox */}
                    <Checkbox
                      checked={selectedModes.has(mode.id)}
                      onCheckedChange={() => toggleModeSelection(mode.id)}
                    />

                    {/* Icon */}
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted">
                      <ModeIcon name={mode.icon} className="h-5 w-5" />
                    </div>

                    {/* Info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{mode.name}</span>
                        {mode.category && (
                          <Badge variant="outline" className="text-xs">
                            {t(CATEGORY_TRANSLATION_KEYS[mode.category as CustomModeCategory])}
                          </Badge>
                        )}
                      </div>
                      <p className="text-sm text-muted-foreground truncate">
                        {mode.description || tCustomMode("noDescription")}
                      </p>
                      <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
                        <span>{tCustomMode("tools", { count: mode.tools?.length || 0 })}</span>
                        <span>•</span>
                        <span>{tCustomMode("usedTimes", { count: mode.usageCount || 0 })}</span>
                      </div>
                    </div>

                    {/* Inline edit (md+ only — mobile uses dropdown) */}
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 hidden md:flex"
                      onClick={() => handleEdit(mode)}
                      aria-label={tCustomMode("editMode", { name: mode.name })}
                      data-testid={`mode-edit-${mode.id}`}
                    >
                      <Edit className="h-4 w-4" />
                    </Button>

                    {/* Actions */}
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          aria-label={tCustomMode("moreActions", { name: mode.name })}
                        >
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => handleEdit(mode)}>
                          <Edit className="h-4 w-4 mr-2" />
                          {tCommon("edit")}
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => handleDuplicate(mode.id)}>
                          <Copy className="h-4 w-4 mr-2" />
                          {tCustomMode("duplicate")}
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => handleExportSingle(mode.id)}>
                          <Download className="h-4 w-4 mr-2" />
                          {tCommon("export")}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          onClick={() => setDeleteConfirmId(mode.id)}
                          className="text-destructive focus:text-destructive"
                        >
                          <Trash2 className="h-4 w-4 mr-2" />
                          {tCommon("delete")}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                ))}
              </div>
            )}
          </ScrollArea>
        </CardContent>
      </Card>

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
