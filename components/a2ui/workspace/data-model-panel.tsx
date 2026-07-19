"use client"

/** Tree and structure editor for an A2UI surface data model. */

import React, { useCallback, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import {
  Braces,
  Check,
  ChevronDown,
  ChevronRight,
  Database,
  Pencil,
  Plus,
  Trash2,
  X,
} from "lucide-react"
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
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Textarea } from "@/components/ui/textarea"
import {
  createJsonPointer,
  deleteValueByPath,
  isA2UIDataModel,
  isSafeDataModelKey,
  parseJsonPointer,
  setValueByPath,
} from "@/lib/a2ui/data-model"
import { cn } from "@/lib/utils"
import { useA2UIStore } from "@/stores/a2ui"
import { useWorkspaceContext } from "./a2ui-workspace-context"

interface AddTarget {
  path: string
  value: Record<string, unknown> | unknown[]
}

interface DeleteTarget {
  path: string
  label: string
}

interface DataNodeProps {
  path: string
  label: string
  value: unknown
  depth: number
  expandedPaths: Set<string>
  onToggle: (path: string) => void
  onEdit: (path: string, value: unknown) => boolean
  onRequestAdd: (target: AddTarget) => void
  onRequestDelete: (target: DeleteTarget) => void
}

function isContainer(value: unknown): value is Record<string, unknown> | unknown[] {
  return typeof value === "object" && value !== null
}

function appendJsonPointer(path: string, segment: string): string {
  const segments = path === "/" ? [] : parseJsonPointer(path)
  return createJsonPointer([...segments, segment])
}

function getTypeColor(value: unknown): string {
  if (value === null || value === undefined) return "text-muted-foreground"
  if (typeof value === "string") return "text-green-600 dark:text-green-400"
  if (typeof value === "number") return "text-blue-600 dark:text-blue-400"
  if (typeof value === "boolean") return "text-amber-600 dark:text-amber-400"
  return "text-muted-foreground"
}

function DataNode({
  path,
  label,
  value,
  depth,
  expandedPaths,
  onToggle,
  onEdit,
  onRequestAdd,
  onRequestDelete,
}: DataNodeProps) {
  const t = useTranslations("a2ui")
  const [isEditing, setIsEditing] = useState(false)
  const [editValue, setEditValue] = useState("")
  const [invalid, setInvalid] = useState(false)

  const container = isContainer(value)
  const isExpanded = expandedPaths.has(path)
  const entries = container ? Object.entries(value) : []

  const handleStartEdit = useCallback(() => {
    setEditValue(JSON.stringify(value, null, container ? 2 : 0) ?? "null")
    setInvalid(false)
    setIsEditing(true)
  }, [container, value])

  const handleCommitEdit = useCallback(() => {
    let parsed: unknown
    try {
      parsed = JSON.parse(editValue) as unknown
    } catch {
      if (container) {
        setInvalid(true)
        return
      }
      parsed = editValue
    }

    if (!onEdit(path, parsed)) {
      setInvalid(true)
      return
    }
    setIsEditing(false)
  }, [container, editValue, onEdit, path])

  const handleCancelEdit = useCallback(() => {
    setInvalid(false)
    setIsEditing(false)
  }, [])

  return (
    <div>
      <div
        className="group flex items-start gap-1 rounded-sm px-2 py-0.5 text-xs hover:bg-accent/50"
        style={{ paddingLeft: `${8 + depth * 16}px` }}
        onDoubleClick={handleStartEdit}
      >
        {container ? (
          <button
            type="button"
            aria-label={t(isExpanded ? "collapseDataPath" : "expandDataPath", { path })}
            className="shrink-0 rounded-xs p-0.5 hover:bg-accent/80"
            onClick={() => onToggle(path)}
          >
            {isExpanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
          </button>
        ) : (
          <span className="w-4 shrink-0" />
        )}
        <span className="shrink-0 font-mono text-purple-600 dark:text-purple-400">{label}</span>
        <span className="shrink-0 text-muted-foreground/40">:</span>

        {isEditing ? (
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex items-start gap-1">
              {container ? (
                <Textarea
                  aria-label={t("editDataValue", { path })}
                  value={editValue}
                  onChange={(event) => {
                    setEditValue(event.target.value)
                    setInvalid(false)
                  }}
                  className="min-h-24 flex-1 font-mono text-xs"
                  autoFocus
                  spellCheck={false}
                />
              ) : (
                <Input
                  aria-label={t("editDataValue", { path })}
                  value={editValue}
                  onChange={(event) => {
                    setEditValue(event.target.value)
                    setInvalid(false)
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") handleCommitEdit()
                    if (event.key === "Escape") handleCancelEdit()
                  }}
                  className="h-6 flex-1 px-1 py-0 font-mono text-xs"
                  autoFocus
                />
              )}
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-6 shrink-0"
                aria-label={t("applyDataValue", { path })}
                onClick={handleCommitEdit}
              >
                <Check className="size-3 text-green-500" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-6 shrink-0"
                aria-label={t("cancelDataValueEdit", { path })}
                onClick={handleCancelEdit}
              >
                <X className="size-3 text-destructive" />
              </Button>
            </div>
            {invalid && (
              <p role="alert" className="text-xs text-destructive">
                {t("invalidDataValue")}
              </p>
            )}
          </div>
        ) : (
          <>
            {container ? (
              <Badge variant="outline" className="h-4 shrink-0 px-1 text-[10px]">
                {Array.isArray(value)
                  ? t("dataArrayType", { count: value.length })
                  : t("dataObjectType", { count: entries.length })}
              </Badge>
            ) : (
              <span className={cn("min-w-0 flex-1 truncate", getTypeColor(value))}>
                {value === null ? "null" : typeof value === "string" ? `"${value}"` : String(value)}
              </span>
            )}
            <div className="ml-auto flex shrink-0 items-center opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-5"
                aria-label={t("editDataValue", { path })}
                onClick={handleStartEdit}
              >
                <Pencil className="size-3 text-muted-foreground" />
              </Button>
              {container && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-5"
                  aria-label={t("addDataEntryAt", { path })}
                  onClick={() => onRequestAdd({ path, value })}
                >
                  <Plus className="size-3 text-muted-foreground" />
                </Button>
              )}
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-5"
                aria-label={t("deleteDataValueAt", { path })}
                onClick={() => onRequestDelete({ path, label })}
              >
                <Trash2 className="size-3 text-destructive" />
              </Button>
            </div>
          </>
        )}
      </div>

      {container &&
        isExpanded &&
        entries.map(([key, childValue]) => {
          const childPath = appendJsonPointer(path, key)
          return (
            <DataNode
              key={childPath}
              path={childPath}
              label={key}
              value={childValue}
              depth={depth + 1}
              expandedPaths={expandedPaths}
              onToggle={onToggle}
              onEdit={onEdit}
              onRequestAdd={onRequestAdd}
              onRequestDelete={onRequestDelete}
            />
          )
        })}
    </div>
  )
}

