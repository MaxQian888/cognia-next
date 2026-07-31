"use client"

/**
 * KeybindingSettings - Customizable keyboard shortcuts settings for Canvas
 */

import { useState, useCallback, useEffect } from "react"
import { useTranslations } from "next-intl"
import { Keyboard, RotateCcw, AlertTriangle, Download, Upload, Search } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from "@/components/ui/dialog"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
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
import { cn } from "@/lib/utils"
import { loggers } from "@cognia/logging"
import {
  useKeybindingStore,
  formatKeybinding,
  parseKeyEvent,
  DEFAULT_KEYBINDINGS,
} from "@/stores/canvas/keybinding-store"
import { KEYBINDING_CATEGORIES } from "@/lib/canvas/constants"

interface KeybindingSettingsProps {
  trigger?: React.ReactNode
}

export function KeybindingSettings({ trigger }: KeybindingSettingsProps) {
  const t = useTranslations("canvas")
  const [open, setOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState("")
  const [editingAction, setEditingAction] = useState<string | null>(null)
  const [recordingKey, setRecordingKey] = useState<string>("")
  const [showResetConfirm, setShowResetConfirm] = useState(false)

  const {
    bindings,
    conflicts,
    setKeybinding,
    resetKeybinding,
    resetAllBindings,
    exportBindings,
    importBindings,
    isModified,
    checkConflicts,
  } = useKeybindingStore()

  const handleStartEditing = useCallback(
    (action: string) => {
      setEditingAction(action)
      setRecordingKey(bindings[action] || "")
    },
    [bindings]
  )

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!editingAction) return

      e.preventDefault()
      e.stopPropagation()

      if (e.key === "Escape") {
        setEditingAction(null)
        setRecordingKey("")
        return
      }

      if (e.key === "Enter" && recordingKey) {
        setKeybinding(editingAction, recordingKey)
        setEditingAction(null)
        setRecordingKey("")
        return
      }

      const keyCombo = parseKeyEvent(e.nativeEvent)
      if (keyCombo && !["Control", "Alt", "Shift", "Meta"].includes(e.key)) {
        setRecordingKey(keyCombo)
      }
    },
    [editingAction, recordingKey, setKeybinding]
  )

  const handleExport = useCallback(() => {
    const json = exportBindings()
    const blob = new Blob([json], { type: "application/json" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = "canvas-keybindings.json"
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }, [exportBindings])

  const handleImport = useCallback(() => {
    const input = document.createElement("input")
    input.type = "file"
    input.accept = ".json"
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0]
      if (file) {
        const text = await file.text()
        const success = importBindings(text)
        if (!success) {
          loggers.ui.error("Failed to import keybindings")
        }
      }
    }
    input.click()
  }, [importBindings])

  const filteredCategories = Object.entries(KEYBINDING_CATEGORIES)
    .map(([category, actions]) => ({
      category,
      actions: actions.filter((action) => {
        if (!searchQuery) return true
        const query = searchQuery.toLowerCase()
        return (
          action.toLowerCase().includes(query) ||
          (bindings[action] || "").toLowerCase().includes(query)
        )
      }),
    }))
    .filter((cat) => cat.actions.length > 0)

  const hasConflicts = Object.keys(conflicts).length > 0

  // Check conflicts on mount and when bindings change
  useEffect(() => {
    checkConflicts()
  }, [bindings, checkConflicts])

  return (
    <>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          {trigger || (
            <Button variant="ghost" size="sm" className="gap-2">
              <Keyboard className="h-4 w-4" />
              <span className="hidden sm:inline">{t("keybindings")}</span>
            </Button>
          )}
        </DialogTrigger>
        <DialogContent className="w-[95vw] max-w-2xl max-h-[80vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Keyboard className="h-5 w-5" />
              {t("keyboardShortcuts")}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4 flex-1 overflow-hidden flex flex-col">
            {/* Search and Actions */}
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder={t("searchShortcuts")}
                  className="pl-9"
                />
              </div>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="outline" size="icon" onClick={handleExport}>
                    <Download className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t("exportKeybindings")}</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="outline" size="icon" onClick={handleImport}>
                    <Upload className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t("importKeybindings")}</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="outline" size="icon" onClick={() => setShowResetConfirm(true)}>
                    <RotateCcw className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t("resetAllKeybindings")}</TooltipContent>
              </Tooltip>
            </div>

            {/* Conflicts Warning */}
            {hasConflicts && (
              <div className="flex items-center gap-2 p-2 rounded-lg bg-warning/10 text-warning">
                <AlertTriangle className="h-4 w-4" />
                <span className="text-sm">{t("keybindingConflicts")}</span>
              </div>
            )}

            {/* Keybindings List */}
            <ScrollArea className="flex-1">
              <div className="space-y-4 pr-4">
                {filteredCategories.map(({ category, actions }) => (
                  <div key={category}>
                    <h4 className="text-sm font-medium text-muted-foreground mb-2 capitalize">
                      {t(`category.${category}` as Parameters<typeof t>[0])}
                    </h4>
                    <div className="space-y-1">
                      {actions.map((action) => (
                        <KeybindingRow
                          key={action}
                          action={action}
                          keybinding={bindings[action] || ""}
                          defaultKeybinding={DEFAULT_KEYBINDINGS[action]}
                          isEditing={editingAction === action}
                          recordingKey={editingAction === action ? recordingKey : undefined}
                          isModified={isModified(action)}
                          hasConflict={Object.values(conflicts).some((c) => c.includes(action))}
                          onStartEdit={() => handleStartEditing(action)}
                          onKeyDown={handleKeyDown}
                          onReset={() => resetKeybinding(action)}
                          onCancel={() => {
                            setEditingAction(null)
                            setRecordingKey("")
                          }}
                          t={t}
                        />
                      ))}
                    </div>
                    <Separator className="mt-4" />
                  </div>
                ))}
              </div>
            </ScrollArea>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              {t("close")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reset Confirmation */}
      <AlertDialog open={showResetConfirm} onOpenChange={setShowResetConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("resetAllKeybindings")}</AlertDialogTitle>
            <AlertDialogDescription>{t("resetKeybindingsConfirm")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                resetAllBindings()
                setShowResetConfirm(false)
              }}
            >
              {t("reset")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

interface KeybindingRowProps {
  action: string
  keybinding: string
  defaultKeybinding: string
  isEditing: boolean
  recordingKey?: string
  isModified: boolean
  hasConflict: boolean
  onStartEdit: () => void
  onKeyDown: (e: React.KeyboardEvent) => void
  onReset: () => void
  onCancel: () => void
  t: ReturnType<typeof useTranslations>
}

function KeybindingRow({
  action,
  keybinding,
  defaultKeybinding,
  isEditing,
  recordingKey,
  isModified,
  hasConflict,
  onStartEdit,
  onKeyDown,
  onReset,
  onCancel,
  t,
}: KeybindingRowProps) {
  const actionLabel = action.split(".").pop() || action

  return (
    <div
      className={cn(
        "flex items-center justify-between py-2 px-3 rounded-lg",
        isEditing && "bg-primary/10",
        hasConflict && !isEditing && "bg-warning/10"
      )}
    >
      <div className="flex items-center gap-2">
        <span className="text-sm">{t(`action.${actionLabel}` as Parameters<typeof t>[0])}</span>
        {isModified && (
          <Badge variant="outline" className="text-[10px]">
            {t("modified")}
          </Badge>
        )}
        {hasConflict && (
          <Tooltip>
            <TooltipTrigger>
              <AlertTriangle className="h-3.5 w-3.5 text-warning" />
            </TooltipTrigger>
            <TooltipContent>{t("conflictWarning")}</TooltipContent>
          </Tooltip>
        )}
      </div>
      <div className="flex items-center gap-2">
        {isEditing ? (
          <>
            <Input
              value={recordingKey || ""}
              placeholder={t("pressKeys")}
              className="w-32 h-8 text-center text-sm"
              onKeyDown={onKeyDown}
              autoFocus
              readOnly
            />
            <Button variant="ghost" size="sm" onClick={onCancel}>
              {t("cancel")}
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="outline"
              size="sm"
              className="h-8 min-w-24 font-mono text-xs"
              onClick={onStartEdit}
            >
              {keybinding ? formatKeybinding(keybinding) : t("notSet")}
            </Button>
            {isModified && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onReset}>
                    <RotateCcw className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {t("resetTo")} {formatKeybinding(defaultKeybinding)}
                </TooltipContent>
              </Tooltip>
            )}
          </>
        )}
      </div>
    </div>
  )
}

export default KeybindingSettings
