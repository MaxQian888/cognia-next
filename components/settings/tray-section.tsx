"use client"

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import {
  ArrowDownIcon,
  ArrowUpIcon,
  EyeIcon,
  EyeOffIcon,
  ListPlusIcon,
  PencilIcon,
  RotateCcwIcon,
  TrashIcon,
} from "lucide-react"
import { isTauri } from "@/lib/tauri"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useTrayStore } from "@/lib/tray/store"
import { listSlashCommands } from "@/lib/slash-commands/registry"
import { listTrayItems } from "@/lib/tray/registry"
import type { TrayMenuItem, TrayActionPayload } from "@/lib/tray/types"

type Direction = -1 | 1

function reorder<T>(items: T[], index: number, direction: Direction): T[] {
  const target = index + direction
  if (target < 0 || target >= items.length) return items
  const next = items.slice()
  const tmp = next[index]
  next[index] = next[target]
  next[target] = tmp
  return next
}

interface PickerEntry {
  id: string
  label: string
  hint: string
  payload: TrayActionPayload
}

function collectPickerEntries(): PickerEntry[] {
  const out: PickerEntry[] = []
  for (const cmd of listSlashCommands()) {
    out.push({
      id: `slash:${cmd.id}`,
      label: `/${cmd.name}`,
      hint: cmd.description ?? cmd.category ?? cmd.source ?? "",
      payload: { kind: "slash", command: cmd.name },
    })
  }
  for (const item of listTrayItems()) {
    out.push({
      id: `tray-item:${item.id}`,
      label: item.label,
      hint: item.category ?? item.pluginId,
      payload: { kind: "command", commandId: item.id },
    })
  }
  return out.sort((a, b) => a.label.localeCompare(b.label))
}

