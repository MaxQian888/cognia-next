"use client"

/**
 * Canvas Document Rail — replaces ChannelList when the user is in the
 * Canvas guild. Shows the document list with time-based grouping, search,
 * language filter, pinning, context menus, and a "New document" button.
 * Style mirrors `components/desktop/channel-list.tsx`.
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import {
  Plus,
  Search,
  FileCode,
  FileText,
  X,
  Pin,
  PinOff,
  ArrowUpDown,
  ChevronRight,
  Download,
  Copy,
  Trash2,
  Edit2,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { useCanvasLayoutStore } from "@/stores/canvas/canvas-layout-store"
import type { CanvasDocument } from "@/types/artifact/artifact"
import { LANGUAGE_OPTIONS } from "@/lib/canvas/constants"
import { RenameDialog } from "./rename-dialog"

type SortField = "updatedAt" | "title" | "language"
type SortOrder = "asc" | "desc"

function groupByTime(
  docs: CanvasDocument[],
  pinned: Set<string>,
  labels: {
    pinned: string
    today: string
    yesterday: string
    thisWeek: string
    older: string
  }
) {
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const yesterday = new Date(today.getTime() - 86400000)
  const weekStart = new Date(today.getTime() - today.getDay() * 86400000)

  const groups: { key: string; label: string; docs: CanvasDocument[] }[] = [
    { key: "pinned", label: labels.pinned, docs: [] },
    { key: "today", label: labels.today, docs: [] },
    { key: "yesterday", label: labels.yesterday, docs: [] },
    { key: "thisWeek", label: labels.thisWeek, docs: [] },
    { key: "older", label: labels.older, docs: [] },
  ]

  for (const doc of docs) {
    if (pinned.has(doc.id)) {
      groups[0]!.docs.push(doc)
      continue
    }
    const d = doc.updatedAt
    if (d >= today) groups[1]!.docs.push(doc)
    else if (d >= yesterday) groups[2]!.docs.push(doc)
    else if (d >= weekStart) groups[3]!.docs.push(doc)
    else groups[4]!.docs.push(doc)
  }

  return groups.filter((g) => g.docs.length > 0)
}

export function CanvasDocumentRail() {
  const t = useTranslations("canvas")
  const canvasDocuments = useArtifactStore((s) => s.canvasDocuments)
  const documents = useMemo(
    () => Object.values(canvasDocuments) as CanvasDocument[],
    [canvasDocuments]
  )
  const activeId = useArtifactStore((s) => s.activeCanvasId)
  const setActive = useArtifactStore((s) => s.setActiveCanvas)
  const create = useArtifactStore((s) => s.createCanvasDocument)
  const updateDoc = useArtifactStore((s) => s.updateCanvasDocument)
  const remove = useArtifactStore((s) => s.deleteCanvasDocument)

  const pinnedDocIds = useCanvasLayoutStore((s) => s.pinnedDocIds)
  const pinDocument = useCanvasLayoutStore((s) => s.pinDocument)
  const unpinDocument = useCanvasLayoutStore((s) => s.unpinDocument)

  const [query, setQuery] = useState("")
  const [langFilter, setLangFilter] = useState<string>("all")
  const [sortField, setSortField] = useState<SortField>("updatedAt")
  const [sortOrder, setSortOrder] = useState<SortOrder>("desc")
  const [renameDialogOpen, setRenameDialogOpen] = useState(false)
  const [renameDocId, setRenameDocId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState("")

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return documents
      .filter((d) => (langFilter === "all" ? true : d.language === langFilter))
      .filter((d) =>
        q ? d.title.toLowerCase().includes(q) || d.content.toLowerCase().includes(q) : true
      )
      .sort((a, b) => {
        let cmp = 0
        if (sortField === "updatedAt") cmp = a.updatedAt.getTime() - b.updatedAt.getTime()
        else if (sortField === "title") cmp = a.title.localeCompare(b.title)
        else cmp = a.language.localeCompare(b.language)
        return sortOrder === "desc" ? -cmp : cmp
      })
  }, [documents, query, langFilter, sortField, sortOrder])

  const grouped = useMemo(
    () =>
      groupByTime(filtered, pinnedDocIds, {
        pinned: t("pinned", { default: "Pinned" }),
        today: t("today", { default: "Today" }),
        yesterday: t("yesterday", { default: "Yesterday" }),
        thisWeek: t("thisWeek", { default: "This Week" }),
        older: t("older", { default: "Older" }),
      }),
    [filtered, pinnedDocIds, t]
  )

  const handleStartRename = (doc: CanvasDocument) => {
    setRenameDocId(doc.id)
    setRenameValue(doc.title)
    setRenameDialogOpen(true)
  }

  const handleConfirmRename = (newTitle: string) => {
    if (renameDocId) updateDoc(renameDocId, { title: newTitle, updatedAt: new Date() })
    setRenameDialogOpen(false)
    setRenameDocId(null)
    setRenameValue("")
  }

  const handleExport = (doc: CanvasDocument) => {
    const blob = new Blob([doc.content], { type: "text/markdown" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `${doc.title || "untitled"}.md`
    document.body.append(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }

  const onCreateNew = () => {
    const id = create({
      title: t("untitledDefault"),
      content: "",
      language: "markdown",
      type: "text",
    })
    setActive(id)
  }

  return (
    <aside className="flex h-full w-full min-w-0 flex-col overflow-hidden border-r bg-muted/30">
      <header className="flex items-center justify-between gap-2 px-3 py-2">
        <h2 className="text-sm font-semibold">{t("title", { default: "Canvas" })}</h2>
        <Tooltip delayDuration={300}>
          <TooltipTrigger asChild>
            <Button size="icon" variant="ghost" className="size-7" onClick={onCreateNew}>
              <Plus className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {t("newDocument", { default: "New document" })}
          </TooltipContent>
        </Tooltip>
      </header>
      <Separator />
      <div className="space-y-2 px-2 py-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("search", { default: "Search documents…" })}
            className="h-8 pl-7 text-xs"
          />
        </div>
        <div className="flex items-center justify-between">
          <div className="flex flex-wrap gap-1">
            <FilterChip
              active={langFilter === "all"}
              label={t("languageAny", { default: "Any" })}
              onClick={() => setLangFilter("all")}
            />
            {LANGUAGE_OPTIONS.slice(0, 5).map((lang) => (
              <FilterChip
                key={lang.value}
                active={langFilter === lang.value}
                label={lang.label}
                onClick={() => setLangFilter(lang.value)}
              />
            ))}
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-6 shrink-0"
                aria-label={t("sort", { default: "Sort" })}
              >
                <ArrowUpDown className="size-3 text-muted-foreground" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-32">
              <DropdownMenuItem
                onClick={() => {
                  setSortField("updatedAt")
                  setSortOrder("desc")
                }}
              >
                {t("sortByUpdated", { default: "Updated" })}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => {
                  setSortField("title")
                  setSortOrder("asc")
                }}
              >
                {t("sortByName", { default: "Name" })}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => {
                  setSortField("language")
                  setSortOrder("asc")
                }}
              >
                {t("sortByLanguage", { default: "Language" })}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      <Separator />
      <ScrollArea className="flex-1">
        {grouped.length === 0 ? (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">
            {t("noDocuments", { default: "No documents yet." })}
          </p>
        ) : (
          <div className="flex flex-col gap-0.5 p-1">
            {grouped.map((group) => (
              <Collapsible
                key={group.key}
                defaultOpen={group.key === "pinned" || group.key === "today"}
              >
                <CollapsibleTrigger className="flex w-full items-center gap-1 px-2 py-1 text-[10px] font-medium text-muted-foreground hover:text-foreground transition-colors group/collapse rounded-sm">
                  <ChevronRight className="size-3 transition-transform duration-200 [&[data-state=open]]:rotate-90" />
                  {group.label}
                  <span className="ml-auto tabular-nums text-[9px] opacity-60">
                    {group.docs.length}
                  </span>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <ul className="flex flex-col gap-0.5 pt-0.5">
                    {group.docs.map((doc) => {
                      const isActive = doc.id === activeId
                      const isPinned = pinnedDocIds.has(doc.id)
                      const Icon = doc.type === "code" ? FileCode : FileText
                      return (
                        <li key={doc.id}>
                          <ContextMenu>
                            <ContextMenuTrigger asChild>
                              <button
                                type="button"
                                onClick={() => setActive(doc.id)}
                                className={cn(
                                  "group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition",
                                  isActive
                                    ? "bg-primary/10 font-medium text-foreground"
                                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
                                )}
                              >
                                {isPinned && <Pin className="size-3 shrink-0 text-amber-500" />}
                                <Icon className="size-3.5 shrink-0" />
                                <span className="flex-1 truncate">
                                  {doc.title || t("untitledDefault")}
                                </span>
                                <Badge variant="outline" className="px-1 text-[10px] shrink-0">
                                  {doc.language}
                                </Badge>
                                <Tooltip delayDuration={300}>
                                  <TooltipTrigger asChild>
                                    <span
                                      role="button"
                                      tabIndex={0}
                                      onClick={(ev) => {
                                        ev.stopPropagation()
                                        if (activeId === doc.id) setActive(null)
                                        remove(doc.id)
                                      }}
                                      className="opacity-0 transition group-hover:opacity-70 hover:opacity-100"
                                      aria-label="Delete"
                                    >
                                      <X className="size-3" />
                                    </span>
                                  </TooltipTrigger>
                                  <TooltipContent side="right">
                                    {t("delete", { default: "Delete" })}
                                  </TooltipContent>
                                </Tooltip>
                              </button>
                            </ContextMenuTrigger>
                            <ContextMenuContent className="w-40">
                              <ContextMenuItem onClick={() => handleStartRename(doc)}>
                                <Edit2 className="mr-2 size-3.5" />
                                {t("rename")}
                              </ContextMenuItem>
                              <ContextMenuItem
                                onClick={() => {
                                  const dupId = create({
                                    title: `${doc.title} ${t("copySuffix")}`,
                                    content: doc.content,
                                    language: doc.language,
                                    type: doc.type,
                                  })
                                  setActive(dupId)
                                }}
                              >
                                <Copy className="mr-2 size-3.5" />
                                {t("duplicate")}
                              </ContextMenuItem>
                              <ContextMenuItem onClick={() => handleExport(doc)}>
                                <Download className="mr-2 size-3.5" />
                                {t("export", { default: "Export" })}
                              </ContextMenuItem>
                              <ContextMenuSeparator />
                              <ContextMenuItem
                                onClick={() => {
                                  isPinned ? unpinDocument(doc.id) : pinDocument(doc.id)
                                }}
                              >
                                {isPinned ? (
                                  <>
                                    <PinOff className="mr-2 size-3.5" />
                                    {t("unpin", { default: "Unpin" })}
                                  </>
                                ) : (
                                  <>
                                    <Pin className="mr-2 size-3.5" />
                                    {t("pin", { default: "Pin" })}
                                  </>
                                )}
                              </ContextMenuItem>
                              <ContextMenuSeparator />
                              <ContextMenuItem
                                onClick={() => {
                                  remove(doc.id)
                                  if (activeId === doc.id) setActive(null)
                                }}
                                className="text-destructive focus:text-destructive"
                              >
                                <Trash2 className="mr-2 size-3.5" />
                                {t("delete")}
                              </ContextMenuItem>
                            </ContextMenuContent>
                          </ContextMenu>
                        </li>
                      )
                    })}
                  </ul>
                </CollapsibleContent>
              </Collapsible>
            ))}
          </div>
        )}
      </ScrollArea>
      <RenameDialog
        open={renameDialogOpen}
        onOpenChange={setRenameDialogOpen}
        currentTitle={renameValue}
        onRename={handleConfirmRename}
      />
    </aside>
  )
}

interface FilterChipProps {
  active: boolean
  label: string
  onClick: () => void
}

function FilterChip({ active, label, onClick }: FilterChipProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full border px-2 py-0.5 text-[10px] transition",
        active
          ? "border-primary bg-primary/10 text-foreground"
          : "border-border bg-muted/40 text-muted-foreground hover:border-foreground/30"
      )}
    >
      {label}
    </button>
  )
}
