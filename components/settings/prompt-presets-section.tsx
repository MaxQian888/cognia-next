"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { toast } from "sonner"
import {
  ArrowDownUpIcon,
  DownloadIcon,
  FilterIcon,
  MoreVerticalIcon,
  PlusIcon,
  RefreshCcwIcon,
  SearchIcon,
  UploadIcon,
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
import { Input } from "@/components/ui/input"
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

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
import type { SystemPromptPreset } from "@/lib/claude/types"
import { PRESET_CATEGORIES } from "@/lib/presets/categories"
import {
  applyDomainImport,
  buildDomainExport,
  defaultDomainFileName,
  detectDomainFile,
  serializeDomainFile,
} from "@/lib/data/domain"

import { PresetCard } from "./presets/preset-card"
import {
  PresetEditor,
  emptyEditorState,
  presetToEditorState,
  type PresetEditorOutput,
} from "./presets/preset-editor"
import { createLogger } from "@/lib/logger"

const log = createLogger("settings.presets")

type FilterMode = "all" | "favorites" | "recent" | "builtIn" | "custom"

export function PromptPresetsSection() {
  const t = useTranslations("presets")
  const tCategory = useTranslations("presets.category")
  const safeT = (k: string, fallback: string) => {
    const out = t(k as never)
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
  const [filter, setFilter] = useState<FilterMode | string>("all")
  const [editingId, setEditingId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [reorderMode, setReorderMode] = useState(false)

  const fileInputRef = useRef<HTMLInputElement | null>(null)

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
    switch (filter) {
      case "favorites":
        rows = rows.filter((p) => p.isFavorite)
        break
      case "recent":
        rows = [...rows]
          .filter((p) => p.lastUsedAt !== undefined)
          .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))
          .slice(0, 12)
        break
      case "builtIn":
        rows = rows.filter((p) => p.isBuiltIn === true)
        break
      case "custom":
        rows = rows.filter((p) => p.isBuiltIn !== true)
        break
      case "all":
        break
      default:
        // Category id
        rows = rows.filter((p) => p.category === filter)
    }
    return rows
  }, [presets, search, filter])

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

  return (
    <div className="space-y-4">
      {/* --- Header ------------------------------------------------ */}
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <Label>{safeT("title", "Presets")}</Label>
          <p className="text-xs text-muted-foreground">
            {safeT(
              "subtitle",
              "Reusable session configurations — system prompt plus model, tool, MCP, and skill overrides. Apply per session or set one as the default for new chats."
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
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
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="icon" className="size-8" aria-label="More actions">
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
        </div>
      </div>

      {/* --- Search + filter ---------------------------------------- */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <SearchIcon className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={safeT("searchPlaceholder", "Search presets…")}
            className="pl-8"
          />
        </div>
        <div className="flex items-center gap-2">
          <FilterIcon className="size-3.5 text-muted-foreground" />
          <Select value={filter} onValueChange={(v) => setFilter(v)}>
            <SelectTrigger className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{safeT("filter.all", "All")}</SelectItem>
              <SelectItem value="favorites">{safeT("filter.favorites", "Favorites")}</SelectItem>
              <SelectItem value="recent">{safeT("filter.recent", "Recently used")}</SelectItem>
              <SelectItem value="builtIn">{safeT("filter.builtIn", "Built-in")}</SelectItem>
              <SelectItem value="custom">{safeT("filter.custom", "Custom")}</SelectItem>
              {PRESET_CATEGORIES.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {safeTCategory(c.labelKey, c.id)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* --- Body ------------------------------------------------- */}
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
        <div className="space-y-2">
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
    </div>
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
  // Hydrate when the upstream list changes (rows added/removed). Adjusting
  // state during render based on a tracked previous prop is the React-
  // recommended pattern (no effect-setState cascades).
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
