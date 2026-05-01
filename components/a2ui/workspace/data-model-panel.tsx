"use client"

/**
 * Data Model Panel
 * Tree view and editor for the A2UI surface data model
 */

import React, { useCallback, useState } from "react"
import { useTranslations } from "next-intl"
import { ChevronRight, ChevronDown, Database, Pencil, Check, X } from "lucide-react"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { useA2UIStore } from "@/stores/a2ui"
import { cn } from "@/lib/utils"
import { useWorkspaceContext } from "./a2ui-workspace-context"

interface DataNodeProps {
  path: string
  label: string
  value: unknown
  depth: number
  expandedPaths: Set<string>
  onToggle: (path: string) => void
  onEdit: (path: string, value: unknown) => void
}

function getTypeLabel(value: unknown): string {
  if (value === null) return "null"
  if (Array.isArray(value)) return `array[${value.length}]`
  return typeof value
}

function getTypeColor(value: unknown): string {
  if (value === null || value === undefined) return "text-muted-foreground"
  if (typeof value === "string") return "text-green-600 dark:text-green-400"
  if (typeof value === "number") return "text-blue-600 dark:text-blue-400"
  if (typeof value === "boolean") return "text-amber-600 dark:text-amber-400"
  return "text-muted-foreground"
}

function DataNode({ path, label, value, depth, expandedPaths, onToggle, onEdit }: DataNodeProps) {
  const [isEditing, setIsEditing] = useState(false)
  const [editValue, setEditValue] = useState("")

  const isObject = value !== null && typeof value === "object"
  const isExpanded = expandedPaths.has(path)
  const entries = isObject ? Object.entries(value as Record<string, unknown>) : []

  const handleStartEdit = useCallback(() => {
    if (isObject) return
    setEditValue(JSON.stringify(value))
    setIsEditing(true)
  }, [value, isObject])

  const handleCommitEdit = useCallback(() => {
    try {
      const parsed = JSON.parse(editValue)
      onEdit(path, parsed)
    } catch {
      // Try as raw string
      onEdit(path, editValue)
    }
    setIsEditing(false)
  }, [editValue, path, onEdit])

  const handleCancelEdit = useCallback(() => {
    setIsEditing(false)
  }, [])

  return (
    <div>
      <div
        className={cn(
          "flex items-center gap-1 px-2 py-0.5 text-xs hover:bg-accent/50 rounded-sm group",
          !isObject && "cursor-pointer"
        )}
        style={{ paddingLeft: `${8 + depth * 16}px` }}
        onDoubleClick={handleStartEdit}
      >
        {isObject ? (
          <button
            className="shrink-0 p-0.5 hover:bg-accent/80 rounded-xs"
            onClick={() => onToggle(path)}
          >
            {isExpanded ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
          </button>
        ) : (
          <span className="w-4 shrink-0" />
        )}
        <span className="font-mono text-purple-600 dark:text-purple-400 shrink-0">{label}</span>
        <span className="text-muted-foreground/40 shrink-0">:</span>

        {isEditing ? (
          <div className="flex items-center gap-1 flex-1 min-w-0">
            <Input
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleCommitEdit()
                if (e.key === "Escape") handleCancelEdit()
              }}
              className="h-5 text-xs py-0 px-1 flex-1"
              autoFocus
            />
            <Button
              variant="ghost"
              size="icon"
              className="h-5 w-5 shrink-0"
              onClick={handleCommitEdit}
            >
              <Check className="h-3 w-3 text-green-500" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-5 w-5 shrink-0"
              onClick={handleCancelEdit}
            >
              <X className="h-3 w-3 text-destructive" />
            </Button>
          </div>
        ) : (
          <>
            {isObject ? (
              <Badge variant="outline" className="text-[10px] h-4 px-1 shrink-0">
                {getTypeLabel(value)}
              </Badge>
            ) : (
              <span className={cn("truncate", getTypeColor(value))}>
                {value === null ? "null" : typeof value === "string" ? `"${value}"` : String(value)}
              </span>
            )}
            {!isObject && (
              <button
                className="opacity-0 group-hover:opacity-100 shrink-0 p-0.5 hover:bg-accent/80 rounded-xs transition-opacity"
                onClick={handleStartEdit}
              >
                <Pencil className="h-3 w-3 text-muted-foreground" />
              </button>
            )}
          </>
        )}
      </div>

      {isObject &&
        isExpanded &&
        entries.map(([key, val]) => (
          <DataNode
            key={`${path}/${key}`}
            path={`${path}/${key}`}
            label={key}
            value={val}
            depth={depth + 1}
            expandedPaths={expandedPaths}
            onToggle={onToggle}
            onEdit={onEdit}
          />
        ))}
    </div>
  )
}

export function DataModelPanel() {
  const t = useTranslations("a2ui")
  const { surfaceId } = useWorkspaceContext()
  const surface = useA2UIStore((state) => state.surfaces[surfaceId])
  const setDataValue = useA2UIStore((state) => state.setDataValue)
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set(["/"]))

  const handleToggle = useCallback((path: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  const handleEdit = useCallback(
    (path: string, value: unknown) => {
      if (!surfaceId) return
      setDataValue(surfaceId, path, value)
    },
    [surfaceId, setDataValue]
  )

  if (!surface) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm p-4">
        No surface loaded
      </div>
    )
  }

  const dataModel = surface.dataModel || {}
  const entries = Object.entries(dataModel)

  return (
    <div className="flex flex-col h-full">
      <div className="px-3 py-2 border-b flex items-center gap-2">
        <Database className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
          {t("dataModel")}
        </span>
        <Badge variant="outline" className="text-[10px] h-5 ml-auto">
          {entries.length} keys
        </Badge>
      </div>
      <ScrollArea className="flex-1">
        <div className="py-1">
          {entries.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-4">Empty data model</p>
          ) : (
            entries.map(([key, val]) => (
              <DataNode
                key={`/${key}`}
                path={`/${key}`}
                label={key}
                value={val}
                depth={0}
                expandedPaths={expandedPaths}
                onToggle={handleToggle}
                onEdit={handleEdit}
              />
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  )
}
