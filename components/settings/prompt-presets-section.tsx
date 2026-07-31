"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { toast } from "sonner"
import {
  ArrowDownUpIcon,
  CheckSquareIcon,
  DownloadIcon,
  MoreVerticalIcon,
  PlusIcon,
  RefreshCcwIcon,
  StarIcon,
  StarOffIcon,
  Trash2Icon,
  UploadIcon,
  XIcon,
} from "lucide-react"
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core"
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"

import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

import { listMcpServers } from "@/lib/db/mcp-servers"
import { listSkills } from "@/lib/db/skills"
import {
  createPreset,
  deletePreset,
  duplicatePreset,
  isBuiltInPreset,
  listPresets,
  reorderPresets,
  resetPresetsToBuiltIns,
  setDefaultPreset,
  clearDefaultPreset,
  togglePresetFavorite,
  updatePreset,
} from "@/lib/db/prompt-presets"
import type { PresetCategory, SystemPromptPreset } from "@cognia/agent-config-types"
import { PRESET_CATEGORIES } from "@/lib/presets/categories"
import {
  applyDomainImport,
  buildDomainExport,
  defaultDomainFileName,
  detectDomainFile,
  serializeDomainFile,
} from "@/lib/data/domain"
import { cn } from "@/lib/utils"

import { PresetCard } from "./presets/preset-card"
import {
  PresetEditor,
  emptyEditorState,
  presetToEditorState,
  type PresetEditorOutput,
} from "./presets/preset-editor"
import { PresetListToolbar } from "./presets/preset-list-toolbar"
import { createLogger } from "@cognia/logging"

const log = createLogger("settings.presets")

interface FilterState {
  source: "all" | "builtIn" | "custom"
  favorites: boolean
  recent: boolean
  hasMcp: boolean
  hasSkills: boolean
  category: PresetCategory | null
}

const INITIAL_FILTERS: FilterState = {
  source: "all",
  favorites: false,
  recent: false,
  hasMcp: false,
  hasSkills: false,
  category: null,
}

export interface PromptPresetsSectionProps {
  /** When true, switch to single-column mobile layout. */
  mobile?: boolean
}

