"use client"

/**
 * Canvas Document Rail — replaces ChannelList when the user is in the
 * Canvas guild. Shows the document list, search, language filter, and
 * a "New document" button. Style mirrors `components/desktop/channel-list.tsx`.
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { Plus, Search, FileCode, FileText, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import type { CanvasDocument } from "@/types/artifact/artifact"
import { LANGUAGE_OPTIONS } from "@/lib/canvas/constants"

export function CanvasDocumentRail() {
  const t = useTranslations("canvas")
  const documents = useArtifactStore((s) => Object.values(s.canvasDocuments) as CanvasDocument[])
  const activeId = useArtifactStore((s) => s.activeCanvasId)
  const setActive = useArtifactStore((s) => s.setActiveCanvas)
  const create = useArtifactStore((s) => s.createCanvasDocument)
  const remove = useArtifactStore((s) => s.deleteCanvasDocument)

  const [query, setQuery] = useState("")
  const [langFilter, setLangFilter] = useState<string>("all")

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return documents
      .filter((d) => (langFilter === "all" ? true : d.language === langFilter))
      .filter((d) =>
        q ? d.title.toLowerCase().includes(q) || d.content.toLowerCase().includes(q) : true
      )
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
  }, [documents, query, langFilter])

  return (
    <aside className="hidden h-full w-64 shrink-0 flex-col border-r bg-muted/30 md:flex">
      <header className="flex items-center justify-between gap-2 px-3 py-2">
        <h2 className="text-sm font-semibold">{t("title", { default: "Canvas" })}</h2>
        <Tooltip delayDuration={300}>
          <TooltipTrigger asChild>
            <Button
              size="icon"
              variant="ghost"
              className="size-7"
              onClick={() => {
                const id = create({
                  title: t("untitledDefault"),
                  content: "",
                  language: "markdown",
                  type: "text",
                })
                setActive(id)
              }}
            >
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
        <div className="flex flex-wrap gap-1">
          <FilterChip
            active={langFilter === "all"}
            label={t("languageAny", { default: "Any" })}
            onClick={() => setLangFilter("all")}
          />
          {LANGUAGE_OPTIONS.slice(0, 6).map((lang) => (
            <FilterChip
              key={lang.value}
              active={langFilter === lang.value}
              label={lang.label}
              onClick={() => setLangFilter(lang.value)}
            />
          ))}
        </div>
      </div>
      <Separator />
      <ScrollArea className="flex-1">
        {filtered.length === 0 ? (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">
            {t("noDocuments", { default: "No documents yet." })}
          </p>
        ) : (
          <ul className="flex flex-col gap-0.5 p-1">
            {filtered.map((doc) => {
              const isActive = doc.id === activeId
              const Icon = doc.type === "code" ? FileCode : FileText
              return (
                <li key={doc.id}>
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
                    <Icon className="size-3.5 shrink-0" />
                    <span className="flex-1 truncate">{doc.title || t("untitledDefault")}</span>
                    <Badge variant="outline" className="px-1 text-[10px]">
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
                </li>
              )
            })}
          </ul>
        )}
      </ScrollArea>
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