interface AddDataEntryDialogProps {
  target: AddTarget
  onClose: () => void
  onAdd: (target: AddTarget, key: string, value: unknown) => boolean
}

function AddDataEntryDialog({ target, onClose, onAdd }: AddDataEntryDialogProps) {
  const t = useTranslations("a2ui")
  const arrayTarget = Array.isArray(target.value)
  const [key, setKey] = useState("")
  const [valueDraft, setValueDraft] = useState("null")
  const [invalid, setInvalid] = useState(false)

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{arrayTarget ? t("appendDataEntry") : t("addDataEntry")}</DialogTitle>
          <DialogDescription>
            {t("addDataEntryDescription", { path: target.path })}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {!arrayTarget && (
            <div className="space-y-2">
              <Label htmlFor="data-entry-key">{t("dataEntryKey")}</Label>
              <Input
                id="data-entry-key"
                value={key}
                onChange={(event) => {
                  setKey(event.target.value)
                  setInvalid(false)
                }}
                autoFocus
              />
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="data-entry-value">{t("dataEntryValueJson")}</Label>
            <Textarea
              id="data-entry-value"
              value={valueDraft}
              onChange={(event) => {
                setValueDraft(event.target.value)
                setInvalid(false)
              }}
              className="min-h-28 font-mono text-xs"
              spellCheck={false}
            />
          </div>
          {invalid && (
            <p role="alert" className="text-sm text-destructive">
              {t("invalidDataEntry")}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button
            type="button"
            aria-label={arrayTarget ? t("appendDataEntry") : t("addDataEntry")}
            onClick={() => {
              try {
                const value = JSON.parse(valueDraft) as unknown
                if ((!arrayTarget && !isSafeDataModelKey(key)) || !onAdd(target, key, value)) {
                  setInvalid(true)
                  return
                }
                onClose()
              } catch {
                setInvalid(true)
              }
            }}
          >
            {arrayTarget ? t("append") : t("add")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

interface DataModelJsonDialogProps {
  dataModel: Record<string, unknown>
  onClose: () => void
  onApply: (dataModel: Record<string, unknown>) => boolean
}

function DataModelJsonDialog({ dataModel, onClose, onApply }: DataModelJsonDialogProps) {
  const t = useTranslations("a2ui")
  const serialized = useMemo(() => JSON.stringify(dataModel, null, 2), [dataModel])
  const [draft, setDraft] = useState(serialized)
  const [invalid, setInvalid] = useState(false)

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("editDataModelJson")}</DialogTitle>
          <DialogDescription>{t("editDataModelJsonDescription")}</DialogDescription>
        </DialogHeader>
        <Label htmlFor="complete-data-model-json" className="sr-only">
          {t("completeDataModelJson")}
        </Label>
        <Textarea
          id="complete-data-model-json"
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value)
            setInvalid(false)
          }}
          className="min-h-80 font-mono text-xs"
          spellCheck={false}
        />
        {invalid && (
          <p role="alert" className="text-sm text-destructive">
            {t("invalidDataModelJson")}
          </p>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setDraft(serialized)}>
            {t("reset")}
          </Button>
          <Button
            type="button"
            aria-label={t("applyDataModelJson")}
            onClick={() => {
              try {
                const parsed = JSON.parse(draft) as unknown
                if (!isA2UIDataModel(parsed) || !onApply(parsed)) {
                  setInvalid(true)
                  return
                }
                onClose()
              } catch {
                setInvalid(true)
              }
            }}
          >
            {t("apply")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function DataModelPanel() {
  const t = useTranslations("a2ui")
  const { surfaceId } = useWorkspaceContext()
  const surface = useA2UIStore((state) => state.surfaces[surfaceId])
  const updateDataModel = useA2UIStore((state) => state.updateDataModel)
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set())
  const [addTarget, setAddTarget] = useState<AddTarget | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null)
  const [showJsonEditor, setShowJsonEditor] = useState(false)

  const dataModel = useMemo(() => surface?.dataModel ?? {}, [surface?.dataModel])
  const entries = useMemo(() => Object.entries(dataModel), [dataModel])

  const commitDataModel = useCallback(
    (nextDataModel: Record<string, unknown>) => {
      if (!surface || !isA2UIDataModel(nextDataModel)) return false
      updateDataModel(surfaceId, nextDataModel, false)
      return true
    },
    [surface, surfaceId, updateDataModel]
  )

  const handleToggle = useCallback((path: string) => {
    setExpandedPaths((previous) => {
      const next = new Set(previous)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  const handleEdit = useCallback(
    (path: string, value: unknown) => {
      const next = setValueByPath(dataModel, path, value)
      return !Object.is(next, dataModel) && commitDataModel(next)
    },
    [commitDataModel, dataModel]
  )

  const handleAdd = useCallback(
    (target: AddTarget, key: string, value: unknown) => {
      let segment: string
      if (Array.isArray(target.value)) {
        segment = String(target.value.length)
      } else {
        if (!isSafeDataModelKey(key) || Object.prototype.hasOwnProperty.call(target.value, key)) {
          return false
        }
        segment = key
      }
      const next = setValueByPath(dataModel, appendJsonPointer(target.path, segment), value)
      return !Object.is(next, dataModel) && commitDataModel(next)
    },
    [commitDataModel, dataModel]
  )

  const handleDelete = useCallback(() => {
    if (!deleteTarget) return
    const next = deleteValueByPath(dataModel, deleteTarget.path)
    if (!Object.is(next, dataModel)) commitDataModel(next)
    setDeleteTarget(null)
  }, [commitDataModel, dataModel, deleteTarget])

  if (!surface) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-sm text-muted-foreground">
        {t("noSurfaceLoaded")}
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <Database className="size-3.5 text-muted-foreground" />
        <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          {t("dataModel")}
        </span>
        <Badge variant="outline" className="ml-auto h-5 text-[10px]">
          {t("dataModelKeyCount", { count: entries.length })}
        </Badge>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label={t("addRootDataEntry")}
          onClick={() => setAddTarget({ path: "/", value: dataModel })}
        >
          <Plus className="size-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label={t("editCompleteDataModelJson")}
          onClick={() => setShowJsonEditor(true)}
        >
          <Braces className="size-3.5" />
        </Button>
      </div>
      <ScrollArea className="flex-1">
        <div className="py-1">
          {entries.length === 0 ? (
            <p className="py-4 text-center text-xs text-muted-foreground">{t("emptyDataModel")}</p>
          ) : (
            entries.map(([key, value]) => {
              const path = createJsonPointer([key])
              return (
                <DataNode
                  key={path}
                  path={path}
                  label={key}
                  value={value}
                  depth={0}
                  expandedPaths={expandedPaths}
                  onToggle={handleToggle}
                  onEdit={handleEdit}
                  onRequestAdd={setAddTarget}
                  onRequestDelete={setDeleteTarget}
                />
              )
            })
          )}
        </div>
      </ScrollArea>

      {addTarget && (
        <AddDataEntryDialog
          target={addTarget}
          onClose={() => setAddTarget(null)}
          onAdd={handleAdd}
        />
      )}
      {showJsonEditor && (
        <DataModelJsonDialog
          dataModel={dataModel}
          onClose={() => setShowJsonEditor(false)}
          onApply={commitDataModel}
        />
      )}
      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("deleteDataValueTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("deleteDataValueDescription", {
                path: deleteTarget?.path ?? "",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete}>{t("delete")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