export function PromptPresetsSection({ mobile = false }: PromptPresetsSectionProps) {
  const t = useTranslations("presets")
  const tCategory = useTranslations("presets.category")
  const safeT = (k: string, fallback: string, values?: Record<string, string | number>) => {
    const out = t(k as never, values as never)
    return out === `presets.${k}` || out === k ? fallback : out
  }
  const safeTCategory = (k: string, fallback: string) => {
    const out = tCategory(k as never)
    return out === `presets.category.${k}` || out === k ? fallback : out
  }

  const presetsRaw = useLiveQuery(() => listPresets(), [])
  const skillsRaw = useLiveQuery(() => listSkills(), [])
  const mcpRaw = useLiveQuery(() => listMcpServers(), [])
  const presets = useMemo(() => presetsRaw ?? [], [presetsRaw])
  const skills = useMemo(() => skillsRaw ?? [], [skillsRaw])
  const mcpServers = useMemo(() => mcpRaw ?? [], [mcpRaw])

  const [search, setSearch] = useState("")
  const [filters, setFilters] = useState<FilterState>(INITIAL_FILTERS)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [reorderMode, setReorderMode] = useState(false)
  const [selectionMode, setSelectionMode] = useState(false)
  const [selection, setSelection] = useState<Set<string>>(new Set())
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false)

  const fileInputRef = useRef<HTMLInputElement | null>(null)

  // Selection auto-resets when filters or list change so users don't act
  // on rows they can no longer see. Reorder and selection modes are
  // mutually exclusive — entering one clears the other.
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect */
    setSelection(new Set())
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [filters, search])

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect */
    if (reorderMode) {
      setSelectionMode(false)
      setSelection(new Set())
    }
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [reorderMode])

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect */
    if (selectionMode) setReorderMode(false)
    else setSelection(new Set())
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [selectionMode])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    let rows = presets

    if (q) {
      rows = rows.filter((p) => {
        return (
          p.name.toLowerCase().includes(q) ||
          (p.description?.toLowerCase().includes(q) ?? false) ||
          p.content.toLowerCase().includes(q) ||
          (p.category?.toLowerCase().includes(q) ?? false)
        )
      })
    }

    if (filters.source === "builtIn") rows = rows.filter((p) => p.isBuiltIn === true)
    else if (filters.source === "custom") rows = rows.filter((p) => p.isBuiltIn !== true)

    if (filters.favorites) rows = rows.filter((p) => p.isFavorite === true)
    if (filters.hasMcp) rows = rows.filter((p) => (p.mcpServerIds?.length ?? 0) > 0)
    if (filters.hasSkills) rows = rows.filter((p) => (p.skillIds?.length ?? 0) > 0)
    if (filters.category) rows = rows.filter((p) => p.category === filters.category)

    if (filters.recent) {
      rows = [...rows]
        .filter((p) => p.lastUsedAt !== undefined)
        .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))
        .slice(0, 12)
    }

    return rows
  }, [presets, search, filters])

  const handleCreate = async (data: PresetEditorOutput) => {
    try {
      await createPreset({
        name: data.name,
        content: data.content,
        description: data.description,
        icon: data.icon,
        color: data.color,
        category: data.category,
        model: data.model,
        permissionMode: data.permissionMode,
        effort: data.effort,
        allowedTools: data.allowedTools,
        disallowedTools: data.disallowedTools,
        mcpServerIds: data.mcpServerIds,
        skillIds: data.skillIds,
        agentModeId: data.agentModeId,
        workingDir: data.workingDir,
        isDefault: data.isDefault,
        isFavorite: data.isFavorite,
      })
      log.info("preset_created", { name: data.name, category: data.category })
      setCreating(false)
      toast.success(
        safeT("toast.created", `Preset "${data.name}" created.`).replace("{name}", data.name)
      )
    } catch (err) {
      log.error("preset_create_failed", err, { name: data.name })
      throw err
    }
  }

  const handleUpdate = async (id: string, data: PresetEditorOutput) => {
    try {
      await updatePreset(id, {
        name: data.name,
        content: data.content,
        description: data.description,
        icon: data.icon,
        color: data.color,
        category: data.category,
        model: data.model,
        permissionMode: data.permissionMode,
        effort: data.effort,
        allowedTools: data.allowedTools,
        disallowedTools: data.disallowedTools,
        mcpServerIds: data.mcpServerIds,
        skillIds: data.skillIds,
        agentModeId: data.agentModeId,
        workingDir: data.workingDir,
        isDefault: data.isDefault,
        isFavorite: data.isFavorite,
      })
      log.info("preset_updated", { id })
      setEditingId(null)
      toast.success(
        safeT("toast.updated", `Preset "${data.name}" updated.`).replace("{name}", data.name)
      )
    } catch (err) {
      log.error("preset_update_failed", err, { id })
      throw err
    }
  }

  const handleDelete = async (preset: SystemPromptPreset) => {
    try {
      await deletePreset(preset.id)
      log.info("preset_deleted", { id: preset.id })
      toast.success(
        safeT("toast.deleted", `Deleted "${preset.name}".`).replace("{name}", preset.name)
      )
    } catch (err) {
      log.error("preset_delete_failed", err, { id: preset.id })
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  const handleDuplicate = async (preset: SystemPromptPreset) => {
    try {
      const copy = await duplicatePreset(preset.id)
      log.info("preset_duplicated", { sourceId: preset.id, newId: copy.id })
      toast.success(
        safeT("toast.duplicated", `Duplicated as "${copy.name}".`).replace("{name}", copy.name)
      )
      setEditingId(copy.id)
    } catch (err) {
      log.error("preset_duplicate_failed", err, { id: preset.id })
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  const handleToggleDefault = async (preset: SystemPromptPreset) => {
    try {
      if (preset.isDefault) {
        await clearDefaultPreset()
        log.info("preset_default_cleared", { id: preset.id })
        toast.success(safeT("toast.defaultCleared", "Default preset cleared."))
      } else {
        await setDefaultPreset(preset.id)
        log.info("preset_default_set", { id: preset.id })
        toast.success(
          safeT("toast.defaultSet", `"${preset.name}" is now the default.`).replace(
            "{name}",
            preset.name
          )
        )
      }
    } catch (err) {
      log.error("preset_default_toggle_failed", err, { id: preset.id })
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  const handleToggleFavorite = async (preset: SystemPromptPreset) => {
    try {
      await togglePresetFavorite(preset.id)
      log.info("preset_favorite_toggled", { id: preset.id })
    } catch (err) {
      log.error("preset_favorite_failed", err, { id: preset.id })
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  const handleReset = async () => {
    try {
      log.warn("preset_reset_initiated")
      await resetPresetsToBuiltIns()
      log.warn("preset_reset_completed")
      toast.success(safeT("toast.reset", "Reset to built-in presets."))
    } catch (err) {
      log.error("preset_reset_failed", err)
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  const handleExport = async () => {
    try {
      const file = await buildDomainExport("promptPresets")
      const blob = new Blob([serializeDomainFile(file)], { type: "application/json" })
      const url = URL.createObjectURL(blob)
      const link = document.createElement("a")
      link.href = url
      link.download = defaultDomainFileName("promptPresets")
      link.click()
      URL.revokeObjectURL(url)
      const exportedCount = file.payload.promptPresets?.length ?? 0
      log.info("preset_exported", { count: exportedCount })
      toast.success(
        safeT("toast.exported", `Exported ${exportedCount} presets.`).replace(
          "{count}",
          String(exportedCount)
        )
      )
    } catch (err) {
      log.error("preset_export_failed", err)
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  const handleImport = async (file: File) => {
    try {
      const text = await file.text()
      const parsed: unknown = JSON.parse(text)
      if (!detectDomainFile(parsed)) {
        log.warn("preset_import_invalid_file")
        toast.error(safeT("toast.importInvalid", "Not a recognised preset export."))
        return
      }
      const summary = await applyDomainImport(parsed, "skip")
      const added = summary.added.promptPresets ?? 0
      const skipped = summary.skipped.promptPresets ?? 0
      log.info("preset_imported", { added, skipped })
      toast.success(
        safeT("toast.imported", `Imported ${added} new presets (${skipped} skipped).`)
          .replace("{added}", String(added))
          .replace("{skipped}", String(skipped))
      )
    } catch (err) {
      log.error("preset_import_failed", err)
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  const handleReorder = async (orderedIds: string[]) => {
    try {
      await reorderPresets(orderedIds)
      log.info("preset_reordered", { count: orderedIds.length })
    } catch (err) {
      log.error("preset_reorder_failed", err)
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  const toggleSelection = useCallback((id: string) => {
    setSelection((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const selectedPresets = useMemo(
    () => filtered.filter((p) => selection.has(p.id)),
    [filtered, selection]
  )
  const selectedNonBuiltIn = useMemo(
    () => selectedPresets.filter((p) => !isBuiltInPreset(p)),
    [selectedPresets]
  )
  const allSelectedAreFavorite =
    selectedNonBuiltIn.length > 0 && selectedNonBuiltIn.every((p) => p.isFavorite === true)
  const hasBuiltInsInSelection = selectedPresets.some((p) => isBuiltInPreset(p))

  const handleBulkFavorite = async () => {
    // Toggle: if every non-built-in selection is already favorite, unmark
    // them; otherwise mark the ones that aren't.
    const targets = selectedNonBuiltIn
    if (targets.length === 0) return
    try {
      if (allSelectedAreFavorite) {
        for (const p of targets) {
          if (p.isFavorite === true) await togglePresetFavorite(p.id)
        }
        toast.success(safeT("bulk.unfavoritedToast", `Unfavorited ${targets.length} presets.`))
      } else {
        for (const p of targets) {
          if (p.isFavorite !== true) await togglePresetFavorite(p.id)
        }
        toast.success(safeT("bulk.favoritedToast", `Favorited ${targets.length} presets.`))
      }
      log.info("preset_bulk_favorite", { count: targets.length, toggled: !allSelectedAreFavorite })
    } catch (err) {
      log.error("preset_bulk_favorite_failed", err)
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  const handleBulkDelete = async () => {
    const targets = selectedNonBuiltIn
    setBulkDeleteOpen(false)
    if (targets.length === 0) return
    try {
      for (const p of targets) {
        await deletePreset(p.id)
      }
      log.info("preset_bulk_delete", { count: targets.length })
      toast.success(
        safeT("bulk.deletedToast", `Deleted ${targets.length} presets.`).replace(
          "{count}",
          String(targets.length)
        )
      )
      setSelection(new Set())
    } catch (err) {
      log.error("preset_bulk_delete_failed", err)
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  const filterChips = (
    <>
      <ChipGroup>
        <Chip
          active={filters.source === "all"}
          onClick={() => setFilters((f) => ({ ...f, source: "all" }))}
        >
          {safeT("filter.all", "All")}
        </Chip>
        <Chip
          active={filters.source === "builtIn"}
          onClick={() => setFilters((f) => ({ ...f, source: "builtIn" }))}
        >
          {safeT("filter.builtIn", "Built-in")}
        </Chip>
        <Chip
          active={filters.source === "custom"}
          onClick={() => setFilters((f) => ({ ...f, source: "custom" }))}
        >
          {safeT("filter.custom", "Custom")}
        </Chip>
      </ChipGroup>
      <ChipDivider />
      <Chip
        active={filters.favorites}
        onClick={() => setFilters((f) => ({ ...f, favorites: !f.favorites }))}
      >
        {safeT("filter.favorites", "Favorites")}
      </Chip>
      <Chip
        active={filters.recent}
        onClick={() => setFilters((f) => ({ ...f, recent: !f.recent }))}
      >
        {safeT("filter.recent", "Recently used")}
      </Chip>
      <Chip
        active={filters.hasMcp}
        onClick={() => setFilters((f) => ({ ...f, hasMcp: !f.hasMcp }))}
      >
        {safeT("filter.hasMcp", "Has MCP")}
      </Chip>
      <Chip
        active={filters.hasSkills}
        onClick={() => setFilters((f) => ({ ...f, hasSkills: !f.hasSkills }))}
      >
        {safeT("filter.hasSkills", "Has Skills")}
      </Chip>
      <ChipDivider />
      <Chip
        active={filters.category === null}
        onClick={() => setFilters((f) => ({ ...f, category: null }))}
      >
        {safeTCategory("uncategorized", "All categories")}
      </Chip>
      {PRESET_CATEGORIES.map((c) => (
        <Chip
          key={c.id}
          active={filters.category === c.id}
          onClick={() => setFilters((f) => ({ ...f, category: f.category === c.id ? null : c.id }))}
        >
          {safeTCategory(c.labelKey, c.id)}
        </Chip>
      ))}
    </>
  )

  const rightActions = (
    <>
      {!selectionMode && (
        <Button
          size="sm"
          variant={reorderMode ? "default" : "outline"}
          onClick={() => setReorderMode((v) => !v)}
          disabled={presets.length < 2}
          title={safeT("actions.reorder", "Toggle reorder mode")}
        >
          <ArrowDownUpIcon className="size-4" />
          <span className="ml-1.5 hidden sm:inline">
            {reorderMode
              ? safeT("actions.doneReorder", "Done")
              : safeT("actions.reorder", "Reorder")}
          </span>
        </Button>
      )}
      <Button
        size="sm"
        variant={selectionMode ? "default" : "outline"}
        onClick={() => setSelectionMode((v) => !v)}
        disabled={presets.length < 1}
        title={safeT("bulk.selectMode", "Toggle multi-select")}
      >
        {selectionMode ? <XIcon className="size-4" /> : <CheckSquareIcon className="size-4" />}
        <span className="ml-1.5 hidden sm:inline">
          {selectionMode
            ? safeT("bulk.exitSelectMode", "Done")
            : safeT("bulk.selectMode", "Select")}
        </span>
      </Button>
      {!selectionMode && !reorderMode && (
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setEditingId(null)
            setCreating(true)
          }}
        >
          <PlusIcon className="mr-1.5 size-4" />
          {safeT("actions.new", "New preset")}
        </Button>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="icon" className="size-8" aria-label={t("moreActions")}>
            <MoreVerticalIcon className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuItem onSelect={() => void handleExport()}>
            <DownloadIcon className="size-4" />
            {safeT("actions.export", "Export presets…")}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={(e) => {
              e.preventDefault()
              fileInputRef.current?.click()
            }}
          >
            <UploadIcon className="size-4" />
            {safeT("actions.import", "Import presets…")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <DropdownMenuItem
                onSelect={(e) => e.preventDefault()}
                className="text-destructive focus:text-destructive"
              >
                <RefreshCcwIcon className="size-4" />
                {safeT("actions.reset", "Reset to built-ins…")}
              </DropdownMenuItem>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {safeT("resetConfirmTitle", "Reset to built-in presets?")}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {safeT(
                    "resetConfirmDescription",
                    "Every preset — including custom ones you created — is removed and the built-ins are restored. This can't be undone."
                  )}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{safeT("actions.cancel", "Cancel")}</AlertDialogCancel>
                <AlertDialogAction onClick={() => void handleReset()}>
                  {safeT("actions.reset", "Reset")}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </DropdownMenuContent>
      </DropdownMenu>
      <input
        ref={fileInputRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) void handleImport(f)
          e.target.value = ""
        }}
      />
    </>
  )

  const bulkActions = (
    <>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => void handleBulkFavorite()}
        disabled={selectedNonBuiltIn.length === 0}
        aria-label={
          allSelectedAreFavorite
            ? safeT("bulk.unfavoriteAll", "Unfavorite")
            : safeT("bulk.favoriteAll", "Favorite")
        }
      >
        {allSelectedAreFavorite ? (
          <StarOffIcon className="size-3.5 sm:mr-1.5" />
        ) : (
          <StarIcon className="size-3.5 sm:mr-1.5" />
        )}
        <span className="hidden sm:inline">
          {allSelectedAreFavorite
            ? safeT("bulk.unfavoriteAll", "Unfavorite")
            : safeT("bulk.favoriteAll", "Favorite")}
        </span>
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="text-destructive"
        onClick={() => setBulkDeleteOpen(true)}
        disabled={selectedNonBuiltIn.length === 0}
        aria-label={safeT("bulk.deleteAll", "Delete")}
      >
        <Trash2Icon className="size-3.5 sm:mr-1.5" />
        <span className="hidden sm:inline">{safeT("bulk.deleteAll", "Delete")}</span>
      </Button>
    </>
  )

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <Label>{safeT("title", "Presets")}</Label>
        <p className="text-xs text-muted-foreground">
          {safeT(
            "subtitle",
            "Reusable session configurations — system prompt plus model, tool, MCP, and skill overrides. Apply per session or set one as the default for new chats."
          )}
        </p>
      </div>

      <PresetListToolbar
        searchValue={search}
        onSearchChange={setSearch}
        filterChips={filterChips}
        rightActions={rightActions}
        selectionCount={selection.size}
        onClearSelection={() => setSelection(new Set())}
        bulkActions={bulkActions}
      />

      {hasBuiltInsInSelection && selectionMode && (
        <p className="text-[11px] italic text-muted-foreground">
          {safeT("bulk.builtInsSkipped", "Built-in presets in your selection will be skipped.")}
        </p>
      )}

      {filtered.length === 0 && !creating ? (
        <p className="rounded-md border border-dashed p-6 text-center text-xs text-muted-foreground">
          {presets.length === 0
            ? safeT(
                "emptyState",
                "No presets yet. The 12 built-ins should appear here on first launch."
              )
            : safeT("emptyFiltered", "No presets match your filters.")}
        </p>
      ) : reorderMode ? (
        <ReorderableList
          presets={filtered}
          onReorder={handleReorder}
          onEdit={(p) => setEditingId(p.id)}
          onDuplicate={handleDuplicate}
          onDelete={handleDelete}
          onToggleDefault={handleToggleDefault}
          onToggleFavorite={handleToggleFavorite}
        />
      ) : (
        <div className={cn("grid gap-2", !mobile && "sm:grid-cols-1")}>
          {filtered.map((p) =>
            editingId === p.id ? (
              <PresetEditor
                key={p.id}
                initial={presetToEditorState(p)}
                skillsCatalog={skills}
                mcpCatalog={mcpServers}
                submitLabel={safeT("actions.save", "Save")}
                onCancel={() => setEditingId(null)}
                onSave={(data) => handleUpdate(p.id, data)}
              />
            ) : (
              <PresetCard
                key={p.id}
                preset={p}
                selected={selectionMode ? selection.has(p.id) : undefined}
                onSelectToggle={selectionMode ? () => toggleSelection(p.id) : undefined}
                onEdit={() => {
                  if (isBuiltInPreset(p)) {
                    void handleDuplicate(p)
                    return
                  }
                  setEditingId(p.id)
                }}
                onDuplicate={() => void handleDuplicate(p)}
                onDelete={() => void handleDelete(p)}
                onToggleDefault={() => void handleToggleDefault(p)}
                onToggleFavorite={() => void handleToggleFavorite(p)}
              />
            )
          )}
        </div>
      )}

      {creating && (
        <PresetEditor
          initial={emptyEditorState()}
          skillsCatalog={skills}
          mcpCatalog={mcpServers}
          submitLabel={safeT("actions.create", "Create preset")}
          onCancel={() => setCreating(false)}
          onSave={handleCreate}
        />
      )}

      <AlertDialog open={bulkDeleteOpen} onOpenChange={setBulkDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {safeT("bulk.deleteConfirmTitle", `Delete ${selectedNonBuiltIn.length} presets?`, {
                count: selectedNonBuiltIn.length,
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {safeT(
                "bulk.deleteConfirmDescription",
                "The selected presets will be removed from your library. Built-in presets in the selection are skipped automatically. This can't be undone."
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{safeT("actions.cancel", "Cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void handleBulkDelete()}>
              {safeT("bulk.deleteAll", "Delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

// --- Inline filter-chip helpers ----------------------------------------

function ChipGroup({ children }: { children: React.ReactNode }) {
  return <div className="inline-flex items-center gap-1">{children}</div>
}

function ChipDivider() {
  return <span className="mx-1 inline-block h-4 w-px bg-border" aria-hidden />
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs transition-colors",
        active
          ? "border-primary bg-primary/10 text-foreground"
          : "border-border bg-muted/30 text-muted-foreground hover:bg-muted"
      )}
    >
      {children}
    </button>
  )
}

// --- Reorder mode (drag-and-drop) ---------------------------------------

interface ReorderProps {
  presets: SystemPromptPreset[]
  onReorder: (orderedIds: string[]) => Promise<void>
  onEdit: (p: SystemPromptPreset) => void
  onDuplicate: (p: SystemPromptPreset) => void
  onDelete: (p: SystemPromptPreset) => void
  onToggleDefault: (p: SystemPromptPreset) => void
  onToggleFavorite: (p: SystemPromptPreset) => void
}

function ReorderableList({
  presets,
  onReorder,
  onEdit,
  onDuplicate,
  onDelete,
  onToggleDefault,
  onToggleFavorite,
}: ReorderProps) {
  const [order, setOrder] = useState<string[]>(() => presets.map((p) => p.id))
  const [prevPresets, setPrevPresets] = useState(presets)
  if (presets !== prevPresets) {
    setPrevPresets(presets)
    const sameSet =
      order.length === presets.length && order.every((id) => presets.some((p) => p.id === id))
    if (!sameSet) {
      setOrder(presets.map((p) => p.id))
    }
  }

  const orderedPresets = useMemo(() => {
    const byId = new Map(presets.map((p) => [p.id, p]))
    return order.map((id) => byId.get(id)).filter((p): p is SystemPromptPreset => Boolean(p))
  }, [order, presets])

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = order.indexOf(active.id as string)
    const newIndex = order.indexOf(over.id as string)
    if (oldIndex === -1 || newIndex === -1) return
    const next = arrayMove(order, oldIndex, newIndex)
    setOrder(next)
    void onReorder(next)
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={order} strategy={verticalListSortingStrategy}>
        <div className="space-y-2">
          {orderedPresets.map((p) => (
            <SortableRow
              key={p.id}
              preset={p}
              onEdit={() => onEdit(p)}
              onDuplicate={() => onDuplicate(p)}
              onDelete={() => onDelete(p)}
              onToggleDefault={() => onToggleDefault(p)}
              onToggleFavorite={() => onToggleFavorite(p)}
            />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  )
}

interface SortableRowProps {
  preset: SystemPromptPreset
  onEdit: () => void
  onDuplicate: () => void
  onDelete: () => void
  onToggleDefault: () => void
  onToggleFavorite: () => void
}

function SortableRow({ preset, ...handlers }: SortableRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: preset.id,
  })
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
  }
  return (
    <div ref={setNodeRef} style={style}>
      <PresetCard
        preset={preset}
        reorderable
        dragHandleProps={{ ...attributes, ...listeners }}
        {...handlers}
      />
    </div>
  )
}