export function TraySection() {
  const t = useTranslations("settings.tray")
  const items = useTrayStore((s) => s.items)
  const setItems = useTrayStore((s) => s.setItems)
  const reset = useTrayStore((s) => s.reset)
  const [editing, setEditing] = useState<string | null>(null)
  const [draftLabel, setDraftLabel] = useState("")

  const pickerEntries = useMemo(() => collectPickerEntries(), [])

  if (!isTauri()) {
    return (
      <div className="text-sm text-muted-foreground">
        {t("desktopOnly", {
          fallback: "The system tray is only available in the desktop build.",
        })}
      </div>
    )
  }

  function startRename(item: TrayMenuItem) {
    if (item.kind === "separator") return
    setEditing(item.id)
    setDraftLabel(item.label)
  }

  function commitRename() {
    if (!editing) return
    setItems(
      items.map((it) =>
        "id" in it && it.id === editing && it.kind !== "separator"
          ? { ...it, label: draftLabel }
          : it
      )
    )
    setEditing(null)
    setDraftLabel("")
  }

  function moveItem(idx: number, dir: Direction) {
    setItems(reorder(items, idx, dir))
  }

  function removeItem(id: string) {
    setItems(items.filter((it) => !("id" in it) || it.id !== id))
  }

  function toggleHidden(id: string) {
    setItems(
      items.map((it) => {
        if (!("id" in it) || it.id !== id) return it
        if (it.kind === "separator") return it
        return { ...it, hidden: !it.hidden }
      })
    )
  }

  function addPickerEntry(entry: PickerEntry) {
    // eslint-disable-next-line react-hooks/purity -- this function is an event handler invoked from a click, never during render; Date.now() is safe here.
    const id = `user:${entry.id}:${Date.now().toString(36)}`
    const next: TrayMenuItem = {
      kind: "action",
      id,
      label: entry.label,
      payload: entry.payload,
    }
    // Insert just above the separator that precedes the Quit item; if there's
    // no such anchor, append.
    const lastSepIdx = items
      .map((it, i) => ({ it, i }))
      .reverse()
      .find((p) => p.it.kind === "separator")
    const insertAt = lastSepIdx ? lastSepIdx.i : items.length
    const copy = items.slice()
    copy.splice(insertAt, 0, next)
    setItems(copy)
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold">{t("title", { fallback: "Tray" })}</h2>
          <p className="text-sm text-muted-foreground">
            {t("description", {
              fallback: "Customise the items shown in the system tray menu.",
            })}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Dialog>
            <DialogTrigger asChild>
              <Button variant="secondary" size="sm">
                <ListPlusIcon className="mr-1 size-4" />
                {t("addItem", { fallback: "Add item" })}
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-lg">
              <DialogHeader>
                <DialogTitle>{t("pickCommand", { fallback: "Pick a command" })}</DialogTitle>
                <DialogDescription>
                  {t("pickHint", {
                    fallback: "Choose a slash command or plugin command to pin to the tray menu.",
                  })}
                </DialogDescription>
              </DialogHeader>
              <ScrollArea className="h-80">
                <ul className="divide-y">
                  {pickerEntries.map((entry) => (
                    <li
                      key={entry.id}
                      className="flex items-center justify-between gap-2 px-2 py-2"
                    >
                      <div className="min-w-0">
                        <div className="truncate font-mono text-sm">{entry.label}</div>
                        {entry.hint && (
                          <div className="truncate text-xs text-muted-foreground">{entry.hint}</div>
                        )}
                      </div>
                      <Button size="sm" variant="outline" onClick={() => addPickerEntry(entry)}>
                        {t("pin", { fallback: "Pin" })}
                      </Button>
                    </li>
                  ))}
                  {pickerEntries.length === 0 && (
                    <li className="px-2 py-4 text-sm text-muted-foreground">
                      {t("emptyPicker", {
                        fallback: "No commands available — install plugins or start a chat.",
                      })}
                    </li>
                  )}
                </ul>
              </ScrollArea>
            </DialogContent>
          </Dialog>
          <Button variant="ghost" size="sm" onClick={reset}>
            <RotateCcwIcon className="mr-1 size-4" />
            {t("reset", { fallback: "Reset" })}
          </Button>
        </div>
      </div>

      <ul className="divide-y rounded-md border bg-card">
        {items.map((item, idx) => {
          const isSep = item.kind === "separator"
          const id = "id" in item ? item.id : `sep-${idx}`
          return (
            <li key={id} className="flex items-center justify-between gap-3 px-3 py-2">
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <span className="text-xs font-mono text-muted-foreground">
                  {String(idx + 1).padStart(2, "0")}
                </span>
                {editing === id && !isSep ? (
                  <Input
                    value={draftLabel}
                    onChange={(e) => setDraftLabel(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitRename()
                      if (e.key === "Escape") setEditing(null)
                    }}
                    className="h-7"
                    autoFocus
                  />
                ) : (
                  <Label className="truncate">
                    {isSep ? `— ${t("separator", { fallback: "separator" })} —` : item.label}
                  </Label>
                )}
              </div>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => moveItem(idx, -1)}
                  disabled={idx === 0}
                  aria-label={t("moveUp", { fallback: "Move up" })}
                >
                  <ArrowUpIcon className="size-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => moveItem(idx, 1)}
                  disabled={idx === items.length - 1}
                  aria-label={t("moveDown", { fallback: "Move down" })}
                >
                  <ArrowDownIcon className="size-4" />
                </Button>
                {!isSep && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => startRename(item)}
                    aria-label={t("rename", { fallback: "Rename" })}
                  >
                    <PencilIcon className="size-4" />
                  </Button>
                )}
                {!isSep && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => toggleHidden(id)}
                    aria-label={
                      "hidden" in item && item.hidden
                        ? t("show", { fallback: "Show" })
                        : t("hide", { fallback: "Hide" })
                    }
                  >
                    {"hidden" in item && item.hidden ? (
                      <EyeOffIcon className="size-4 opacity-50" />
                    ) : (
                      <EyeIcon className="size-4" />
                    )}
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => removeItem(id)}
                  aria-label={t("remove", { fallback: "Remove" })}
                >
                  <TrashIcon className="size-4" />
                </Button>
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
